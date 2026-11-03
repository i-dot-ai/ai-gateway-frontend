import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LitellmModel } from './litellm';
import { normaliseDetails, stripNavigation, type ModelDetails } from './modelDetails';
import { modelBase } from './modelNames';
import { arenaBase, describeRank, resetArena, arenaRankings, toArenaRow } from './arena';
import { SuggestionsSchema, askContext, catalogueLine, classifyQuery, filterFromParams, getCostTier, getModelFamily, groupByPage, matchesFilter, matchesLookup, modelFacts, normaliseQuery, parseSuggestions, resolveModelName, resolveQuery } from './modelSearch';

const ORIGINAL_ENV = { ...process.env };

function model(partial: Partial<LitellmModel>): LitellmModel {
	return {
		id: 'id-1',
		name: 'bedrock-claude-sonnet-5-eu',
		provider: 'bedrock',
		mode: 'chat',
		litellm_model: 'bedrock/eu.anthropic.claude-sonnet-5',
		supports_vision: true,
		supports_function_calling: true,
		supports_audio_input: false,
		supports_reasoning: true,
		lab: 'Anthropic',
		location: 'EU',
		description: 'Balanced Claude model',
		uri: 'https://example.com/sonnet',
		...partial,
	};
}

function arenaRank() {
	return { board: 'Text', category: 'coding', label: 'Coding questions (chat)', rank: 3, rank_ub: 1, tied: true, of: 400, arena_model: 'x', published: '2026-10-02' };
}

function details(partial: Partial<ModelDetails> = {}): ModelDetails {
	return { ...normaliseDetails({ page_matches_model: true, summary: '', best_for: [], context_window: null, knowledge_cutoff: null, benchmarks: [] }, 'https://example.com/sonnet', 'hash'), ...partial };
}

describe('normaliseQuery', () => {
	it('trims, collapses whitespace and caps length', () => {
		expect(normaliseQuery('  best   model\tfor coding ')).toBe('best model for coding');
		expect(normaliseQuery('x'.repeat(500))).toHaveLength(200);
		expect(normaliseQuery(null)).toBe('');
	});
});

describe('classifyQuery and matchesLookup', () => {
	const models = [
		model({ name: 'bedrock-claude-opus-4-6-eu', lab: 'Anthropic', provider: 'bedrock', location: 'EU' }),
		model({ name: 'gemini-3.5-flash-uk', lab: 'Google', provider: 'vertex_ai', location: 'UK' }),
	];

	it('treats names, labs and locations as lookups', () => {
		expect(classifyQuery('opus 4.6', models)).toBe('lookup');
		expect(classifyQuery('gemini uk', models)).toBe('lookup');
		expect(classifyQuery('anthropic', models)).toBe('lookup');
		expect(classifyQuery('claude opus 4', models)).toBe('lookup');
	});

	it('treats anything else, and question forms, as questions', () => {
		expect(classifyQuery('coding', models)).toBe('question');
		expect(classifyQuery('long documents', models)).toBe('question');
		expect(classifyQuery('best claude', models)).toBe('question');
		expect(classifyQuery('opus?', models)).toBe('question');
	});

	it('filters on identity words only', () => {
		expect(matchesLookup(models[0], 'opus 4.6')).toBe(true);
		expect(matchesLookup(models[0], 'claude eu')).toBe(true);
		expect(matchesLookup(models[1], 'claude eu')).toBe(false);
		expect(matchesLookup(models[0], 'balanced')).toBe(false);
	});
});

describe('catalogueLine', () => {
	it('prefers config context and falls back to extracted details', () => {
		expect(catalogueLine([model({ max_input_tokens: 1000 })], details({ context_window: 5 }))).toContain('context=1000');
		expect(catalogueLine([model({})], details({ context_window: 5 }))).toContain('context=5');
	});

	it('includes cost per million and benchmarks', () => {
		const line = catalogueLine(
			[model({ input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 })],
			details({ benchmarks: [{ name: 'SWE-bench', score: '70%' }] }),
		);
		expect(line).toContain('cost_per_M_tokens_in/out=3.00 USD/15.00 USD');
		expect(line).toContain('benchmarks=SWE-bench 70%');
	});
});

