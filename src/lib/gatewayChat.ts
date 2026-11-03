/**
 * Structured chat completions through the gateway. Each call names a Zod
 * schema: it is sent as a strict JSON schema response_format so the provider
 * constrains the reply, then the reply is validated against the same schema.
 * Shared by page extraction, Arena name matching and model suggestions, with
 * the model each job uses chosen here.
 */
import { z, type ZodType } from 'zod';
import { apiUrl, unknownErrorMessage, type LitellmConfig } from './litellm';

const CHAT_TIMEOUT_MS = 60_000;
/** Room for the largest reply we ask for (3 suggestions with reasons, or a full details extraction). */
const DEFAULT_MAX_TOKENS = 1500;

export interface ChatMessage {
	role: 'system' | 'user';
	content: string;
}

export interface ChatModel {
	model: string;
	params: Record<string, unknown>;
	/** Mark the system prompt for prompt caching (Claude models). */
	cacheSystem?: boolean;
}

/** Fast model for page extraction. Override with MODEL_EXTRACT_MODEL. */
export function extractModelName(): string {
	return process.env.MODEL_EXTRACT_MODEL || 'bedrock-claude-haiku-4-5-eu';
}

/** Careful model for the fallback and one-off jobs such as Arena name matching. */
export const STRONG_MODEL: ChatModel = { model: 'bedrock-claude-sonnet-5-5-eu', params: { reasoning_effort: 'low' }, cacheSystem: true };

/**
 * Models for ranking answers, fastest first. Gemini 3.5 Flash (UK) at minimal
 * reasoning answers in about 2s and matched Sonnet 5.5's picks in our eval;
 * Sonnet 5.5 at low effort (about 4s) is the fallback. Override the first with
 * MODEL_SEARCH_MODEL and MODEL_SEARCH_REASONING_EFFORT.
 */
export function askModelChain(): ChatModel[] {
	const primary = process.env.MODEL_SEARCH_MODEL || 'gemini-3.5-flash-uk';
	const effort = process.env.MODEL_SEARCH_REASONING_EFFORT ?? (process.env.MODEL_SEARCH_MODEL ? '' : 'minimal');
	return [
		{ model: primary, params: effort ? { reasoning_effort: effort } : {}, cacheSystem: primary.includes('claude') },
		STRONG_MODEL,
	];
}

/**
 * One gateway chat completion constrained to `schema` and validated against it.
 * Keep schemas to plain types, enums, nullables and arrays: numeric bounds and
 * array limits are not supported by every provider's strict mode, so apply
 * those when normalising the parsed value instead.
 */
export async function chatJson<T>(
	config: LitellmConfig,
	model: string,
	messages: ChatMessage[],
	schema: ZodType<T>,
	options: { name?: string; cacheSystem?: boolean; maxTokens?: number; params?: Record<string, unknown> } = {},
): Promise<{ value: T; error?: undefined } | { error: string }> {
	try {
		const response = await fetch(apiUrl(config, '/v1/chat/completions'), {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
			// drop_params: some models (e.g. Sonnet 5.5) reject temperature=0.
			body: JSON.stringify({
				model,
				messages: options.cacheSystem ? withCachedSystem(messages) : messages,
				temperature: 0,
				max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
				drop_params: true,
				response_format: responseFormat(schema, options.name ?? 'reply'),
				...options.params,
			}),
			signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		const choice = body?.choices?.[0];
		const content: unknown = choice?.message?.content;
		if (!response.ok || typeof content !== 'string') {
			return { error: `Chat completion returned ${response.status}` };
		}
		// A reply cut off by max_tokens is never valid JSON; name the cause rather than the symptom.
		if (choice?.finish_reason === 'length') {
			return { error: `Chat reply hit the ${options.maxTokens ?? DEFAULT_MAX_TOKENS} token limit` };
		}
		const parsed = schema.safeParse(JSON.parse(content));
		return parsed.success ? { value: parsed.data } : { error: `Chat reply did not match schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
	} catch (e) {
		return { error: unknownErrorMessage(e) };
	}
}

/** OpenAI-style strict JSON schema response format, which the gateway maps to each provider. */
function responseFormat(schema: ZodType, name: string): Record<string, unknown> {
	const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema);
	return { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema } };
}

/**
 * Mark system messages for prompt caching. Claude models then bill repeat
 * reads of a large, stable system prompt at a fraction of the input price.
 * Measured: no latency gain (thinking dominates), only cost.
 */
export function withCachedSystem(messages: ChatMessage[]): unknown[] {
	return messages.map((m) =>
		m.role === 'system' ? { role: 'system', content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m,
	);
}


