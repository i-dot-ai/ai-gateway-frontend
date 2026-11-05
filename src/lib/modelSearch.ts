/**
 * Model search: instant name lookups, plus "ask" suggestions where a gateway
 * chat model ranks the whole catalogue (config, extracted provider-page
 * details and Arena rankings) against a free-text question.
 */
import { ARENA_DATASET_URL, arenaPublished, arenaRankings, describeRank, hasArenaRankings, type ArenaRanking } from './arena';
import { z } from 'zod';
import { askModelChain, chatJson } from './gatewayChat';
import { cachedKeyedFetcher, getAllModels, getLitellmConfig, logger, type LitellmModel } from './litellm';
import { isExtractable, usableModelDetails, type ModelDetails } from './modelDetails';
import { modelBase, withoutHosting } from './modelNames';
import { isPassThrough, isPassThroughTool, withPassThrough } from './passThroughModels';

export const MAX_QUERY_LENGTH = 200;

/** Predefined use case queries that trigger AI suggestions */
export const USE_CASES = [
	{ id: 'coding', label: 'Coding', query: 'Best model for coding' },
	{ id: 'long-documents', label: 'Long documents', query: 'Best model for long documents' },
	{ id: 'simple-tasks', label: 'Simple tasks', query: 'Cheapest model for simple tasks' },
	{ id: 'uk-documents', label: 'UK-hosted for documents', query: 'Best UK-hosted model for drafting documents' },
] as const;

export type UseCase = typeof USE_CASES[number]['id'];