describe('groupByPage', () => {
	it('puts region variants sharing a uri on one line', () => {
		const groups = groupByPage([
			model({ name: 'a-eu', location: 'EU', uri: 'https://x/a' }),
			model({ name: 'b', uri: undefined }),
			model({ name: 'a-uk', location: 'UK', uri: 'https://x/a' }),
		]);
		expect(groups.map((g) => g.map((m) => m.name))).toEqual([['a-eu', 'a-uk'], ['b']]);
		expect(catalogueLine(groups[0], undefined)).toMatch(/^names=a-eu@EU, a-uk@UK \|/);
	});
});

describe('resolveModelName', () => {
	const models = [
		model({ name: 'gpt-5-us-east', location: 'US' }),
		model({ name: 'gpt-5-sweden', location: 'EU' }),
		model({ name: 'gpt-5-mini-uk', location: 'UK' }),
	];

	it('prefers an exact name, then the UK or EU variant of a base name', () => {
		expect(resolveModelName('gpt-5-us-east', models)?.name).toBe('gpt-5-us-east');
		expect(resolveModelName('gpt-5', models)?.name).toBe('gpt-5-sweden');
		expect(resolveModelName('gpt-5-mini@UK', models)?.name).toBe('gpt-5-mini-uk');
		expect(resolveModelName('gpt-6', models)).toBeUndefined();
	});
});

describe('parseSuggestions', () => {
	const models = [model({ id: 'a', name: 'one', uri: 'https://x/one' }), model({ id: 'b', name: 'two', uri: 'https://x/two' })];

	it('keeps only real, unique models, capped at 3', () => {
		const raw = {
			suggestions: [
				{ name: 'one', reason: 'r1', evidence: [] },
				{ name: 'made-up', reason: 'x', evidence: [] },
				{ name: 'one', reason: 'dup', evidence: [] },
				{ name: ' two@EU ', reason: 'r2', evidence: [] },
			],
		};
		expect(parseSuggestions(raw, models).map(({ id, name, reason }) => ({ id, name, reason }))).toEqual([
			{ id: 'a', name: 'one', reason: 'r1' },
			{ id: 'b', name: 'two', reason: 'r2' },
		]);
	});

	it('attaches the source page of included details', () => {
		const d = details({ fetched_at: '2026-10-07T08:00:00.000Z' });
		const [s] = parseSuggestions({ suggestions: [{ name: 'one', reason: 'r', evidence: [] }] }, models, () => d);
		expect(s).toMatchObject({ source_url: 'https://example.com/sonnet', source_checked_at: '2026-10-07T08:00:00.000Z' });
	});

	it('attaches cited Arena evidence from our data, ignoring unknown labels', () => {
		const [s] = parseSuggestions(
			{ suggestions: [{ name: 'one', reason: 'r', evidence: ['coding questions (chat): tied #1 of 400', 'Made-up board'] }] },
			models,
			() => undefined,
			() => [arenaRank()],
		);
		expect(s.arena_evidence).toEqual([
			{ label: 'Coding questions (chat)', text: 'tied #1 of 400 (3rd by score)' },
		]);
	});

	it('rejects a malformed reply at the schema, before parsing', () => {
		expect(SuggestionsSchema.safeParse({ suggestions: 'nope' }).success).toBe(false);
		expect(SuggestionsSchema.safeParse({ suggestions: [{ name: 'one' }] }).success).toBe(false);
		expect(SuggestionsSchema.safeParse({ suggestions: [] }).success).toBe(true);
	});
});

describe('chatJson', () => {
	beforeEach(() => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	it('reports a reply cut off by max_tokens by its cause, and passes the limit through', async () => {
		let sentMaxTokens: number | undefined;
		vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
			sentMaxTokens = JSON.parse(String(init?.body)).max_tokens;
			return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"suggestions": [{"na' } }] }));
		}));
		const { chatJson } = await import('./gatewayChat');
		const { getLitellmConfig } = await import('./litellm');
		const r = await chatJson(getLitellmConfig().config!, 'm', [{ role: 'user', content: 'q' }], SuggestionsSchema, { maxTokens: 40 });
		expect(sentMaxTokens).toBe(40);
		expect(r.error).toBe('Chat reply hit the 40 token limit');
	});
});


