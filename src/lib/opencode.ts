/**
 * Builds an OpenCode config (`opencode.json`) from the live LiteLLM model list,
 * so the setup page can offer an always-current download instead of pointing
 * users at a hand-maintained file in a separate repo.
 *
 * The shape follows OpenCode v2's custom-provider format: a single `litellm`
 * provider using the openai-compatible package, pointed at the public gateway,
 * with one entry per chat model carrying the capability metadata OpenCode needs
 * to stop silently stripping images, mis-sizing context windows, and so on.
 *
 * Metadata comes solely from what LiteLLM's /v2/model/info exposes, so fields
 * it doesn't report (notably PDF input, and costs/limits for models with none
 * configured) are simply omitted rather than guessed.
 */
import type { LitellmModel } from "./litellm";

/** The public gateway endpoint users' OpenCode installs talk to - the same URL hardcoded on the Cursor and Pi setup pages. */
export const GATEWAY_BASE_URL = "https://llm-gateway.i.ai.gov.uk/v1";

interface OpencodeModel {
	name: string;
	modalities: { input: string[]; output: string[] };
	limit?: { context: number; output: number };
	cost?: { input: number; output: number };
	reasoning: boolean;
	tool_call: boolean;
	attachment: boolean;
}

export interface OpencodeConfig {
	$schema: string;
	permissions: Array<{ action: string; resource: string; effect: string }>;
	providers: {
		litellm: {
			package: string;
			name: string;
			settings: { baseURL: string };
			body: { drop_params: boolean };
			models: Record<string, OpencodeModel>;
		};
	};
}

// LiteLLM reports cost per single token; OpenCode's cost fields are per million.
const TOKENS_PER_MILLION = 1_000_000;

function toOpencodeModel(model: LitellmModel): OpencodeModel {
	const input = ["text"];
	if (model.supports_vision) input.push("image");
	if (model.supports_audio_input) input.push("audio");

	const entry: OpencodeModel = {
		name: model.name,
		modalities: { input, output: ["text"] },
		reasoning: model.supports_reasoning,
		tool_call: model.supports_function_calling,
		// A model supports attachments when it accepts a non-text file input -
		// an image or an audio file. (Transcription/voice models are already
		// excluded upstream by the chat-only filter, so audio here means a
		// chat model that accepts audio files, not a streaming voice model.)
		attachment: model.supports_vision || model.supports_audio_input,
	};

	// Only emit limits/costs when LiteLLM actually reports both halves - a
	// half-populated block is worse than none, since OpenCode would treat the
	// missing side as zero.
	if (model.max_input_tokens !== undefined && model.max_output_tokens !== undefined) {
		entry.limit = { context: model.max_input_tokens, output: model.max_output_tokens };
	}
	if (model.input_cost_per_token !== undefined && model.output_cost_per_token !== undefined) {
		entry.cost = {
			input: model.input_cost_per_token * TOKENS_PER_MILLION,
			output: model.output_cost_per_token * TOKENS_PER_MILLION,
		};
	}

	return entry;
}

/**
 * Assemble the full `opencode.json` from the model list. Only chat models are
 * included - embeddings, transcription and the like aren't selectable in
 * OpenCode - and they're keyed and ordered by alias for a stable, readable file.
 */
export function buildOpencodeConfig(models: ReadonlyArray<LitellmModel>): OpencodeConfig {
	const chatModels = models
		.filter((m) => m.mode === "chat")
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));

	const modelEntries: Record<string, OpencodeModel> = {};
	for (const model of chatModels) {
		modelEntries[model.name] = toOpencodeModel(model);
	}

	return {
		$schema: "https://opencode.ai/config.json",
		permissions: [
			{ action: "external_directory", resource: "*", effect: "ask" },
		],
		providers: {
			litellm: {
				package: "@opencode/ai/providers/openai-compatible",
				name: "i.AI Gateway",
				settings: { baseURL: GATEWAY_BASE_URL },
				body: { drop_params: true },
				models: modelEntries,
			},
		},
	};
}