export function normaliseQuery(q: string | null | undefined): string {
	// eslint-disable-next-line no-control-regex
	return (q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

/** The /models page filters. Suggestions are limited to models that pass them. */
export interface ModelFilter {
	provider?: string;
	location?: string;
	vision?: boolean;
	reasoning?: boolean;
	cost?: 'low' | 'medium' | 'high';
	family?: string;
	usecase?: UseCase;
	/** Gateway models only, or pass-through services only. */
	type?: ListingType;
}

export const LISTING_TYPES = [
	{ id: 'model', label: 'Models' },
	{ id: 'pass-through', label: 'Pass-through services' },
] as const;
export type ListingType = typeof LISTING_TYPES[number]['id'];

/** Cost tiers based on combined input+output cost per million tokens. */
export type CostTier = 'low' | 'medium' | 'high';

/** Known model families, matched against the base model name */
export const MODEL_FAMILIES = [
	{ id: 'claude', label: 'Claude', pattern: /claude/i },
	{ id: 'gpt', label: 'GPT', pattern: /gpt/i },
	{ id: 'gemini', label: 'Gemini', pattern: /gemini/i },
	{ id: 'llama', label: 'Llama', pattern: /llama/i },
	{ id: 'mistral', label: 'Mistral', pattern: /mistral/i },
	{ id: 'nova', label: 'Nova', pattern: /nova/i },
	{ id: 'titan', label: 'Titan', pattern: /titan/i },
] as const;

export type ModelFamily = typeof MODEL_FAMILIES[number]['id'];

/**
 * Extract the model family from a model's name.
 * Returns undefined if no known family matches.
 */
export function getModelFamily(model: LitellmModel): ModelFamily | undefined {
	const base = modelBase(model.name);
	for (const { id, pattern } of MODEL_FAMILIES) {
		if (pattern.test(base)) return id;
	}
	return undefined;
}

/**
 * Calculate the cost tier for a model based on its token costs.
 * Uses combined input + output cost per million tokens.
 * Thresholds: low < $1, medium $1-$10, high > $10
 */
export function getCostTier(model: LitellmModel): CostTier | undefined {
	const inputCost = model.input_cost_per_token;
	const outputCost = model.output_cost_per_token;
	if (inputCost === undefined || outputCost === undefined) return undefined;

	// Combined cost per million tokens (input + output, assuming equal usage)
	const costPerMillion = (inputCost + outputCost) * 1_000_000;

	if (costPerMillion < 1) return 'low';
	if (costPerMillion <= 10) return 'medium';
	return 'high';
}

/** Human-readable labels for cost tiers */
export const COST_TIER_LABELS: Record<CostTier, string> = {
	low: '£ Low',
	medium: '££ Medium',
	high: '£££ High',
};

/**
 * Resolve the effective query from URL params.
 * Combines use case query with any typed search (e.g. "Best model for coding claude").
 * Used by both the models page and suggestions endpoint to ensure they agree.
 */
export function resolveQuery(params: URLSearchParams): string {
	const rawQuery = normaliseQuery(params.get('q'));
	const filter = filterFromParams(params);
	const useCaseQuery = filter.usecase
		? USE_CASES.find((u) => u.id === filter.usecase)?.query
		: undefined;
	if (useCaseQuery && rawQuery) return `${useCaseQuery} ${rawQuery}`;
	return useCaseQuery || rawQuery;
}

export function filterFromParams(params: URLSearchParams): ModelFilter {
	const costParam = params.get('cost');
	const cost = (costParam === 'low' || costParam === 'medium' || costParam === 'high') ? costParam : undefined;
	const familyParam = params.get('family');
	const family = MODEL_FAMILIES.some(f => f.id === familyParam) ? familyParam as ModelFamily : undefined;
	const usecaseParam = params.get('usecase');
	const usecase = USE_CASES.find(u => u.id === usecaseParam)?.id;
	const type = LISTING_TYPES.find(t => t.id === params.get('type'))?.id;
	return {
		provider: params.get('provider') || undefined,
		location: params.get('location') || undefined,
		vision: params.has('vision') || undefined,
		reasoning: params.has('reasoning') || undefined,
		cost,
		family,
		usecase,
		type,
	};
}

export function matchesFilter(model: LitellmModel, f: ModelFilter): boolean {
	return (
		(f.provider === undefined || model.provider === f.provider) &&
		(f.location === undefined || model.location === f.location) &&
		(!f.vision || model.supports_vision) &&
		(!f.reasoning || model.supports_reasoning) &&
		(f.cost === undefined || getCostTier(model) === f.cost) &&
		(f.family === undefined || getModelFamily(model) === f.family) &&
		(f.type === undefined || (f.type === 'pass-through') === isPassThrough(model))
	);
}

/** Stable text for a filter, for cache keys, the prompt and logs; empty when unfiltered. */
export function describeFilter(f: ModelFilter): string {
	return [
		f.provider && `provider ${f.provider}`,
		f.location && `hosted in ${f.location}`,
		f.vision && 'vision',
		f.reasoning && 'reasoning',
		f.cost && `${f.cost} cost`,
		f.family && `${f.family} family`,
		f.usecase && `usecase ${f.usecase}`,
		f.type && `type ${f.type}`,
	]
		.filter(Boolean)
		.join(', ');
}

const QUESTION_START = /^(which|what|who|how|best|good|cheapest|fastest|recommend|should|can|is|are|i need|i want)\b/i;

// Words of a model's identity: name parts, lab, provider and location.
function identityTokens(model: LitellmModel): string[] {
	return [model.name, model.lab, model.provider, model.location]
		.filter(Boolean)
		.join(' ')
		.toLowerCase()
		.split(/[\s._/-]+/)
		.filter(Boolean);
}

function queryTokens(query: string): string[] {
	return query.toLowerCase().split(/[\s._/-]+/).filter(Boolean);
}

/** True when every query word starts a word of this model's identity, e.g. "opus 4.6". */
export function matchesLookup(model: LitellmModel, query: string): boolean {
	const tokens = identityTokens(model);
	const words = queryTokens(query);
	return words.length > 0 && words.every((w) => tokens.some((t) => t.startsWith(w)));
}

/**
 * Route a query. "lookup" when every word names part of some model's identity
 * (name, lab, provider, location), so the table filters instantly with no LLM
 * call. Anything else, or a question mark or question word, is a "question".
 */
export function classifyQuery(query: string, models: ReadonlyArray<LitellmModel>): 'lookup' | 'question' {
	if (query.includes('?') || QUESTION_START.test(query)) return 'question';
	const all = allIdentityTokens(models);
	const words = queryTokens(query);
	return words.length > 0 && words.every((w) => all.some((t) => t.startsWith(w))) ? 'lookup' : 'question';
}

// The model list is cached and reused, so its tokens are worked out once per list.
const tokensByModelList = new WeakMap<ReadonlyArray<LitellmModel>, string[]>();

function allIdentityTokens(models: ReadonlyArray<LitellmModel>): string[] {
	let tokens = tokensByModelList.get(models);
	if (!tokens) {
		tokens = [...new Set(models.flatMap(identityTokens))];
		tokensByModelList.set(models, tokens);
	}
	return tokens;
}

export const EXAMPLE_QUESTIONS = USE_CASES.map(u => u.query);

/**
 * One compact line per provider page for the ask prompt. Region variants share
 * a page, so they share a line, listed as name@location.
 */
export function catalogueLine(
	models: ReadonlyArray<LitellmModel>,
	details: ModelDetails | undefined,
	arena: ReadonlyArray<ArenaRanking> = [],
): string {
	const model = models[0];
	const perM = (v?: number) => (v !== undefined ? `${(v * 1e6).toFixed(2)} USD` : '?');
	const ctx = model.max_input_tokens ?? details?.context_window;
	const caps = [
		model.supports_vision && 'vision',
		model.supports_reasoning && 'reasoning',
		model.supports_function_calling && 'tools',
		model.open_weight && 'open-weight',
	].filter(Boolean);
	const parts = [
		`names=${models.map((m) => `${m.name}@${m.location ?? '?'}`).join(', ')}`,
		`lab=${model.lab ?? '?'}`,
		`mode=${model.mode ?? 'chat'}`,
		`context=${ctx ?? '?'}`,
		`cost_per_M_tokens_in/out=${perM(model.input_cost_per_token)}/${perM(model.output_cost_per_token)}`,
		caps.length ? `caps=${caps.join(',')}` : '',
		details?.knowledge_cutoff ? `cutoff=${details.knowledge_cutoff}` : '',
		`about=${details?.summary || model.description || ''}`,
		details?.best_for.length ? `best_for=${details.best_for.join('; ')}` : '',
		details?.benchmarks.length ? `benchmarks=${details.benchmarks.map((b) => `${b.name} ${b.score}`).join('; ')}` : '',
		arena.length ? `arena=${arena.map((r) => `${r.label} ${describeRank(r)}`).join('; ')}` : '',
	];
	return parts.filter(Boolean).join(' | ');
}

/** Group models by provider page, keeping config order. */
export function groupByPage(models: ReadonlyArray<LitellmModel>): LitellmModel[][] {
	const groups = new Map<string, LitellmModel[]>();
	for (const m of models) {
		const key = m.uri ?? `name:${m.name}`;
		const group = groups.get(key);
		if (group) group.push(m);
		else groups.set(key, [m]);
	}
	return [...groups.values()];
}

export interface ModelSuggestion {
	id: string;
	name: string;
	reason: string;
	/** Provider page the model's details came from, when they were included. */
	source_url?: string;
	source_checked_at?: string;
	/** True when Arena rankings for this model were in the catalogue. */
	arena_ranked: boolean;
	/** Structured facts from our config, never from the LLM. */
	facts: ModelFacts;
	/** The Arena leaderboards the answer relied on, with ranks from our data (not the LLM's). */
	arena_evidence: Array<{ label: string; text: string }>;
}

export interface ModelFacts {
	location?: string;
	lab?: string;
	country_of_origin?: string;
	open_weight?: boolean;
	/** USD per token, as in config; format with lib/format.ts. */
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	context_tokens?: number;
	/** The same model hosted elsewhere (aliases sharing its provider page). */
	other_regions: Array<{ id: string; name: string; location?: string }>;
}

export function modelFacts(model: LitellmModel, models: ReadonlyArray<LitellmModel>): ModelFacts {
	return {
		location: model.location,
		lab: model.lab,
		country_of_origin: model.country_of_origin,
		open_weight: model.open_weight,
		input_cost_per_token: model.input_cost_per_token,
		output_cost_per_token: model.output_cost_per_token,
		context_tokens: model.max_input_tokens,
		other_regions: model.uri
			? models.filter((m) => m.uri === model.uri && m.id !== model.id).map((m) => ({ id: m.id, name: m.name, location: m.location }))
			: [],
	};
}

/** What an answer is based on, shown alongside it. */
export interface AskContext {
	/** Distinct provider pages, and how many have usable details. */
	pages_total: number;
	pages_included: number;
	/** Newest extraction among the included pages. */
	details_updated_at?: string;
	/** Distinct pages whose model has Arena rankings, and the newest Arena publish date. */
	arena_pages: number;
	arena_published?: string;
	arena_dataset_url: string;
	arena_licence: string;
}

export interface AskResult {
	suggestions: ModelSuggestion[];
	error?: string;
}

const ASK_PROMPT = `You help civil servants choose an LLM from a government AI gateway's catalogue.
Recommend 3 models from the catalogue below that best answer the question, best first. Give
fewer only if fewer fit a hard constraint in the question (e.g. "UK-hosted").
Hosting: UK and EU hosting are equally acceptable; never prefer one over the other unless the
question asks. Order suggestions by capability for the task, then cost. Suggest a
model hosted elsewhere (global, US) only if it is clearly better than every UK/EU option, and say
where it is hosted. For sensitive, personal or official data, suggest only UK or EU models.
mode=decision models return a choice, score or yes/no probability instead of text: suggest one
only when the question is about classifying, routing, scoring or yes/no judgements of text.
arena= gives Arena human-preference leaderboard ranks; lower is better. "tied #1 of 408 (12th by
score)" means the model is statistically indistinguishable from the others tied at #1, so never
prefer one model over another because of score order inside a tie.
Treat Arena as the strongest capability evidence and use the leaderboard matching the question:
- code, software, programming: Code Arena (building apps) first; Coding questions (chat) only to
  break ties
- agents, coding agents, automation, tool use: Agent Arena overall
- long documents: Longer queries
- policy, legal or government work: Legal and government
Otherwise judge from about, best_for, benchmarks and your own knowledge. Models without arena= are
not ranked there, which is not evidence of weakness.
Weigh cost, context size and hosting location too.
Prefer the newest model in a family unless cost or location argues otherwise.
Each line lists a model's region variants as name@location; pick one variant, preferring UK, then
EU, unless the question asks otherwise.
Keep each reason to one plain-English sentence on why the model fits the question. Hosting,
maker, cost, context size and rank numbers are shown separately, so do not repeat them.
Never state a figure that is not copied exactly from the catalogue.
If the catalogue has no direct evidence for the task (e.g. a language with no leaderboard), still
suggest the 3 strongest general models and say the evidence is general. Return no suggestions
only if the question is not about choosing a model.`;

/** The reply shape the ask model is constrained to. */
export const SuggestionsSchema = z.object({
	suggestions: z.array(z.object({
		name: z.string().describe('One full name copied from names=, without @location, e.g. gpt-5-sweden'),
		reason: z.string().describe('One sentence on why the model fits the question'),
		evidence: z.array(z.string()).describe('The arena= leaderboard labels relied on, e.g. "Code Arena (building apps)"; empty if none'),
	})).describe('Up to 3, best first'),
});
export type Suggestions = z.infer<typeof SuggestionsSchema>;

const LOCATION_PREFERENCE = ['UK', 'EU'];

/**
 * Resolve a reply name to a model: exact, else a base name with its region
 * suffix dropped (e.g. "gpt-5" for "gpt-5-sweden"), taking the UK then EU variant.
 */
export function resolveModelName(name: string, models: ReadonlyArray<LitellmModel>): LitellmModel | undefined {
	const clean = name.trim().replace(/@.*$/, '');
	const exact = models.find((m) => m.name === clean);
	if (exact) return exact;
	// Replies may drop the hosting suffix ("gpt-5") and the gateway prefix ("claude-opus-5-5").
	const base = modelBase(clean);
	const variants = models.filter((m) => withoutHosting(m.name) === clean || modelBase(m.name) === base);
	const rank = (m: LitellmModel) => {
		const i = LOCATION_PREFERENCE.indexOf(m.location ?? '');
		return i === -1 ? LOCATION_PREFERENCE.length : i;
	};
	return variants.sort((a, b) => rank(a) - rank(b))[0];
}

/** Map the reply onto real catalogue models, dropping unknown names and duplicates. */
export function parseSuggestions(
	raw: Suggestions,
	models: ReadonlyArray<LitellmModel>,
	detailsFor: (m: LitellmModel) => ModelDetails | undefined = () => undefined,
	arenaFor: (m: LitellmModel) => ReadonlyArray<ArenaRanking> = () => [],
	/** Every model, for "also hosted in" when `models` is a filtered subset. */
	allModels: ReadonlyArray<LitellmModel> = models,
): ModelSuggestion[] {
	const seen = new Set<string>();
	const out: ModelSuggestion[] = [];
	for (const s of raw.suggestions) {
		const model = resolveModelName(s.name, models);
		if (!model) continue;
		// One card per model: region variants share a provider page.
		const key = model.uri ?? model.name;
		if (seen.has(key)) continue;
		seen.add(key);
		const details = detailsFor(model);
		const rankings = arenaFor(model);
		// Models often write "Label: tied #1 of 408", so match on the label prefix.
		const cited = s.evidence.map((e) => e.trim().toLowerCase());
		const isCited = (label: string) => cited.some((e) => e.startsWith(label.toLowerCase()));
		out.push({
			id: model.id,
			name: model.name,
			reason: s.reason || model.description || '',
			source_url: details?.source_url,
			source_checked_at: details?.fetched_at,
			facts: modelFacts(model, allModels),
			arena_ranked: rankings.length > 0,
			arena_evidence: rankings.filter((r) => isCited(r.label)).map((r) => ({ label: r.label, text: describeRank(r) })),
		});
		if (out.length === 3) break;
	}
	return out;
}

async function fetchSuggestions(query: string, filter: ModelFilter): Promise<AskResult> {
	const { config, error } = getLitellmConfig();
	if (!config) return { suggestions: [], error };

	const all = await getAllModels();
	if (all.error !== undefined) return { suggestions: [], error: all.error };
	// Pass-through models (Jev) can be suggested; pass-through tools (Tavily) aren't models.
	const suggestable = withPassThrough(all.models).filter((m) => !isPassThroughTool(m));
	// Only rank models the page's filters leave in the table.
	const candidates = suggestable.filter((m) => matchesFilter(m, filter));
	if (candidates.length === 0) return { suggestions: [] };

	const catalogue = groupByPage(candidates)
		.map((group) => catalogueLine(group, usableModelDetails(group[0]), arenaRankings(group[0])))
		.join('\n');
	const messages = [
		{ role: 'system' as const, content: `${ASK_PROMPT}\n\n<catalogue>\n${catalogue}\n</catalogue>` },
		{ role: 'user' as const, content: query },
	];
	// Fast model first; fall back on an error or a reply naming no real models.
	let suggestions: ModelSuggestion[] = [];
	let answered = false;
	let lastError = 'No model answered';
	for (const { model, params, cacheSystem } of askModelChain()) {
		const raw = await chatJson(config, model, messages, SuggestionsSchema, { name: 'model_suggestions', cacheSystem, params });
		if (raw.error !== undefined) {
			lastError = raw.error;
			logger.warn({ model, query, error: raw.error }, 'Model suggestions call failed');
			continue;
		}
		suggestions = parseSuggestions(raw.value, candidates, usableModelDetails, arenaRankings, suggestable);
		const namedSome = raw.value.suggestions.length > 0;
		if (suggestions.length > 0 || !namedSome) {
			answered = true; // real picks, or a deliberate "nothing fits"
			break;
		}
		lastError = 'Suggestions did not match any model';
		logger.warn({ model, query, reply: raw.value }, 'Model suggestions named no catalogue models');
	}
	return answered ? { suggestions } : { suggestions: [], error: lastError };
}

export function askContext(
	models: ReadonlyArray<LitellmModel>,
	detailsFor: (m: LitellmModel) => ModelDetails | undefined = usableModelDetails,
	hasArena: (m: LitellmModel) => boolean = hasArenaRankings,
	arenaPublishedAt: string | undefined = arenaPublished(),
): AskContext {
	const pages = new Map<string, ModelDetails | undefined>();
	const arenaPages = new Set<string>();
	for (const m of models) {
		if (!isExtractable(m)) continue;
		pages.set(m.uri!, detailsFor(m));
		if (hasArena(m)) arenaPages.add(m.uri!);
	}
	const fetched = [...pages.values()]
		.filter((d): d is ModelDetails => Boolean(d))
		.map((d) => d.fetched_at)
		.sort();
	return {
		pages_total: pages.size,
		pages_included: fetched.length,
		details_updated_at: fetched.at(-1),
		arena_pages: arenaPages.size,
		arena_published: arenaPublishedAt,
		arena_dataset_url: ARENA_DATASET_URL,
		arena_licence: 'CC-BY-4.0',
	};
}

// Same question and filters, same answer for an hour; failures are not cached.
// The key carries the catalogue version, bumped when a background refresh run
// finishes, so answers are recomputed once per refresh rather than per page.
const ASK_CACHE_TTL_MS = 60 * 60 * 1000;
const askCached = cachedKeyedFetcher(ASK_CACHE_TTL_MS, (key: string) => {
	const { q, f } = JSON.parse(key) as { q: string; f: ModelFilter };
	return fetchSuggestions(q, f);
});

export function askModels(query: string, filter: ModelFilter = {}): Promise<AskResult> {
	const f = describeFilter(filter) ? filter : {};
	return askCached(JSON.stringify({ q: normaliseQuery(query).toLowerCase(), f }));
}

/** Answer the example questions so their links respond instantly. Run by the background refresh. */
export async function prefetchExampleAnswers(): Promise<void> {
	await Promise.all(EXAMPLE_QUESTIONS.map((q) => askModels(q)));
}