describe('askContext', () => {
	it('counts distinct pages, the newest extraction and Arena coverage', () => {
		const models = [
			model({ name: 'a-eu', uri: 'https://x/a' }),
			model({ name: 'a-uk', uri: 'https://x/a' }),
			model({ name: 'b', uri: 'https://x/b' }),
			model({ name: 'c', uri: 'https://x/c' }),
			model({ name: 'd', uri: undefined }),
		];
		const at: Record<string, string> = { 'https://x/a': '2026-10-07T09:00:00.000Z', 'https://x/b': '2026-10-06T09:00:00.000Z' };
		const ctx = askContext(
			models,
			(m) => (at[m.uri!] ? details({ fetched_at: at[m.uri!] }) : undefined),
			(m) => m.uri === 'https://x/b',
			'2026-10-02',
		);
		expect(ctx).toMatchObject({
			pages_total: 3,
			pages_included: 2,
			details_updated_at: '2026-10-07T09:00:00.000Z',
			arena_pages: 1,
			arena_published: '2026-10-02',
			arena_licence: 'CC-BY-4.0',
		});
	});
});

describe('stripNavigation', () => {
	it('trims, drops empty or non-positive values and caps lists', () => {
		const d = normaliseDetails(
			{
				summary: ' A model. ',
				best_for: ['a', '', 'b', 'c', 'd', 'e', 'f'],
				context_window: 0,
				knowledge_cutoff: null,
				benchmarks: [{ name: 'MMLU', score: '88.1' }, { name: 'X', score: ' ' }],
				page_matches_model: false,
			},
			'https://example.com',
			'abc123',
		);
		expect(d.content_hash).toBe('abc123');
		expect(d.summary).toBe('A model.');
		expect(d.best_for).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(d.context_window).toBeUndefined();
		expect(d.knowledge_cutoff).toBeUndefined();
		expect(d.benchmarks).toEqual([{ name: 'MMLU', score: '88.1' }]);
		expect(d.page_matches_model).toBe(false);
	});
});

