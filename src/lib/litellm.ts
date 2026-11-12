/**
 * Client for LiteLLM's health, model, team, and cost read APIs, plus the
 * config/logger/URL helpers litellmKeys.ts shares from here.
 *
 * `/health/readiness` is unauthenticated, so checkLitellmHealth reads
 * LITELLM_URL directly instead of going through getLitellmConfig.
 */
import { logger } from './logging';
import { PASS_THROUGH_MODELS } from './passThroughModels';
import { shiftDate, todayUtc } from './usage';

export const REQUEST_TIMEOUT_MS = 5000;

/** The key LiteLLM's own background health checks run under; its cost rows are filtered out. */
export const HEALTH_CHECK_KEY_TOKEN = "litellm-internal-health-check";

export interface LitellmConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * The base URL + master key every authenticated LiteLLM call needs, read
 * from env on every call (rather than once at module load) so a missing var
 * surfaces as a normal `{ error }` result instead of crashing at import time.
 *
 * Named LITELLM_MASTER_KEY (not LITELLM_API_KEY) to match the secret name
 * wired into this container's ECS task definition in terraform/infra/ecs.tf.
 */
export function getLitellmConfig(): { config?: LitellmConfig; error?: string } {
	const baseUrl = process.env.LITELLM_URL;
	if (!baseUrl) {
		logger.error('LITELLM_URL is not configured');
		return { error: 'LITELLM_URL is not configured' };
	}

	const apiKey = process.env.LITELLM_MASTER_KEY;
	if (!apiKey) {
		logger.error('LITELLM_MASTER_KEY is not configured');
		return { error: 'LITELLM_MASTER_KEY is not configured' };
	}

	return { config: { baseUrl, apiKey } };
}

export function apiUrl(config: LitellmConfig, path: string, params?: Record<string, string>): URL {
	const url = new URL(path, config.baseUrl);
	for (const [key, value] of Object.entries(params ?? {})) {
		url.searchParams.set(key, value);
	}
	return url;
}

/** The message used for every `{ error }` result when a fetch throws rather than resolving with a response. */
export function unknownErrorMessage(e: unknown): string {
	return e instanceof Error ? e.message : "Unknown error contacting LiteLLM";
}

export interface LitellmResponse {
	/** HTTP status, or 0 when no response was received (missing config, network failure, timeout). */
	status: number;
	/** The parsed JSON body, or null if it wasn't JSON. Present on HTTP errors too. */
	body: any;
	/** Set when the call failed; absent means `body` is usable. */
	error?: string;
}

/**
 * An authenticated call to the LiteLLM proxy, returning `{ error }` instead of
 * throwing: a missing config, a network failure or timeout, a non-2xx status,
 * or a body that fails `expect` all become an error, so callers only branch on
 * `error`. Passing `json` sends it as a POST body. HTTP and network failures
 * are logged here once, with the path; `log` adds context (user, email, ...).
 * `tolerate` names a status that is not a failure (e.g. 404 on delete): no
 * error is set and nothing is logged, so the caller can read `status`.
 */
