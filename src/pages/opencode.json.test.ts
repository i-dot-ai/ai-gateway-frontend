import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, init: { status?: number } = {}) {
	const status = init.status ?? 200;
	return new Response(JSON.stringify(body), { status });
}

// One /v2/model/info record, in the shape the endpoint returns. Only the fields
// the mapping reads are set; everything else defaults to absent/false.
function modelRecord(
	name: string,
	modelInfo: Record<string, unknown> = {},
) {
	return {
		model_name: name,
		litellm_params: { model: `bedrock/${name}` },
		model_info: { id: name, litellm_provider: "bedrock", mode: "chat", ...modelInfo },
	};
}

function modelsResponse(records: ReadonlyArray<unknown>) {
	return jsonResponse({ data: records, current_page: 1, total_pages: 1 });
}

describe('opencode.json', () => {
	beforeEach(() => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	it('builds a litellm provider pointed at the public gateway', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(modelsResponse([modelRecord('gpt-5-sweden')]))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);
		const config = JSON.parse(await response.text());

		expect(config.$schema).toBe('https://opencode.ai/config.json');
		expect(config.providers.litellm.package).toBe('@opencode/ai/providers/openai-compatible');
		expect(config.providers.litellm.settings.baseURL).toBe('https://llm-gateway.i.ai.gov.uk/v1');
		expect(config.providers.litellm.body).toEqual({ drop_params: true });
		expect(Object.keys(config.providers.litellm.models)).toEqual(['gpt-5-sweden']);
	});

	it('maps capability flags, modalities, limits and per-million costs', async () => {
		const record = modelRecord('vision-model', {
			supports_vision: true,
			supports_audio_input: true,
			supports_function_calling: true,
			supports_reasoning: true,
			max_input_tokens: 200000,
			max_output_tokens: 64000,
			input_cost_per_token: 0.0000011,
			output_cost_per_token: 0.0000044,
		});
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(modelsResponse([record]))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);
		const model = JSON.parse(await response.text()).providers.litellm.models['vision-model'];

		expect(model.modalities).toEqual({ input: ['text', 'image', 'audio'], output: ['text'] });
		expect(model.reasoning).toBe(true);
		expect(model.tool_call).toBe(true);
		expect(model.attachment).toBe(true);
		expect(model.limit).toEqual({ context: 200000, output: 64000 });
		// 0.0000011 and 0.0000044 per token become 1.1 and 4.4 per million.
		expect(model.cost.input).toBeCloseTo(1.1);
		expect(model.cost.output).toBeCloseTo(4.4);
	});

	it('omits limits and costs when LiteLLM reports no metadata', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(modelsResponse([modelRecord('bare-model')]))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);
		const model = JSON.parse(await response.text()).providers.litellm.models['bare-model'];

		expect(model).toEqual({
			name: 'bare-model',
			modalities: { input: ['text'], output: ['text'] },
			reasoning: false,
			tool_call: false,
			attachment: false,
		});
	});

	it('includes only chat models, sorted by alias', async () => {
		const records = [
			modelRecord('zeta-chat'),
			{ ...modelRecord('titan-embed'), model_info: { id: 'titan-embed', litellm_provider: 'bedrock', mode: 'embedding' } },
			modelRecord('alpha-chat'),
		];
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(modelsResponse(records))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);
		const config = JSON.parse(await response.text());

		expect(Object.keys(config.providers.litellm.models)).toEqual(['alpha-chat', 'zeta-chat']);
	});

	it('sends a JSON attachment named opencode.json', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(modelsResponse([]))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="opencode.json"');
	});

	it('returns a 502 with the error message when the lookup fails', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}, { status: 500 }))));
		const { GET } = await import('./opencode.json');

		const response = await GET({ url: new URL('http://localhost/opencode.json') } as any);

		expect(response.status).toBe(502);
		expect(await response.text()).toBe('LiteLLM returned 500');
	});
});
