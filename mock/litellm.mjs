/**
 * Minimal mock LiteLLM proxy for local development, testing and demos.
 *
 * Implements just the handful of endpoints the frontend calls, returning
 * canned fixture data so you can run the app end to end without the real
 * gateway. The production clients in src/lib/litellm.ts and litellmKeys.ts run
 * unchanged against it - only the data is fake.
 *
 * Usage (two terminals, from frontend/):
 *   1) LITELLM_URL=http://localhost:4141 LITELLM_MASTER_KEY=dev npm run mock:litellm
 *   2) LITELLM_URL=http://localhost:4141 LITELLM_MASTER_KEY=dev npm run dev
 * Any user email logs in as the same demo user, so LOCAL_USER_EMAIL can be anything.
 *
 * Everything here is fixture data. Do not wire this into production.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_LITELLM_PORT) || 4141;

const USER_ID = "u-demo";

// A day in ms, and a helper for expiry/reset dates relative to "now".
const DAY = 86_400_000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const ymd = (date) => date.toISOString().slice(0, 10);

// Three keys with a deliberate mix: one that never expires, one expiring very
// soon (shows the red/amber countdown), and one team key expiring later.
const KEYS = [
	{ token: "sk-demo-default", key_alias: "personal/demo@example.gov.uk/default", expires: null, team_id: null },
	{ token: "sk-demo-batch", key_alias: "personal/demo@example.gov.uk/batch-eval", expires: iso(2 * DAY), team_id: null },
	{ token: "sk-demo-proto", key_alias: "policy-team/demo@example.gov.uk/prototyping", expires: iso(40 * DAY), team_id: "t-policy" },
];

const TEAMS = [
	{ team_id: "t-policy", team_alias: "policy-team" },
	{ team_id: "t-data", team_alias: "data-science" },
];

// User-level budget bucket shared across the keys (matches the app's defaults).
const USER_INFO = {
	user_id: USER_ID,
	user_email: "demo@example.gov.uk",
	spend: 1487.23,
	max_budget: 4000,
	budget_duration: "30d",
	budget_reset_at: iso(16 * DAY),
	tpm_limit: 10_000_000,
	rpm_limit: 5_000,
};

const MODELS = [
	model("claude-opus-4-6", "bedrock/eu.anthropic.claude-opus-4-6-v1", "chat", {
		max_input_tokens: 200_000, max_output_tokens: 64_000,
		input_cost_per_token: 0.000015, output_cost_per_token: 0.000075,
		supports_vision: true, supports_function_calling: true, supports_reasoning: true,
		lab: "Anthropic", country_of_origin: "US", open_weight: false,
		impact_model: "anthropic/claude-opus-4-6",
		description: "Most capable Claude model, for hard reasoning and agentic work.",
		uri: "https://example.com/models/claude-opus-4-6",
		location: "EU",
	}),
	model("claude-sonnet-4-6", "bedrock/eu.anthropic.claude-sonnet-4-6", "chat", {
		max_input_tokens: 200_000, max_output_tokens: 64_000,
		input_cost_per_token: 0.000003, output_cost_per_token: 0.000015,
		supports_vision: true, supports_function_calling: true, supports_reasoning: true,
		lab: "Anthropic", country_of_origin: "US", open_weight: false,
		impact_model: "anthropic/claude-sonnet-4-6",
		description: "Balanced Claude model for everyday tasks.",
		uri: "https://example.com/models/claude-sonnet-4-6",
		location: "UK",
	}),
	model("gpt-4o", "openai/gpt-4o", "chat", {
		max_input_tokens: 128_000, max_output_tokens: 16_000,
		input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001,
		supports_vision: true, supports_function_calling: true, supports_reasoning: false,
		lab: "OpenAI", country_of_origin: "US", open_weight: false,
		impact_model: "openai/gpt-4o",
		description: "General-purpose multimodal model.",
		uri: "https://example.com/models/gpt-4o",
		location: "US",
	}),
	// Open weights with no ecologits registry entry: the impact estimate falls back to `parameters`.
	model("kimi-k2.5", "bedrock/moonshotai.kimi-k2.5", "chat", {
		max_input_tokens: 256_000, max_output_tokens: 32_000,
		input_cost_per_token: 0.0000006, output_cost_per_token: 0.0000025,
		supports_vision: true, supports_function_calling: true, supports_reasoning: true,
		lab: "Moonshot AI", country_of_origin: "CN", open_weight: true,
		parameters: { total: 1000, active: 32, source: "https://huggingface.co/moonshotai/Kimi-K2.5" },
		description: "Open-weight agentic model served from Bedrock.",
		uri: "https://example.com/models/kimi-k2.5",
		location: "UK",
	}),
	model("titan-embed-text", "bedrock/amazon.titan-embed-text-v2:0", "embedding", {
		input_cost_per_token: 0.0000001,
		lab: "Amazon", country_of_origin: "US", open_weight: false,
		description: "Text embeddings.",
	}),
];

// `upstream` is the id LiteLLM routes to, in the real gateway's shape, so the
// impact estimate (impact.ts) resolves fixtures like production models.
function model(name, upstream, mode, info) {
	return {
		model_name: name,
		litellm_params: { model: upstream },
		model_info: {
			id: name,
			litellm_provider: upstream.split("/")[0],
			mode,
			supports_vision: false,
			supports_function_calling: false,
			supports_audio_input: false,
			supports_reasoning: false,
			...info,
		},
	};
}

// Which backend serves each model, so the daily activity can group the same
// usage by provider (the "By provider" tab) as well as by model.
const MODEL_PROVIDER = Object.fromEntries(MODELS.map((m) => [m.model_name, m.model_info.litellm_provider]));
// Pass-through usage (Jev, Tavily) is not in MODELS. These names must match the
// `usagePrefix` values in src/lib/passThroughModels.ts; both are unverified
// against a live gateway, so adjust the two together once checked.
const JEV_GROUP = "typesafe/jev-1.13.0";
const TAVILY_GROUP = "tavily";
MODEL_PROVIDER[JEV_GROUP] = "typesafe";
MODEL_PROVIDER[TAVILY_GROUP] = "tavily";
// The real endpoint keys `breakdown.models` by the underlying model id without
// its route ("eu.anthropic.claude-opus-4-6-v1"), and `breakdown.model_groups` by
// the alias. Mirror that, so anything joining cost rows to models is exercised
// the way production exercises it.
const MODEL_UPSTREAM_ID = Object.fromEntries(MODELS.map((m) => [m.model_name, m.litellm_params.model.split("/").slice(1).join("/")]));
MODEL_UPSTREAM_ID[JEV_GROUP] = "jev-1.13.0";
MODEL_UPSTREAM_ID[TAVILY_GROUP] = "tavily";

// Which key uses which model, and roughly how busy it is. Drives the usage
// charts, per-key sparklines and top-models list. The first three keys belong
// to the signed-in demo user (they back the home-page "Your usage" view); the
// rest belong to other users, several of them onboarding partway through the
// window (activeFromDays), so the platform-wide trends page shows the active
// user/key counts growing over time rather than sitting flat.
const USAGE_PROFILE = [
	{ token: "sk-demo-default", alias: KEYS[0].key_alias, team_id: "", models: { "claude-opus-4-6": 1, "claude-sonnet-4-6": 0.6 }, base: 220 },
	{ token: "sk-demo-batch", alias: KEYS[1].key_alias, team_id: "", models: { "gpt-4o": 1 }, base: 40, sporadic: true },
	{ token: "sk-demo-proto", alias: KEYS[2].key_alias, team_id: "t-policy", models: { "claude-sonnet-4-6": 1, "gpt-4o": 0.4, [TAVILY_GROUP]: 0.3 }, base: 90 },
	{ token: "sk-bob", alias: "personal/bob@example.gov.uk/default", team_id: "", models: { "claude-sonnet-4-6": 1 }, base: 70 },
	{ token: "sk-carol", alias: "policy-team/carol@example.gov.uk/research", team_id: "t-policy", models: { "claude-opus-4-6": 1, "gpt-4o": 0.5 }, base: 130, activeFromDays: 60 },
	{ token: "sk-dave", alias: "data-science/dave@example.gov.uk/pipeline", team_id: "t-data", models: { "gpt-4o": 1, [JEV_GROUP]: 0.6 }, base: 55, sporadic: true, activeFromDays: 35 },
	{ token: "sk-erin", alias: "personal/erin@example.gov.uk/default", team_id: "", models: { "claude-sonnet-4-6": 1, "claude-opus-4-6": 0.3 }, base: 60, activeFromDays: 14 },
];

// Which user_id owns each key, so /key/list can back the token->user_id join
// the trends page uses to count distinct *people*. The demo user holds three
// keys; the rest are one-per-person. Tokens match USAGE_PROFILE so the join
// lines up with the activity data.
const KEY_OWNERS = {
	"sk-demo-default": USER_ID,
	"sk-demo-batch": USER_ID,
	"sk-demo-proto": USER_ID,
	"sk-bob": "u-bob",
	"sk-carol": "u-carol",
	"sk-dave": "u-dave",
	"sk-erin": "u-erin",
};

// The /key/list shape fetchKeyUserMap() walks: one full-object row per key with
// its hash token, owning user_id and team_id, plus the pagination envelope.
function keyList() {
	const keys = USAGE_PROFILE.map((entry) => ({
		token: entry.token,
		user_id: KEY_OWNERS[entry.token] ?? null,
		team_id: entry.team_id || null,
		key_alias: entry.alias,
	}));
	return { keys, total_count: keys.length, total_pages: 1, current_page: 1 };
}

// Deterministic per-(date,key,model) pseudo-randomness so the fixture is stable
// across reloads. Small integer hash -> mulberry32.
function rand(seedStr) {
	let h = 1779033703 ^ seedStr.length;
	for (let i = 0; i < seedStr.length; i++) {
		h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h >>> 0;
	a |= 0; a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// One day's activity for one key+model: requests, tokens, spend, failures, plus
// the token split and prompt-cache breakdown the "Your usage" tabs read. Two
// invariants match what the app assumes: prompt + completion always sums to
// total_tokens, and cache reads + writes stay within prompt (input) tokens.
function metricsFor(date, entry, modelName, weight) {
	// Users who onboarded partway through the window have no activity before then.
	if (entry.activeFromDays !== undefined && Date.parse(`${date}T00:00:00Z`) < Date.now() - entry.activeFromDays * DAY) return null;
	const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
	const weekend = dow === 0 || dow === 6 ? 0.35 : 1; // quieter weekends
	const noise = 0.6 + rand(`${date}:${entry.token}:${modelName}`) * 0.8;
	if (entry.sporadic && rand(`skip:${date}:${entry.token}`) < 0.55) return null; // some quiet days
	const requests = Math.round(entry.base * weight * weekend * noise);
	if (requests <= 0) return null;
	const tokensPerReq = 400 + Math.round(rand(`tok:${date}:${entry.token}:${modelName}`) * 3600);
	const total_tokens = requests * tokensPerReq;
	const pricePerToken = modelName.includes("opus") ? 0.00004 : modelName.includes("gpt") ? 0.000012 : 0.000009;
	const spend = Number((total_tokens * pricePerToken).toFixed(4));
	const failed_requests = rand(`fail:${date}:${entry.token}:${modelName}`) < 0.25 ? Math.max(1, Math.round(requests * 0.03)) : 0;
	// Input/output split: most tokens are prompt (input), the remainder output.
	const prompt_tokens = Math.round(total_tokens * (0.65 + rand(`split:${date}:${entry.token}:${modelName}`) * 0.15));
	const completion_tokens = total_tokens - prompt_tokens;
	// Prompt caching: Claude models cache heavily, gpt lightly, embeddings not at
	// all. Reads and writes are subsets of prompt tokens, so their sum stays well
	// under prompt_tokens.
	const cacheRate = modelName.includes("claude") ? 0.55 : modelName.includes("gpt") ? 0.2 : 0;
	const cache_read_input_tokens = Math.round(prompt_tokens * cacheRate * (0.5 + rand(`cr:${date}:${entry.token}:${modelName}`) * 0.5));
	const cache_creation_input_tokens = Math.round(prompt_tokens * cacheRate * 0.15 * rand(`cc:${date}:${entry.token}:${modelName}`));
	return { spend, total_tokens, prompt_tokens, completion_tokens, cache_read_input_tokens, cache_creation_input_tokens, api_requests: requests, failed_requests };
}

// Build the /user/daily/activity/aggregated response for a date range, in the
// nested shape fetchCosts() parses: results[].breakdown.models[].api_key_breakdown[]
// keyed by underlying model id, results[].breakdown.model_groups[] keyed by alias,
// and the parallel results[].breakdown.providers[].api_key_breakdown[] cut of
// the same usage grouped by backend provider.
function dailyActivity(startDate, endDate) {
	const results = [];
	const day = new Date(`${startDate}T00:00:00Z`);
	const end = new Date(`${endDate}T00:00:00Z`);
	while (day <= end) {
		const date = ymd(day);
		const models = {};
		const model_groups = {};
		const providers = {};
		for (const entry of USAGE_PROFILE) {
			for (const [modelName, weight] of Object.entries(entry.models)) {
				const metrics = metricsFor(date, entry, modelName, weight);
				if (!metrics) continue;
				const row = { metrics, metadata: { key_alias: entry.alias, team_id: entry.team_id } };
				(models[MODEL_UPSTREAM_ID[modelName]] ??= { api_key_breakdown: {} }).api_key_breakdown[entry.token] = row;
				(model_groups[modelName] ??= { api_key_breakdown: {} }).api_key_breakdown[entry.token] = row;
				// Same usage, grouped by provider: fold each key's models that
				// share a backend into one per-(provider, key) row.
				const provider = MODEL_PROVIDER[modelName] ?? "unknown";
				const pBucket = (providers[provider] ??= { api_key_breakdown: {} });
				const pRow = (pBucket.api_key_breakdown[entry.token] ??= {
					metrics: { spend: 0, total_tokens: 0, api_requests: 0, failed_requests: 0 },
					metadata: { key_alias: entry.alias, team_id: entry.team_id },
				});
				pRow.metrics.spend = Number((pRow.metrics.spend + metrics.spend).toFixed(4));
				pRow.metrics.total_tokens += metrics.total_tokens;
				pRow.metrics.api_requests += metrics.api_requests;
				pRow.metrics.failed_requests += metrics.failed_requests;
			}
		}
		results.push({ date, breakdown: { models, model_groups, providers } });
		day.setUTCDate(day.getUTCDate() + 1);
	}
	return { results };
}

// Synthetic per-model health-check history for the model status timeline.
// LiteLLM's background health checks probe every model on a timer; we fake ~90
// days of them at an hourly cadence, with gpt-4o given a couple of rough days
// (an outage and some degraded days) so the down-detector bars, banner and
// tooltips have something to show across both the hourly (24h) and daily (7d/
// 90d) views. Deterministic via the same rand() seed as usage.
const HEALTH_MODELS = MODELS.map((m) => m.model_name);
const HEALTH_DAYS = 90;
const CHECKS_PER_DAY = 24;

// Whether a given model/day is a clean day, a partial degradation, or a full
// outage. gpt-4o is the deliberately flaky one; the rest only blip rarely.
function dayIncident(model, date) {
	const r = rand(`incident:${model}:${date}`);
	if (model === "gpt-4o") {
		if (r < 0.04) return "outage";
		if (r < 0.12) return "degraded";
	} else if (r < 0.01) {
		return "outage";
	} else if (r < 0.04) {
		return "degraded";
	}
	return "operational";
}

// Every check across the window, newest first. One record per (model, day,
// check), matching the fields the frontend normaliser reads. The dataset is
// deterministic per UTC day, so it's built once and reused across the several
// paged /health/history requests a single page load makes.
let healthCache = { base: null, records: null };
function healthRecords() {
	const now = new Date();
	const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	if (healthCache.base === base) return healthCache.records;
	const records = [];
	for (const model of HEALTH_MODELS) {
		for (let d = 0; d < HEALTH_DAYS; d++) {
			const dayMs = base - d * DAY;
			const date = ymd(new Date(dayMs));
			const incident = dayIncident(model, date);
			for (let c = 0; c < CHECKS_PER_DAY; c++) {
				const checkedAt = new Date(dayMs + c * (DAY / CHECKS_PER_DAY)).toISOString();
				const unhealthy =
					incident === "outage" || (incident === "degraded" && rand(`chk:${model}:${date}:${c}`) < 0.4);
				records.push({
					model_name: model,
					status: unhealthy ? "unhealthy" : "healthy",
					checked_at: checkedAt,
					error_message: unhealthy ? "Health check failed: upstream timeout" : null,
				});
			}
		}
	}
	records.sort((a, b) => (a.checked_at < b.checked_at ? 1 : -1));
	healthCache = { base, records };
	return records;
}

// --- routing ---------------------------------------------------------------

const routes = {
	"GET /health/readiness": () => ({ status: "connected", db: "connected", healthy: true }),
	// Most recent check per model (array shape), and the paged full history.
	"GET /health/latest": () => {
		const latest = {};
		for (const r of healthRecords()) if (!(r.model_name in latest)) latest[r.model_name] = r;
		return Object.values(latest);
	},
	"GET /health/history": (url) => {
		const model = url.searchParams.get("model");
		// The detail page scopes history to one model via ?model=; honour it so
		// its paging covers that model's full window.
		const all = model ? healthRecords().filter((r) => r.model_name === model) : healthRecords();
		const limit = Number(url.searchParams.get("limit")) || 1000;
		const offset = Number(url.searchParams.get("offset")) || 0;
		return { history: all.slice(offset, offset + limit), total: all.length };
	},
	"GET /v2/model/info": () => ({ data: MODELS, current_page: 1, total_pages: 1 }),
	"GET /v2/team/list": () => ({ teams: TEAMS }),
	"GET /user/list": () => ({ users: [{ user_id: USER_ID }] }),
	"GET /user/info": () => ({ user_id: USER_ID, user_info: USER_INFO, keys: KEYS, teams: TEAMS }),
	"GET /user/daily/activity/aggregated": (url) =>
		dailyActivity(url.searchParams.get("start_date"), url.searchParams.get("end_date")),
	"GET /key/list": () => keyList(),
	// Write endpoints: enough to let the key generate/delete flows succeed.
	"POST /user/new": () => ({ user_id: USER_ID }),
	"POST /user/update": () => ({ user_id: USER_ID }),
	"POST /key/generate": () => ({ key: `sk-demo-${Math.random().toString(36).slice(2, 10)}` }),
	"POST /key/delete": () => ({ deleted_keys: [] }),
	// Model search: page extract via the /tavily pass-through, then chat.
	"POST /tavily/extract": (_url, body) => ({
		results: (body?.urls ?? []).map((u) => ({ url: u, raw_content: `Documentation page for ${u.split("/").pop()}.` })),
		failed_results: [],
	}),
	"POST /v1/chat/completions": (_url, body) => chatReply(body),
};

// Every call is constrained to a named JSON schema (response_format); reply in that shape.
function chatReply(body) {
	const user = body?.messages?.find((m) => m.role === "user")?.content ?? "";
	const schema = body?.response_format?.json_schema?.name;
	const replies = {
		model_details: () => {
			const alias = /Model alias: (\S+)/.exec(user)?.[1] ?? "model";
			return {
				page_matches_model: true,
				summary: `${alias} is a mock model used for local development.`,
				best_for: alias.includes("opus") ? ["coding agents", "hard reasoning"] : ["everyday tasks", "summarisation"],
				context_window: 200000,
				knowledge_cutoff: "2025-03",
				benchmarks: [{ name: "SWE-bench Verified", score: "70%" }],
			};
		},
		arena_matches: () => ({ matches: [] }),
		model_suggestions: () => ({
			suggestions: [
				{ name: "claude-opus-4-6", reason: `Strongest mock model for "${user}".`, evidence: [] },
				{ name: "claude-sonnet-4-6", reason: "Cheaper alternative with good quality.", evidence: [] },
				{ name: "not-a-real-model", reason: "Should be dropped by validation.", evidence: [] },
			],
		}),
	};
	const reply = (replies[schema] ?? replies.model_suggestions)();
	return { choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] };
}

createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const handler = routes[`${req.method} ${url.pathname}`];
	res.setHeader("Content-Type", "application/json");
	if (!handler) {
		res.statusCode = 404;
		res.end(JSON.stringify({ error: `mock: no route for ${req.method} ${url.pathname}` }));
		return;
	}
	// Most fixtures ignore the body; the model search routes read it.
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		try {
			let body;
			try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
			res.statusCode = 200;
			res.end(JSON.stringify(handler(url, body)));
		} catch (e) {
			res.statusCode = 500;
			res.end(JSON.stringify({ error: String(e) }));
		}
	});
}).listen(PORT, () => {
	console.log(`mock LiteLLM listening on http://localhost:${PORT}`);
	console.log(`point the app at it:  LITELLM_URL=http://localhost:${PORT} LITELLM_MASTER_KEY=dev npm run dev`);
});