describe('model details cache', () => {
	beforeEach(() => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
		vi.resetModules();
	});

	// The store lives on globalThis, so it outlives vi.resetModules.
	beforeEach(async () => {
		(await import('./modelDetails')).resetModelDetailsCache();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	function stubGateway(chatContent: string) {
		const fetchMock = vi.fn(async (url: URL) => {
			const body = String(url).endsWith('/tavily/extract')
				? { results: [{ raw_content: 'page text' }] }
				: { choices: [{ message: { content: chatContent } }] };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	function extraction(partial: Record<string, unknown> = {}): string {
		return JSON.stringify({ page_matches_model: true, summary: 'ok', best_for: [], context_window: null, knowledge_cutoff: null, benchmarks: [], ...partial });
	}

	it('fetches a shared uri once, constrained to the details schema, and skips fresh entries', async () => {
		const fetchMock = stubGateway(extraction({ summary: 'Great at code', best_for: ['coding'] }));
		const { refreshStaleModelDetails, usableModelDetails } = await import('./modelDetails');
		const a = model({ name: 'sonnet-eu' });
		const b = model({ name: 'sonnet-uk' });

		expect(usableModelDetails(a)).toBeUndefined();
		const stats = await refreshStaleModelDetails([a, b]);
		expect(stats).toEqual({ extracted: 1, unchanged: 0, failed: 0 });
		expect(usableModelDetails(a)?.summary).toBe('Great at code');
		expect(usableModelDetails(b)?.best_for).toEqual(['coding']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({ urls: ['https://example.com/sonnet'] });
		const [, chatInit] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
		expect(JSON.parse(String(chatInit.body)).response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'model_details', strict: true } });

		await refreshStaleModelDetails([a]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('runs pages a few at a time and counts usable pages', async () => {
		stubGateway(extraction());
		const { refreshStaleModelDetails, allModelDetails } = await import('./modelDetails');
		const usablePageCount = () => Object.values(allModelDetails()).filter((d) => d.page_matches_model).length;
		const models = Array.from({ length: 6 }, (_, i) => model({ uri: `https://x/${i}` }));
		expect(usablePageCount()).toBe(0);
		await refreshStaleModelDetails(models);
		expect(usablePageCount()).toBe(6);
	});

	it('skips the LLM when the page is unchanged, and re-extracts when it changes', async () => {
		let pageText = 'page v1';
		let chatCalls = 0;
		vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
			if (String(url).endsWith('/tavily/extract')) return new Response(JSON.stringify({ results: [{ raw_content: pageText }] }));
			chatCalls++;
			const content = JSON.stringify({ page_matches_model: true, summary: `call ${chatCalls}`, best_for: [], context_window: null, knowledge_cutoff: null, benchmarks: [] });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
		}));
		const { extractModelDetails } = await import('./modelDetails');
		const m = model({});

		const first = await extractModelDetails(m);
		expect(first.details?.content_hash).toMatch(/^[0-9a-f]{64}$/);

		const same = await extractModelDetails(m, first.details);
		expect(same.unchanged).toBe(true);
		expect(same.details?.summary).toBe('call 1');
		expect(chatCalls).toBe(1);

		pageText = 'page v2';
		const changed = await extractModelDetails(m, first.details);
		expect(changed.unchanged).toBeUndefined();
		expect(changed.details?.summary).toBe('call 2');
	});

	it('keeps the last good details when a refresh fails', async () => {
		stubGateway(extraction({ summary: 'good' }));
		const { refreshStaleModelDetails, usableModelDetails } = await import('./modelDetails');
		const m = model({});
		await refreshStaleModelDetails([m]);

		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
		const stats = await refreshStaleModelDetails([m]);
		vi.restoreAllMocks();

		expect(stats.failed).toBe(1);
		expect(usableModelDetails(m)?.summary).toBe('good');
	});

	it('records a failed extraction and backs off', async () => {
		const fetchMock = stubGateway('{"summary": "missing the other fields"}');
		const { refreshStaleModelDetails, usableModelDetails } = await import('./modelDetails');
		const a = model({});

		await refreshStaleModelDetails([a]);
		expect(usableModelDetails(a)).toBeUndefined();
		await refreshStaleModelDetails([a]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('skips models without a uri and embeddings', async () => {
		const fetchMock = stubGateway(extraction());
		const { refreshStaleModelDetails } = await import('./modelDetails');
		await refreshStaleModelDetails([model({ uri: undefined }), model({ mode: 'embedding' })]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});


describe('arena', () => {
	function row(model_name: string, category: string, rank: number) {
		return toArenaRow({ model_name, category, rank, rating: 1500 - rank, rating_lower: 1490 - rank, rating_upper: 1510 - rank, vote_count: 1000, leaderboard_publish_date: '2026-10-02' })!;
	}

	it('strips effort, thinking budget and date suffixes from Arena names', () => {
		expect(arenaBase('claude-opus-5.5-high')).toBe('claude-opus-5-5');
		expect(arenaBase('claude-sonnet-4-5-20250929-high-32k')).toBe('claude-sonnet-4-5');
		expect(arenaBase('gpt-4o-2024-05-13')).toBe('gpt-4o');
		expect(arenaBase('gemini-3-flash (thinking-minimal)')).toBe('gemini-3-flash');
		expect(arenaBase('Claude Fable 5.1 (Max)')).toBe('claude-fable-5-1');
		expect(arenaBase('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
	});

	it('strips gateway prefixes and region suffixes from our aliases', () => {
		expect(modelBase('bedrock-claude-opus-5-5-eu')).toBe('claude-opus-5-5');
		expect(modelBase('gpt-5.4-sweden')).toBe('gpt-5-4');
		expect(modelBase('gpt-5.2-uk+sweden')).toBe('gpt-5-2');
		expect(modelBase('gpt-4.1-sweden-2025-03')).toBe('gpt-4-1');
		expect(modelBase('gemini-2.5-flash-lite-global-extract')).toBe('gemini-2-5-flash-lite');
		expect(modelBase('doubleword-glm-5.3-uk')).toBe('glm-5-3');
	});

	it('returns the best-ranked variant per category, and nothing for a different model', () => {
		resetArena({
			text_style_control: [
				row('gpt-5.4', 'overall', 53),
				row('gpt-5.4-high', 'overall', 34),
				row('gpt-5.4-mini-high', 'overall', 84),
				row('gpt-5.4-high', 'coding', 35),
			],
		});
		const ranks = arenaRankings(model({ name: 'gpt-5.4-sweden' }));
		expect(ranks.map((r) => [r.label, r.rank, r.of, r.arena_model])).toEqual([
			['Text overall', 34, 3, 'gpt-5.4-high'],
			['Coding questions (chat)', 35, 1, 'gpt-5.4-high'],
		]);
		expect(arenaRankings(model({ name: 'gpt-5-sweden' }))).toEqual([]);
		resetArena();
	});

	it('reads agent rows, which use score and session count', () => {
		const r = toArenaRow({ model_name: 'Claude Fable 5.1 (Max)', category: 'overall', rank: 1, score: 0.14, score_ci_lower: 0.12, score_ci_upper: 0.16, session_count: 15130, leaderboard_publish_date: '2026-10-02' });
		expect(r).toMatchObject({ score: 0.14, score_lower: 0.12, votes: 15130 });
	});
});

describe('matchUnmatchedWithLlm', () => {
	beforeEach(() => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
		resetArena();
	});

	it('sends underlying ids, keeps only known names, and skips when inputs are unchanged', async () => {
		const row = (name: string) => toArenaRow({ model_name: name, category: 'overall', rank: 1, rating: 1, rating_lower: 1, rating_upper: 1, vote_count: 1, leaderboard_publish_date: 'd' })!;
		resetArena({ text_style_control: [row('claude-3-7-sonnet-20250219'), row('ministral-8b-2410')] });
		const bodies: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
			bodies.push(String(init?.body));
			const content = '{"matches": [{"ours": "claude-sonnet-3-7", "arena": "claude-3-7-sonnet"}, {"ours": "ministral-8b", "arena": "made-up"}]}';
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
		}));
		const { matchUnmatchedWithLlm } = await import('./arena');
		const models = [
			model({ name: 'bedrock-claude-sonnet-3-7-us', litellm_model: 'bedrock/claude-3-7-sonnet' }),
			model({ name: 'bedrock-ministral-8b-uk', litellm_model: 'bedrock/mistral.ministral-3-8b-instruct' }),
		];

		await matchUnmatchedWithLlm(models);
		expect(bodies[0]).toContain('ministral-8b (runs bedrock/mistral.ministral-3-8b-instruct)');
		expect(arenaRankings(models[0]).map((r) => r.arena_model)).toEqual(['claude-3-7-sonnet-20250219']);
		expect(arenaRankings(models[1])).toEqual([]);

		await matchUnmatchedWithLlm(models);
		expect(bodies).toHaveLength(1);
	});
});

describe('tie-aware ranks', () => {
	const row = (model_name: string, rank: number, lower: number, upper: number) =>
		toArenaRow({ model_name, category: 'overall', rank, rating: (lower + upper) / 2, rating_lower: lower, rating_upper: upper, vote_count: 1, leaderboard_publish_date: 'd' })!;

	afterEach(() => resetArena());

	it('ties models whose intervals overlap, and separates clear winners', () => {
		resetArena({
			webdev: [row('a-model', 1, 1800, 1830), row('b-model', 2, 1700, 1720), row('c-model', 3, 1690, 1725), row('d-model', 4, 1600, 1610)],
		});
		const at = (name: string) => arenaRankings(model({ name: `${name}-uk` }))[0];
		expect(at('a-model')).toMatchObject({ rank: 1, rank_ub: 1, tied: false });
		expect(at('b-model')).toMatchObject({ rank: 2, rank_ub: 2, tied: true });
		expect(at('c-model')).toMatchObject({ rank: 3, rank_ub: 2, tied: true });
		expect(at('d-model')).toMatchObject({ rank: 4, rank_ub: 4, tied: false });
	});

	it('describes ranks plainly', () => {
		expect(describeRank({ rank: 1, rank_ub: 1, tied: false, of: 138 })).toBe('#1 of 138');
		expect(describeRank({ rank: 12, rank_ub: 1, tied: true, of: 408 })).toBe('tied #1 of 408 (12th by score)');
		expect(describeRank({ rank: 3, rank_ub: 2, tied: true, of: 4 })).toBe('tied #2 of 4 (3rd by score)');
	});

});

describe('ask model fallback', () => {
	beforeEach(async () => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
		vi.resetModules();
		(await import('./modelDetails')).resetModelDetailsCache();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	function stub(replies: Record<string, { status?: number; content?: string }>) {
		const calls: Array<{ model: string; reasoning_effort?: string }> = [];
		vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
			if (new URL(String(url)).pathname === '/v2/model/info') {
				const row = { model_name: 'sonnet-eu', litellm_params: { model: 'bedrock/sonnet' }, model_info: { id: 'm1', mode: 'chat', location: 'EU' } };
				return new Response(JSON.stringify({ data: [row], current_page: 1, total_pages: 1 }));
			}
			const body = JSON.parse(String(init?.body));
			calls.push({ model: body.model, reasoning_effort: body.reasoning_effort });
			const r = replies[body.model] ?? { status: 500 };
			return new Response(JSON.stringify(r.content ? { choices: [{ message: { content: r.content } }] } : {}), { status: r.status ?? 200 });
		}));
		return calls;
	}

	it('uses the fast model at minimal effort when it answers', async () => {
		const calls = stub({ 'gemini-3.5-flash-uk': { content: '{"suggestions": [{"name": "sonnet-eu", "reason": "r", "evidence": []}]}' } });
		const { askModels } = await import('./modelSearch');
		const r = await askModels('fast question one');
		expect(r.suggestions.map((s) => s.name)).toEqual(['sonnet-eu']);
		expect(calls).toEqual([{ model: 'gemini-3.5-flash-uk', reasoning_effort: 'minimal' }]);
	});

	it('falls back to Sonnet when the fast model fails or names no real model', async () => {
		const calls = stub({
			'gemini-3.5-flash-uk': { content: '{"suggestions": [{"name": "made-up", "reason": "r", "evidence": []}]}' },
			'bedrock-claude-sonnet-5-5-eu': { content: '{"suggestions": [{"name": "sonnet-eu", "reason": "r", "evidence": []}]}' },
		});
		const { askModels } = await import('./modelSearch');
		const r = await askModels('fallback question two');
		expect(r.suggestions.map((s) => s.name)).toEqual(['sonnet-eu']);
		expect(calls.map((c) => c.model)).toEqual(['gemini-3.5-flash-uk', 'bedrock-claude-sonnet-5-5-eu']);
	});

	it('reports an error when every model fails', async () => {
		stub({});
		const { askModels } = await import('./modelSearch');
		const r = await askModels('failing question three');
		expect(r.error).toBeDefined();
		expect(r.suggestions).toEqual([]);
	});
});

describe('modelFacts', () => {
	it('takes hosting, maker, cost and context from config, and lists other regions', () => {
		const eu = model({ id: 'eu', name: 'x-eu', location: 'EU', lab: 'Anthropic', country_of_origin: 'US', open_weight: false, input_cost_per_token: 0.0000044, output_cost_per_token: 0.000022, max_input_tokens: 1_000_000, uri: 'https://x/p' });
		const uk = model({ id: 'uk', name: 'x-uk', location: 'UK', uri: 'https://x/p' });
		const other = model({ id: 'o', name: 'other', uri: 'https://x/q' });
		expect(modelFacts(eu, [eu, uk, other])).toEqual({
			location: 'EU',
			lab: 'Anthropic',
			country_of_origin: 'US',
			open_weight: false,
			input_cost_per_token: 0.0000044,
			output_cost_per_token: 0.000022,
			context_tokens: 1_000_000,
			other_regions: [{ id: 'uk', name: 'x-uk', location: 'UK' }],
		});
	});

	it('leaves unknown costs undefined rather than zero', () => {
		const m = model({ input_cost_per_token: undefined, output_cost_per_token: undefined });
		expect(modelFacts(m, [m])).toMatchObject({ input_cost_per_token: undefined, output_cost_per_token: undefined });
	});
});

describe('getCostTier', () => {
	it('returns low for combined cost under $1 per million tokens', () => {
		// $0.50 input + $0.40 output = $0.90 per million
		expect(getCostTier(model({ input_cost_per_token: 0.0000005, output_cost_per_token: 0.0000004 }))).toBe('low');
	});

	it('returns medium for combined cost between $1 and $10 per million tokens', () => {
		// $1 exactly = boundary, should be medium
		expect(getCostTier(model({ input_cost_per_token: 0.0000005, output_cost_per_token: 0.0000005 }))).toBe('medium');
		// $5 input + $5 output = $10 per million (boundary)
		expect(getCostTier(model({ input_cost_per_token: 0.000005, output_cost_per_token: 0.000005 }))).toBe('medium');
	});

	it('returns high for combined cost over $10 per million tokens', () => {
		// $6 input + $6 output = $12 per million
		expect(getCostTier(model({ input_cost_per_token: 0.000006, output_cost_per_token: 0.000006 }))).toBe('high');
	});

	it('returns undefined when costs are missing', () => {
		expect(getCostTier(model({ input_cost_per_token: undefined, output_cost_per_token: 0.000001 }))).toBeUndefined();
		expect(getCostTier(model({ input_cost_per_token: 0.000001, output_cost_per_token: undefined }))).toBeUndefined();
		expect(getCostTier(model({ input_cost_per_token: undefined, output_cost_per_token: undefined }))).toBeUndefined();
	});
});

describe('getModelFamily', () => {
	it('identifies Claude models', () => {
		expect(getModelFamily(model({ name: 'bedrock-claude-opus-5-eu' }))).toBe('claude');
		expect(getModelFamily(model({ name: 'claude-sonnet-4-uk' }))).toBe('claude');
	});

	it('identifies GPT models', () => {
		expect(getModelFamily(model({ name: 'gpt-5-sweden' }))).toBe('gpt');
		expect(getModelFamily(model({ name: 'gpt-4o-uk' }))).toBe('gpt');
	});

	it('identifies Gemini models', () => {
		expect(getModelFamily(model({ name: 'gemini-3.5-flash-uk' }))).toBe('gemini');
	});

	it('identifies other families', () => {
		expect(getModelFamily(model({ name: 'llama-3-70b-uk' }))).toBe('llama');
		expect(getModelFamily(model({ name: 'mistral-large-eu' }))).toBe('mistral');
		expect(getModelFamily(model({ name: 'nova-pro-uk' }))).toBe('nova');
		expect(getModelFamily(model({ name: 'titan-text-uk' }))).toBe('titan');
	});

	it('returns undefined for unknown families', () => {
		expect(getModelFamily(model({ name: 'some-unknown-model' }))).toBeUndefined();
	});
});

describe('filterFromParams validation', () => {
	it('rejects invalid cost values', () => {
		expect(filterFromParams(new URLSearchParams('cost=banana')).cost).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('cost=LOW')).cost).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('cost=low')).cost).toBe('low');
		expect(filterFromParams(new URLSearchParams('cost=medium')).cost).toBe('medium');
		expect(filterFromParams(new URLSearchParams('cost=high')).cost).toBe('high');
	});

	it('rejects invalid family values', () => {
		expect(filterFromParams(new URLSearchParams('family=banana')).family).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('family=CLAUDE')).family).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('family=claude')).family).toBe('claude');
		expect(filterFromParams(new URLSearchParams('family=gpt')).family).toBe('gpt');
	});

	it('rejects invalid usecase values', () => {
		expect(filterFromParams(new URLSearchParams('usecase=banana')).usecase).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('usecase=CODING')).usecase).toBeUndefined();
		expect(filterFromParams(new URLSearchParams('usecase=coding')).usecase).toBe('coding');
		expect(filterFromParams(new URLSearchParams('usecase=long-documents')).usecase).toBe('long-documents');
	});
});