export async function litellmFetch(
	path: string,
	opts: {
		params?: Record<string, string>;
		json?: unknown;
		timeoutMs?: number;
		expect?: (body: any) => boolean;
		tolerate?: number;
		log?: Record<string, unknown>;
	} = {},
): Promise<LitellmResponse> {
	const { config, error: configError } = getLitellmConfig();
	if (!config) {
		return { status: 0, body: null, error: configError };
	}

	const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
	if (opts.json !== undefined) headers["Content-Type"] = "application/json";

	try {
		const response = await fetch(apiUrl(config, path, opts.params), {
			...(opts.json !== undefined && { method: "POST", body: JSON.stringify(opts.json) }),
			headers,
			signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);

		if (opts.tolerate !== undefined && response.status === opts.tolerate) {
			return { status: response.status, body };
		}
		if (!response.ok) {
			logger.error({ path, status: response.status, ...opts.log }, `LiteLLM returned ${response.status}`);
			return { status: response.status, body, error: `LiteLLM returned ${response.status}` };
		}
		if (opts.expect && !opts.expect(body)) {
			logger.error({ path, status: response.status, ...opts.log }, "LiteLLM returned an unexpected response");
			return { status: response.status, body, error: "LiteLLM returned an unexpected response" };
		}
		return { status: response.status, body };
	} catch (e) {
		logger.error({ err: e, path, ...opts.log }, "Unknown error contacting LiteLLM");
		return { status: 0, body: null, error: unknownErrorMessage(e) };
	}
}

/**
 * A cache holding the result of `fetcher` per distinct key, each entry expiring
 * after its TTL (fixed, or chosen per key), with one in-flight slot per key.
 * Pass `refresh` to refetch a still-fresh entry; it's kept until the new one lands.
 * Shared by the model, team, and cost lookups below so each one only has to
 * say *what* to fetch and cache, not *how* - failures are deliberately never
 * cached, so a transient LiteLLM error doesn't poison lookups for the rest of
 * the TTL window.
 *
 * Concurrent callers that arrive while a key is cold (or expired) share a
 * single in-flight fetch rather than each launching their own - without this,
 * every request during a cold window would fire its own copy of an expensive
 * query at once (a cache stampede), piling load onto LiteLLM and making the
 * timeouts it's meant to avoid more likely, not less.
 */
export function cachedKeyedFetcher<K extends string, T extends { error?: string }>(
	ttlMs: number | ((key: K) => number),
	fetcher: (key: K) => Promise<T>
): (key: K, opts?: { refresh?: boolean }) => Promise<T> {
	const ttlFor = typeof ttlMs === "function" ? ttlMs : () => ttlMs;
	const entries = new Map<K, { value: T; expiresAt: number }>();
	const inFlight = new Map<K, Promise<T>>();

	return async (key: K, { refresh = false } = {}) => {
		const entry = entries.get(key);
		if (!refresh && entry && Date.now() < entry.expiresAt) {
			return entry.value;
		}
		const existing = inFlight.get(key);
		if (existing) {
			return existing;
		}

		// A cache miss is already the expensive path, so sweep aged-out entries
		// here rather than on every hit. Without this the map would grow without
		// bound over the process's lifetime as the key set turns over - date
		// ranges roll forward daily and, for the cost cache, each user visiting
		// their own scoped view adds a distinct key. Pruning on miss keeps only
		// unexpired entries.
		const now = Date.now();
		for (const [k, e] of entries) {
			if (e.expiresAt <= now) {
				entries.delete(k);
			}
		}

		const pending = (async () => {
			try {
				const value = await fetcher(key);
				if (value.error === undefined) {
					entries.set(key, { value, expiresAt: Date.now() + ttlFor(key) });
				}
				return value;
			} finally {
				inFlight.delete(key);
			}
		})();
		inFlight.set(key, pending);
		return pending;
	};
}

/**
 * A `cachedKeyedFetcher` with no key - a single-slot cache for lookups that
 * take no argument (the whole model list, the whole team list). Same TTL and
 * stampede protection; just one bucket.
 */
function cachedFetcher<T extends { error?: string }>(ttlMs: number, fetcher: () => Promise<T>): () => Promise<T> {
	const keyed = cachedKeyedFetcher<string, T>(ttlMs, fetcher);
	return () => keyed("");
}

export interface LitellmHealth {
	healthy: boolean;
	/** "connected" | "disconnected" | "Not connected", or undefined if the response body was unreadable. */
	db?: string;
	/** Set when the request itself failed - the proxy was unreachable, timed out, or returned unparsable JSON. */
	error?: string;
}

async function fetchLitellmHealth(): Promise<LitellmHealth> {
	const baseUrl = process.env.LITELLM_URL;
	if (!baseUrl) {
		return { healthy: false, error: "LITELLM_URL is not configured" };
	}

	try {
		const response = await fetch(new URL("/health/readiness", baseUrl), {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		// LiteLLM returns 200 when ready and 503 when a configured database is
		// unreachable; either way the body is JSON worth surfacing.
		const body = await response.json().catch(() => null);

		if (!response.ok) {
			logger.warn({ status: response.status, db: body?.db }, 'LiteLLM health check unhealthy');
		}

		return {
			healthy: response.ok,
			db: typeof body?.db === "string" ? body.db : undefined,
			error: response.ok ? undefined : `LiteLLM returned ${response.status}`,
		};
	} catch (e) {
		logger.error({ err: e }, 'Unknown error contacting LiteLLM');
		return { healthy: false, error: unknownErrorMessage(e) };
	}
}

// The readiness banner renders in the layout on *every* page, so cache the
// probe to avoid a `/health/readiness` round trip per navigation. A short TTL
// keeps the "is the gateway up" signal fresh; and because cachedFetcher never
// caches error results, a down/unreachable gateway is re-checked on every page
// load and the banner clears as soon as it recovers.
const HEALTH_READINESS_CACHE_TTL_MS = 30 * 1000;
export const checkLitellmHealth = cachedFetcher(HEALTH_READINESS_CACHE_TTL_MS, fetchLitellmHealth);

/** A model's size in billions of parameters, `active` for mixture-of-experts models, and where the figures came from. */
export interface ModelParameters {
	total: number;
	active?: number;
	/** The model card or page the figures were read from. */
	source?: string;
}

export interface LitellmModel {
	id: string;
	name: string;
	provider: string;
	mode: string;
	/** The underlying litellm_params.model string, e.g. "bedrock/eu.anthropic.claude-opus-4-6-v1". */
	litellm_model: string;
	supports_vision: boolean;
	supports_function_calling: boolean;
	supports_audio_input: boolean;
	supports_reasoning: boolean;

	/** Missing/null for some models (e.g. embeddings, or ones with no pricing configured). */
	max_input_tokens?: number;
	max_output_tokens?: number;
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	tpm?: number;
	rpm?: number;

	/** Custom `model_info` fields set in config.yml - not present for every model. */
	uri?: string;
	description?: string;
	location?: string;
	country_of_origin?: string;
	lab?: string;
	open_weight?: boolean;
	/** Size from the model card. Set for every open-weight model; closed models omit it. See config.yml's header. */
	parameters?: ModelParameters;
	/**
	 * The ecologits registry entry ("provider/name") this closed generation
	 * model maps to. Set on every closed generation model; open-weight models
	 * use `parameters` instead. See impact.ts and ADR-0005.
	 */
	impact_model?: string;
	/** Override the derived electricity mix zone (ISO 3166-1 alpha-3). */
	impact_zone?: string;
}

export interface LitellmModelList {
	models: ReadonlyArray<LitellmModel>;
	next?: number;
	error?: string;
}

/**
 * One /v2/model/info record (the same shape as a config.yml model_list entry)
 * as a LitellmModel. Exported so tests that read config.yml map entries the way
 * the app does, rather than keeping a second field list.
 */
export function toLitellmModel(r: any): LitellmModel {
	return {
		id: r.model_info.id,
		name: r.model_name,
		provider: r.model_info.provider ?? r.model_info.litellm_provider,
		mode: r.model_info.mode,
		litellm_model: r.litellm_params?.model ?? "",
		supports_vision: Boolean(r.model_info.supports_vision),
		supports_function_calling: Boolean(r.model_info.supports_function_calling),
		supports_audio_input: Boolean(r.model_info.supports_audio_input),
		supports_reasoning: Boolean(r.model_info.supports_reasoning),
		max_input_tokens: r.model_info.max_input_tokens ?? undefined,
		max_output_tokens: r.model_info.max_output_tokens ?? undefined,
		input_cost_per_token: r.model_info.input_cost_per_token ?? undefined,
		output_cost_per_token: r.model_info.output_cost_per_token ?? undefined,
		tpm: r.model_info.tpm ?? undefined,
		rpm: r.model_info.rpm ?? undefined,
		uri: r.model_info.uri,
		description: r.model_info.description,
		location: r.model_info.location,
		country_of_origin: r.model_info.country_of_origin,
		lab: r.model_info.lab,
		open_weight: r.model_info.open_weight,
		parameters: r.model_info.parameters,
		impact_model: r.model_info.impact_model,
		impact_zone: r.model_info.impact_zone,
	};
}

async function getModels(page: number = 1): Promise<LitellmModelList> {
	const { body, error } = await litellmFetch("/v2/model/info", {
		params: { page: String(page) },
		expect: (b) => Boolean(b?.data),
	});
	if (error !== undefined) {
		return { models: [], error };
	}

	return {
		models: body.data.map(toLitellmModel),
		next: body.current_page < body.total_pages ? body.current_page + 1 : undefined,
	};
}

type ModelCapabilityFilter = Partial<Pick<LitellmModel, "supports_vision" | "supports_reasoning" | "provider">>;

function matchesFilter(model: LitellmModel, filter: ModelCapabilityFilter): boolean {
	return (Object.keys(filter) as Array<keyof ModelCapabilityFilter>).every(
		(key) => filter[key] === undefined || model[key] === filter[key]
	);
}

async function fetchAllModels(): Promise<LitellmModelList> {
	let page = 1;
	const results: Array<LitellmModel> = [];

	while (page > 0) {
		const m = await getModels(page);
		if (m.error !== undefined) {
			return { models: [], error: m.error };
		}
		results.push(...m.models);
		page = m.next !== undefined ? m.next : -1;
	}

	return { models: results };
}

// Model list/capabilities only change when someone edits the LiteLLM config,
// so it's safe (and much cheaper - one sequential page-walk instead of one
// per request) to cache the full unfiltered list for a short while rather
// than re-fetching every page of /v2/model/info on every page view.
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const fetchAllModelsCached = cachedFetcher(MODEL_CACHE_TTL_MS, fetchAllModels);

export async function getAllModels(filter: ModelCapabilityFilter = {}): Promise<LitellmModelList> {
	const all = await fetchAllModelsCached();
	if (all.error !== undefined) {
		return all;
	}
	return { models: all.models.filter((m) => matchesFilter(m, filter)) };
}

export interface LitellmModelResult {
	model?: LitellmModel;
	error?: string;
}

export async function getModel(id: string): Promise<LitellmModelResult> {
	// Pass-through models aren't in /v2/model/info, so check them first (and
	// without depending on that call succeeding).
	const passThrough = PASS_THROUGH_MODELS.find((m) => m.id === id);
	if (passThrough) {
		return { model: passThrough };
	}

	const all = await fetchAllModelsCached();
	if (all.error !== undefined) {
		return { error: all.error };
	}

	const model = all.models.find((m) => m.id === id);
	return model ? { model } : { error: "Model not found" };
}

export interface LitellmTeam {
	id: string;
	/** Falls back to the id when a team has no alias set, so callers always have something to display. */
	name: string;
}

export interface LitellmTeamList {
	teams: ReadonlyArray<LitellmTeam>;
	error?: string;
}

async function fetchTeams(): Promise<LitellmTeamList> {
	// v2, not /team/list: it supports the alias filter litellmKeys.ts's
	// team picker needs. page_size 100 covers every team in one page.
	const { body, error } = await litellmFetch("/v2/team/list", {
		params: { page_size: "100" },
		expect: (b) => Array.isArray(b?.teams),
	});
	if (error !== undefined) {
		return { teams: [], error };
	}

	return {
		teams: body.teams.map((t: any) => ({
			id: t.team_id,
			name: t.team_alias || t.team_id,
		})),
	};
}

// Team names change about as often as team membership does - rarely - so
// the same short-TTL, whole-list cache used for models suits teams too, and
// avoids a /team/list round trip on every cost lookup.
const TEAMS_CACHE_TTL_MS = 5 * 60 * 1000;

export const getTeams = cachedFetcher(TEAMS_CACHE_TTL_MS, fetchTeams);

export interface KeyUserMap {
	/** key hash token -> owning user_id, only for keys that have one. */
	userByToken: Map<string, string>;
	error?: string;
}

/**
 * Map each key's hash token to the user_id that owns it, by walking /key/list.
 * The daily-activity aggregation carries a key's team_id but not its user_id, so
 * this is the only way to count distinct *people* rather than distinct keys (a
 * person often holds several). include_team_keys surfaces team/service keys too,
 * but those usually have no user_id and are simply left unmapped - they're not a
 * person, so they don't count towards active users. /key/list caps page size at
 * 100, so walk pages until total_pages is reached.
 */
async function fetchKeyUserMap(): Promise<KeyUserMap> {
	const userByToken = new Map<string, string>();
	for (let page = 1; ; page++) {
		const { body, error } = await litellmFetch("/key/list", {
			params: { page: String(page), size: "100", return_full_object: "true", include_team_keys: "true" },
			expect: (b) => Array.isArray(b?.keys),
		});
		if (error !== undefined) {
			return { userByToken: new Map(), error };
		}

		for (const key of body.keys as Array<any>) {
			// return_full_object gives objects; guard for the token-string shape too.
			const token: string | undefined = typeof key === "string" ? key : key?.token;
			const userId: string | null = typeof key === "object" ? (key?.user_id ?? null) : null;
			if (token && userId) userByToken.set(token, userId);
		}

		const totalPages: number = body.total_pages ?? page;
		if (page >= totalPages || body.keys.length === 0) break;
	}

	return { userByToken };
}

// Key ownership changes only when keys are created/deleted/reassigned, far less
// often than the dashboard is viewed, so the same short whole-list cache used
// for models and teams suits the token->user_id map and keeps the multi-page
// /key/list walk off the critical path of most cost lookups.
const KEY_USERS_CACHE_TTL_MS = 5 * 60 * 1000;

const fetchKeyUserMapCached = cachedFetcher(KEY_USERS_CACHE_TTL_MS, fetchKeyUserMap);

export interface LitellmCost {
	date: string;
	model_name: string;
	spend: number;
	total_tokens: number;
	/** Input tokens. prompt_tokens + completion_tokens sums to total_tokens. */
	prompt_tokens: number;
	/** Output tokens. */
	completion_tokens: number;
	/** Input tokens served from the prompt cache (a subset of prompt_tokens). */
	cache_read_input_tokens: number;
	/** Input tokens written to the prompt cache (a subset of prompt_tokens). */
	cache_creation_input_tokens: number;
	/** Number of API requests. 0 when the proxy omits it from the metrics. */
	api_requests: number;
	/** Of those requests, how many failed. 0 when the proxy omits it from the metrics. */
	failed_requests: number;
	key_alias: string;
	/**
	 * The key's hash token - the api_key_breakdown map key. Uniquely identifies a
	 * key even when key_alias is null or shared, so it's the identity used for
	 * distinct-key counting and for the user_id join below.
	 */
	key_token: string;
	/**
	 * The user this key belongs to (LiteLLM user_id), or null when it can't be
	 * attributed to a person: team/service keys with no owner, or keys deleted
	 * since (so absent from /key/list). Resolved via a token->user_id join.
	 */
	user_id: string | null;
	/** Empty for a key with no team assigned. */
	team_id: string;
	/** The team's display name, "" for an unassigned key, or team_id itself if /team/list couldn't resolve it (e.g. deleted since, or a lookup failure). */
	team_name: string;
}

/**
 * A day's spend for one (provider, key) pair. The aggregated activity groups
 * the same underlying usage by backend provider (vertex_ai, bedrock, ...) as
 * well as by model; this row carries the provider cut so we can total the
 * provider mix per user without a second request.
 */
export interface LitellmProviderCost {
	date: string;
	provider: string;
	spend: number;
	total_tokens: number;
	api_requests: number;
	failed_requests: number;
	key_alias: string;
}

export interface LitellmCostList {
	costs: ReadonlyArray<LitellmCost>;
	/** The same usage grouped by backend provider rather than model. */
	providerCosts: ReadonlyArray<LitellmProviderCost>;
	error?: string;
	/**
	 * True when the /key/list join failed: `user_id` is null on every row, so a
	 * distinct-user count would read a misleading 0. The costs are still valid, so
	 * callers should show the users figure as unavailable but trust the rest.
	 */
	usersUnavailable?: boolean;
}

/** A cost row before the team name and key owner are joined on. */
type RawCost = Omit<LitellmCost, "user_id" | "team_name">;

interface CostBlock {
	costs: ReadonlyArray<RawCost>;
	providerCosts: ReadonlyArray<LitellmProviderCost>;
	error?: string;
}

// The platform-wide aggregation is a full scan on LiteLLM's side and can take
// tens of seconds, so it gets far longer than the default timeout. Aborting
// early doesn't stop the query upstream; it only throws the result away.
const PLATFORM_COSTS_REQUEST_TIMEOUT_MS = 60_000;

async function fetchCostBlock(startDate: string, endDate: string, userId?: string): Promise<CostBlock> {
	// Scoping by user_id makes LiteLLM aggregate only that user's own keys
	// server-side - the individual (home) view needs nothing more, and it turns
	// a whole-platform scan (megabytes, every team's keys) into a small, fast
	// query. Omitted for the platform-wide /trends overview, which needs it all.
	const params: Record<string, string> = { start_date: startDate, end_date: endDate };
	if (userId) {
		params.user_id = userId;
	}

	const startedAt = Date.now();
	const { body, error } = await litellmFetch("/user/daily/activity/aggregated", {
		params,
		timeoutMs: userId ? REQUEST_TIMEOUT_MS : PLATFORM_COSTS_REQUEST_TIMEOUT_MS,
		expect: (b) => Boolean(b?.results),
	});
	logger.info({ startDate, endDate, scoped: Boolean(userId), ms: Date.now() - startedAt }, 'Fetched costs week');
	if (error !== undefined) {
		return { costs: [], providerCosts: [], error };
	}

	const costs: Array<RawCost> = [];
	const providerCosts: Array<LitellmProviderCost> = [];
	for (const result of body.results) {
		const date = result.date;
		for (const [modelName, model] of Object.entries(result.breakdown.models) as Array<[string, any]>) {
			for (const [token, subValue] of Object.entries(model.api_key_breakdown) as Array<[string, any]>) {
				costs.push(toRawCost(date, modelName, token, subValue));
			}
		}
		// The provider cut of the same usage. Older days may predate the
		// providers breakdown, so treat it as optional rather than assuming
		// every result carries one.
		for (const [providerName, provider] of Object.entries(result.breakdown.providers ?? {}) as Array<[string, any]>) {
			for (const subValue of Object.values(provider.api_key_breakdown ?? {}) as Array<any>) {
				providerCosts.push({
					date,
					provider: providerName,
					spend: subValue.metrics.spend,
					total_tokens: subValue.metrics.total_tokens,
					api_requests: subValue.metrics.api_requests ?? 0,
					failed_requests: subValue.metrics.failed_requests ?? 0,
					key_alias: subValue.metadata.key_alias,
				});
			}
		}
	}

	return { costs, providerCosts };
}

/** One api_key_breakdown entry as a cost row; shared by the model and model-group breakdowns. */
function toRawCost(date: string, modelName: string, token: string, subValue: any): RawCost {
	return {
		date,
		model_name: modelName,
		spend: subValue.metrics.spend,
		total_tokens: subValue.metrics.total_tokens,
		prompt_tokens: subValue.metrics.prompt_tokens ?? 0,
		completion_tokens: subValue.metrics.completion_tokens ?? 0,
		cache_read_input_tokens: subValue.metrics.cache_read_input_tokens ?? 0,
		cache_creation_input_tokens: subValue.metrics.cache_creation_input_tokens ?? 0,
		api_requests: subValue.metrics.api_requests ?? 0,
		failed_requests: subValue.metrics.failed_requests ?? 0,
		key_alias: subValue.metadata.key_alias ?? "",
		key_token: token,
		team_id: subValue.metadata.team_id ?? "",
	};
}

// Ranges are fetched as fixed Monday-to-Sunday weeks, cached per week, so
// overlapping ranges (30 vs 90 days, the comparison window, the CSV) share
// most of their fetches and each upstream query stays small. A week that ended
// before yesterday no longer changes, so a platform-wide one is kept for the life
// of the process (about 26 entries for the warmed span); a user-scoped one is
// held for a day so the map doesn't grow with every visitor. The current week
// refreshes every 30 min platform-wide, or every 5 min for one user's own
// (small) view on the home page.
const PLATFORM_COSTS_CACHE_TTL_MS = 30 * 60 * 1000;
const USER_COSTS_CACHE_TTL_MS = 5 * 60 * 1000;
const SETTLED_USER_COSTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Weeks fetched at once, so a cold quarter doesn't fire 26 scans together.
const COSTS_CONCURRENCY = 3;
// A cold, long custom range is many slow scans, so a lookup gives up well inside
// the ALB's 300s. Weeks already in flight still land in the cache, so a retry
// picks up where it left off.
const COSTS_DEADLINE_MS = 90_000;
const COSTS_DEADLINE_ERROR = "Usage for this range is still loading. Try again in a minute.";

/** Whether the week starting `monday` has stopped changing. */
function isSettledWeek(monday: string): boolean {
	return shiftDate(monday, 6) < shiftDate(todayUtc(), -1);
}

/** Cache key for one week's costs: its Monday, and the user it's scoped to (if any). */
function costWeekKey(monday: string, userId?: string): string {
	return `${monday}|${userId ?? ""}`;
}

const getCostWeekCached = cachedKeyedFetcher(
	(key: string) => {
		const [monday, userId] = key.split("|");
		if (isSettledWeek(monday)) return userId ? SETTLED_USER_COSTS_CACHE_TTL_MS : Infinity;
		return userId ? USER_COSTS_CACHE_TTL_MS : PLATFORM_COSTS_CACHE_TTL_MS;
	},
	(key: string) => {
		const [monday, userId] = key.split("|");
		return fetchCostBlock(monday, shiftDate(monday, 6), userId || undefined);
	},
);

/** The Mondays of the weeks covering [startDate, endDate]. */
export function costWeeks(startDate: string, endDate: string): string[] {
	const mondayOffset = (new Date(`${startDate}T00:00:00Z`).getUTCDay() + 6) % 7;
	const mondays = [];
	for (let monday = shiftDate(startDate, -mondayOffset); monday <= endDate; monday = shiftDate(monday, 7)) {
		mondays.push(monday);
	}
	return mondays;
}

/** Resolve with `work`, or with `onTimeout()` if it takes longer than `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the input order. */
async function mapWithConcurrency<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Daily cost/token activity for a date range. Pass `userId` to scope the
 * aggregation to a single user's keys (the individual/home view); omit it for
 * the platform-wide /trends overview.
 */
export async function getCosts(startDate: string, endDate: string, userId?: string): Promise<LitellmCostList> {
	// Independent of each other, so fetched in parallel - the teams and
	// key-owner calls only actually hit the network when their own caches
	// have expired.
	// Once a week fails or the deadline passes the result is an error anyway, so
	// stop starting new weeks rather than queueing more scans upstream.
	let stopped: string | undefined;
	const fetchWeek = async (monday: string): Promise<CostBlock> => {
		if (stopped) return { costs: [], providerCosts: [], error: stopped };
		const block = await getCostWeekCached(costWeekKey(monday, userId));
		stopped ??= block.error;
		return block;
	};
	const [blocks, teamsResult, keyUsersResult] = await Promise.all([
		withDeadline(mapWithConcurrency(costWeeks(startDate, endDate), COSTS_CONCURRENCY, fetchWeek), COSTS_DEADLINE_MS, () => {
			stopped ??= COSTS_DEADLINE_ERROR;
			return [{ costs: [], providerCosts: [], error: COSTS_DEADLINE_ERROR }];
		}),
		getTeams(),
		fetchKeyUserMapCached(),
	]);

	const failed = blocks.find((b) => b.error !== undefined);
	if (failed) {
		return { costs: [], providerCosts: [], error: failed.error };
	}

	// Best-effort: if /team/list is unavailable, fall back to raw team_ids
	// rather than failing the whole cost lookup over a display-only detail.
	const teamNamesById = new Map(teamsResult.teams.map((t) => [t.id, t.name]));
	// Likewise best-effort: if /key/list failed, the map is empty and every
	// user_id is null, so the trends page just can't count distinct people -
	// it still renders everything else rather than erroring the whole page.
	const userByToken = keyUsersResult.userByToken;

	// Weeks overhang the range at both ends, so trim back to it.
	const inRange = (row: { date: string }) => row.date >= startDate && row.date <= endDate;
	const costs = blocks.flatMap((b) => b.costs.filter(inRange)).map((c) => ({
		...c,
		user_id: userByToken.get(c.key_token) ?? null,
		team_name: c.team_id ? teamNamesById.get(c.team_id) ?? c.team_id : "",
	}));
	const providerCosts = blocks.flatMap((b) => b.providerCosts.filter(inRange));

	// Flag a failed key-owner join (not via `error`, since the costs are sound)
	// so the page shows the users count as unavailable rather than a bogus 0.
	return { costs, providerCosts, usersUnavailable: keyUsersResult.error !== undefined };
}

/**
 * Fetch costs for a specific model from the model_groups breakdown.
 * The model_groups key matches the deployment alias (model.name), giving accurate
 * attribution regardless of what model name callers pass in requests.
 *
 * Pass `usagePrefix` for a pass-through service, whose spend is logged under the
 * name the provider reports ("typesafe/jev-1.13.0") rather than the alias.
 *
 * The scan is platform-wide, so results are cached like the platform-wide cost
 * blocks; the team-name join happens per request, as in getCosts.
 */
export async function getModelCosts(
	modelName: string,
	startDate: string,
	endDate: string,
	usagePrefix?: string,
): Promise<{ costs: LitellmCost[]; error?: string }> {
	const match = usagePrefix ? `prefix:${usagePrefix}` : `exact:${modelName}`;
	const [result, teamsResult] = await Promise.all([
		getModelCostsCached(`${match}|${startDate}|${endDate}`),
		getTeams(),
	]);
	if (result.error !== undefined) {
		return { costs: [], error: result.error };
	}
	// Best-effort, mirroring getCosts: if /team/list is unavailable, fall back
	// to raw team_ids rather than failing the whole lookup over display text.
	const teamNamesById = new Map(teamsResult.teams.map((t) => [t.id, t.name]));
	const costs = result.costs.map((c) => ({
		...c,
		team_name: c.team_id ? teamNamesById.get(c.team_id) ?? c.team_id : "",
	}));
	return { costs };
}

const getModelCostsCached = cachedKeyedFetcher(
	PLATFORM_COSTS_CACHE_TTL_MS,
	(key: string): Promise<{ costs: LitellmCost[]; error?: string }> => {
		// "exact:<name>" or "prefix:<prefix>" (model names never contain "|").
		const [match, startDate, endDate] = key.split("|");
		const [kind, value] = [match.slice(0, match.indexOf(":")), match.slice(match.indexOf(":") + 1)];
		return fetchAggregatedGroupCosts(startDate, endDate, (name) =>
			kind === "prefix" ? name.startsWith(value) : name === value,
		);
	},
);

/**
 * Per-key spend/token rows for every `model_groups` entry whose name `matches`,
 * over a date range. The scan is platform-wide, so callers cache it like the
 * cost blocks.
 */
async function fetchAggregatedGroupCosts(
	startDate: string,
	endDate: string,
	matches: (modelName: string) => boolean,
): Promise<{ costs: LitellmCost[]; error?: string }> {
	const { body, error } = await litellmFetch("/user/daily/activity/aggregated", {
		params: { start_date: startDate, end_date: endDate },
		timeoutMs: PLATFORM_COSTS_REQUEST_TIMEOUT_MS,
		expect: (b) => Boolean(b?.results),
	});
	if (error !== undefined) {
		return { costs: [], error };
	}

	const costs: LitellmCost[] = [];
	for (const result of body.results) {
		for (const [modelName, modelGroup] of Object.entries(result.breakdown?.model_groups ?? {}) as Array<[string, any]>) {
			if (!matches(modelName)) continue;

			for (const [token, subValue] of Object.entries(modelGroup.api_key_breakdown || {}) as Array<[string, any]>) {
				// Skip health-check key - it polls every model every 5 minutes
				if (token === HEALTH_CHECK_KEY_TOKEN) continue;
				costs.push({ ...toRawCost(result.date, modelName, token, subValue), user_id: null, team_name: "" });
			}
		}
	}

	return { costs };
}

// Under the platform-wide TTL with room for a slow scan, so the current week
// is refreshed before it ever expires.
const WARM_INTERVAL_MS = PLATFORM_COSTS_CACHE_TTL_MS - 5 * 60 * 1000;
let warmer: ReturnType<typeof setInterval> | undefined;

/**
 * Keep the platform-wide costs for `range()` cached in the background, so no
 * page view waits on a cold scan. Each run refreshes the current week, newest
 * first, and fills in any other week that isn't cached. It warms only the weekly
 * blocks, not the team/owner join, which callers do per request. Returns a
 * function that stops it.
 */
export function startCostsWarmer(range: () => { startDate: string; endDate: string }): () => void {
	if (warmer) return stopCostsWarmer;
	const warm = async () => {
		try {
			const { startDate, endDate } = range();
			const mondays = costWeeks(startDate, endDate).reverse();
			const blocks = await mapWithConcurrency(mondays, COSTS_CONCURRENCY, (monday) =>
				getCostWeekCached(costWeekKey(monday), { refresh: !isSettledWeek(monday) }),
			);
			const failed = blocks.find((b) => b.error !== undefined);
			if (failed) logger.warn({ error: failed.error }, 'Costs cache warm-up failed');
		} catch (e) {
			logger.error({ err: e }, 'Costs cache warm-up threw');
		}
	};
	void warm();
	warmer = setInterval(warm, WARM_INTERVAL_MS);
	warmer.unref();
	return stopCostsWarmer;
}

function stopCostsWarmer(): void {
	clearInterval(warmer);
	warmer = undefined;
}

/**
 * A single model health-check result, normalised from LiteLLM's background
 * health checks (config.yml `background_health_checks`). The proxy runs these
 * every few minutes for every configured model and exposes them via
 * `/health/latest` (most recent per model) and `/health/history` (historical).
 */
export interface LitellmHealthCheck {
	/** The model this check ran against (LiteLLM's model_name / deployment alias). */
	model: string;
	status: "healthy" | "unhealthy";
	/** ISO timestamp of when the check ran. */
	checkedAt: string;
	/** The failure reason, when unhealthy. */
	error?: string;
}

export interface LitellmHealthChecks {
	checks: ReadonlyArray<LitellmHealthCheck>;
	error?: string;
}

/**
 * Normalise one raw LiteLLM health-check record into our shape. The
 * `/health/latest` and `/health/history` responses are undocumented in the
 * OpenAPI spec (empty schema), and field names have drifted across LiteLLM
 * versions, so read each field from the first plausible key rather than
 * trusting one exact name. Records we can't pin a model or timestamp to are
 * dropped by the callers (they return null here).
 */
function normaliseHealthCheck(raw: any, fallbackModel?: string): LitellmHealthCheck | null {
	if (!raw || typeof raw !== "object") return null;

	const model = raw.model_name ?? raw.model ?? raw.model_id ?? raw.deployment ?? fallbackModel;
	if (!model) return null;

	const rawCheckedAt = raw.checked_at ?? raw.timestamp ?? raw.created_at ?? raw.updated_at ?? raw.time;
	if (typeof rawCheckedAt !== "string") return null;
	// Canonicalise to a fixed ISO form so the same instant from two endpoints
	// (e.g. "...:00Z" from /latest vs "...:00.000Z" from /history) produces one
	// key - otherwise dedup misses it and it's double-counted in a bucket.
	const parsedAt = new Date(rawCheckedAt);
	if (Number.isNaN(parsedAt.getTime())) return null;
	const checkedAt = parsedAt.toISOString();

	// Prefer an explicit status field; otherwise infer from an error/unhealthy
	// count. LiteLLM has used both a "healthy"/"unhealthy" string and per-check
	// healthy/unhealthy counts.
	const rawStatus = typeof raw.status === "string" ? raw.status.toLowerCase() : undefined;
	const error = raw.error_message ?? raw.error ?? undefined;
	const unhealthy =
		rawStatus === "unhealthy" ||
		rawStatus === "unhealthy_endpoint" ||
		(rawStatus === undefined && (Number(raw.unhealthy_count) > 0 || Boolean(error)));

	return {
		model: String(model),
		status: unhealthy ? "unhealthy" : "healthy",
		checkedAt,
		error: typeof error === "string" ? error : undefined,
	};
}

/**
 * Pull the list of records out of whatever envelope the endpoint returns - a
 * bare array, `{ history: [...] }` / `{ health_history: [...] }`, or an object
 * keyed by model id (in which case the key is used as the model fallback).
 */
function extractHealthRecords(body: any): Array<{ raw: any; fallbackModel?: string }> {
	if (Array.isArray(body)) return body.map((raw) => ({ raw }));
	if (body && typeof body === "object") {
		const list = body.history ?? body.health_history ?? body.health_checks ?? body.data ?? body.results;
		if (Array.isArray(list)) return list.map((raw) => ({ raw }));
		// Otherwise treat it as a model-keyed map (the /health/latest shape).
		return Object.entries(body).map(([fallbackModel, raw]) => ({ raw, fallbackModel }));
	}
	return [];
}

async function fetchHealth(path: string, params?: Record<string, string>): Promise<LitellmHealthChecks> {
	const { body, error } = await litellmFetch(path, { params });
	if (error !== undefined) {
		return { checks: [], error };
	}

	const checks = extractHealthRecords(body)
		.map(({ raw, fallbackModel }) => normaliseHealthCheck(raw, fallbackModel))
		.filter((c): c is LitellmHealthCheck => c !== null);

	return { checks };
}

// Background health checks only refresh every few minutes, so a short TTL keeps
// the status page cheap without going stale.
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;

// Cap on records paged through, so a long-retained history can't turn one page
// view into an unbounded walk. Paging usually stops earlier at the window edge
// (see fetchModelHealthHistory); this only bites on far-over-retained history.
// Sized for the widest case: one model's 90-day detail view (~26k records at
// the ~5-min cadence), which also covers the list's unscoped 24-hour window.
const HEALTH_HISTORY_PAGE_SIZE = 1000;
const HEALTH_HISTORY_MAX_RECORDS = 30000;

/** The most recent health check for every model. */
export const getModelHealthLatest = cachedFetcher(HEALTH_CACHE_TTL_MS, () => fetchHealth("/health/latest"));

/**
 * Health-check history back to `sinceIso`. LiteLLM has no date-range filter on
 * `/health/history`, so we page it and enforce the window client-side, stopping
 * at the window edge or the record cap.
 *
 * The early-stop assumes newest-first ordering (undocumented, but how it pages
 * in practice); if that broke, the cap bounds the walk and the final
 * `checkedAt >= sinceIso` filter still keeps the result correct. Passing
 * `model` scopes the fetch to one model (the detail page's 90-day window).
 */
async function fetchModelHealthHistory(sinceIso: string, model?: string): Promise<LitellmHealthChecks> {
	const checks: LitellmHealthCheck[] = [];
	let offset = 0;

	while (offset < HEALTH_HISTORY_MAX_RECORDS) {
		const page = await fetchHealth("/health/history", {
			limit: String(HEALTH_HISTORY_PAGE_SIZE),
			offset: String(offset),
			...(model ? { model } : {}),
		});
		if (page.error !== undefined) {
			// Surface the error only if we have nothing yet; otherwise return what
			// we did manage to read so a late-page failure still renders a partial
			// (older-buckets-grey) timeline.
			return checks.length === 0 ? { checks: [], error: page.error } : { checks };
		}
		if (page.checks.length === 0) break;

		checks.push(...page.checks);

		// The oldest record on this page predates the window - no need to page
		// further. ISO strings compare chronologically, so a direct compare works.
		const oldest = page.checks.reduce((min, c) => (c.checkedAt < min ? c.checkedAt : min), page.checks[0].checkedAt);
		if (oldest < sinceIso) break;
		if (page.checks.length < HEALTH_HISTORY_PAGE_SIZE) break;

		offset += HEALTH_HISTORY_PAGE_SIZE;
	}

	return { checks: checks.filter((c) => c.checkedAt >= sinceIso) };
}

// Keyed by "<sinceIso>|<model>" so the shared list-page window and any
// per-model detail-page fetch cache independently.
const getModelHealthHistoryCached = cachedKeyedFetcher(HEALTH_CACHE_TTL_MS, (key: string) => {
	const [sinceIso, model] = key.split("|");
	return fetchModelHealthHistory(sinceIso, model || undefined);
});

export async function getModelHealthHistory(sinceIso: string, model?: string): Promise<LitellmHealthChecks> {
	return getModelHealthHistoryCached(`${sinceIso}|${model ?? ""}`);
}