describe('code review fixes', () => {
	it('strips control characters from queries', () => {
		expect(normaliseQuery('foo\u0000best\u0007 model')).toBe('foo best model');
	});

	it('reads and applies the /models filters', () => {
		const f = filterFromParams(new URLSearchParams('provider=azure&location=UK&vision=true'));
		expect(f).toEqual({ provider: 'azure', location: 'UK', vision: true, reasoning: undefined });
		expect(matchesFilter(model({ provider: 'azure', location: 'UK', supports_vision: true }), f)).toBe(true);
		expect(matchesFilter(model({ provider: 'azure', location: 'EU', supports_vision: true }), f)).toBe(false);
		expect(matchesFilter(model({ provider: 'azure', location: 'UK', supports_vision: false }), f)).toBe(false);
		expect(matchesFilter(model({}), {})).toBe(true);
	});

	it('gives one card per model when the reply names two region variants', () => {
		const models = [
			model({ id: 'uk', name: 'gpt-5-uk', uri: 'https://x/gpt-5', location: 'UK' }),
			model({ id: 'se', name: 'gpt-5-sweden', uri: 'https://x/gpt-5', location: 'EU' }),
			model({ id: 'o', name: 'other', uri: 'https://x/other' }),
		];
		const raw = { suggestions: [{ name: 'gpt-5-uk', reason: 'a', evidence: [] }, { name: 'gpt-5-sweden', reason: 'b', evidence: [] }, { name: 'other', reason: 'c', evidence: [] }] };
		expect(parseSuggestions(raw, models).map((s) => s.name)).toEqual(['gpt-5-uk', 'other']);
	});

	it('resolves a reply that drops the gateway prefix', () => {
		const models = [model({ name: 'bedrock-claude-opus-5-5-eu', location: 'EU' })];
		expect(resolveModelName('claude-opus-5-5', models)?.name).toBe('bedrock-claude-opus-5-5-eu');
	});

	it('leaves embedding pages out of the page counts', () => {
		const ctx = askContext(
			[model({ uri: 'https://x/chat' }), model({ name: 'embed', mode: 'embedding', uri: 'https://x/embed' })],
			() => undefined,
			() => false,
			undefined,
		);
		expect(ctx.pages_total).toBe(1);
	});

	it('normalises Arena publish dates decoded as Date objects', () => {
		const r = toArenaRow({ model_name: 'm', category: 'overall', rank: 1, rating: 1, rating_lower: 1, rating_upper: 1, vote_count: 1, leaderboard_publish_date: new Date('2026-10-02T00:00:00Z') });
		expect(r?.published).toBe('2026-10-02');
	});
});

describe('resolveQuery', () => {
	it('combines use case query with typed search', () => {
		expect(resolveQuery(new URLSearchParams('usecase=coding&q=claude'))).toBe('Best model for coding claude');
	});

	it('returns use case query when no typed search', () => {
		expect(resolveQuery(new URLSearchParams('usecase=coding'))).toBe('Best model for coding');
	});

	it('returns typed search when no use case', () => {
		expect(resolveQuery(new URLSearchParams('q=claude'))).toBe('claude');
	});

	it('ignores invalid use case and returns typed search', () => {
		expect(resolveQuery(new URLSearchParams('usecase=invalid&q=claude'))).toBe('claude');
	});

	it('returns empty string when neither provided', () => {
		expect(resolveQuery(new URLSearchParams(''))).toBe('');
	});
});

describe('askModels with filters', () => {
	beforeEach(async () => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
		vi.resetModules();
		(await import('./modelDetails')).resetModelDetailsCache();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	it('only offers the filtered models to the LLM, and caches per filter', async () => {
		const prompts: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
			if (new URL(String(url)).pathname === '/v2/model/info') {
				const row = (name: string, location: string) => ({ model_name: name, litellm_params: { model: `x/${name}` }, model_info: { id: name, mode: 'chat', location } });
				return new Response(JSON.stringify({ data: [row('uk-model', 'UK'), row('eu-model', 'EU')], current_page: 1, total_pages: 1 }));
			}
			prompts.push(JSON.parse(String(init?.body)).messages[0].content);
			return new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions": [{"name": "uk-model", "reason": "r", "evidence": []}, {"name": "eu-model", "reason": "r", "evidence": []}]}' } }] }));
		}));
		const { askModels } = await import('./modelSearch');

		const uk = await askModels('filtered question', { location: 'UK' });
		expect(uk.suggestions.map((s) => s.name)).toEqual(['uk-model']);
		expect(prompts[0]).toContain('uk-model');
		expect(prompts[0]).not.toContain('eu-model');

		await askModels('filtered question', { location: 'UK' });
		expect(prompts).toHaveLength(1);
		await askModels('filtered question');
		expect(prompts).toHaveLength(2);
	});
});
