/**
 * Environmental impact estimates for gateway usage, computed at read time from
 * the daily cost rows LiteLLM already keeps (see ADR-0005). Impact is a pure
 * function of the model, the output tokens and the electricity mix where the
 * model runs, so nothing needs to happen in the request path: each cost row is
 * resolved to an ecologits model and zone, estimated, and summed.
 *
 * ecologits returns a min/max range per metric, not a point, so every figure
 * here carries both bounds. Kept free of fetch/DOM code so it can be unit tested
 * like trends.ts and usage.ts.
 */
import { llmImpacts, logger as ecologitsLogger, models as ecologitsModels, type ValueOrRange } from "@ecologits/ecologits.js";
import type { LitellmCost, LitellmModel, ModelParameters } from "./litellm";
import { logger } from "./logging";
import { GRANULARITY_DAYS, chunk, type Granularity } from "./usage";

// ecologits warns once per model whose architecture is undisclosed. That is
// most hosted models, so route it to debug rather than the console.
ecologitsLogger.setSink((level, message) => {
	if (level === "error") logger.warn({ source: "ecologits" }, message);
	else logger.debug({ source: "ecologits" }, message);
});

/** A min/max interval. */
export interface Range {
	min: number;
	max: number;
}

const ZERO_RANGE: Range = { min: 0, max: 0 };

function toRange(value: ValueOrRange): Range {
	return typeof value === "number" ? { min: value, max: value } : { min: value.min, max: value.max };
}

function addRange(a: Range, b: Range): Range {
	return { min: a.min + b.min, max: a.max + b.max };
}

/** Midpoint of a range, for charts and compact tiles that can only show one number. */
export function rangeMid(r: Range): number {
	return (r.min + r.max) / 2;
}

/** The ecologits lookup a gateway model resolves to. */
export interface ImpactModel {
	/** ecologits provider id, e.g. "anthropic". */
	provider: string;
	/** ecologits model name, e.g. "claude-opus-4-7". */
	modelName: string;
	/** ISO 3166-1 alpha-3 electricity mix zone. */
	zone: string;
	/** Set when the architecture came from config.yml rather than the registry. */
	parameters?: ModelParameters;
}

/** Why a model has no estimate. */
export type ImpactUnresolvedReason = "not-generation" | "not-in-registry";

export type ImpactResolution = { ok: true; model: ImpactModel } | { ok: false; reason: ImpactUnresolvedReason };

/** The config fields resolution reads. */
export type ImpactSource = Pick<LitellmModel, "litellm_model" | "mode" | "location" | "parameters" | "impact_model" | "impact_zone">;

/** Call types ecologits models: text generation. Embeddings and audio have no output tokens to speak of. */
const GENERATION_MODES = new Set(["chat", "completion", "responses"]);

/** Split "route/rest" on the first slash; a bare id has no route. */
function splitRoute(id: string): { route: string; rest: string } {
	const slash = id.indexOf("/");
	return slash < 0 ? { route: "", rest: id } : { route: id.slice(0, slash), rest: id.slice(slash + 1) };
}

/** Coarse `location` label to zone, where no EU route applies. */
const LOCATION_ZONES: Record<string, string> = { UK: "GBR", US: "USA", Global: "WOR" };

/**
 * "EU" depends on the route, because each cloud's EU deployment is in a
 * different country: Azure OpenAI in Sweden Central, Vertex in europe-west1
 * (Belgium). Bedrock eu.* inference profiles are cross-region by design, so
 * eu-west-1 (Ireland) is an anchor rather than a fact.
 */
const EU_ZONES: Record<string, string> = { azure: "SWE", vertex_ai: "BEL", vertex_ai_beta: "BEL", bedrock: "IRL" };
const EU_DEFAULT_ZONE = "SWE";
const WORLD_ZONE = "WOR";

/** The zone a deployment runs on, from its location and, for the EU, its route. */
export function deriveImpactZone(model: Pick<ImpactSource, "litellm_model" | "location">): string {
	if (model.location === "EU") return EU_ZONES[splitRoute(model.litellm_model).route] ?? EU_DEFAULT_ZONE;
	return LOCATION_ZONES[model.location ?? ""] ?? WORLD_ZONE;
}

/**
 * ecologits keys data centre efficiency (PUE, water) on the provider. None of
 * its providers is "served from Bedrock" or "served from Doubleword", so models
 * built from config.yml parameters use huggingface_hub, whose figures are a
 * neutral range rather than one vendor's own sites. The zone we pass overrides
 * its default location.
 */
const PARAMETERS_PROVIDER = "huggingface_hub";

/**
 * Register a model with ecologits from its declared size, so the estimate uses
 * the same architecture arithmetic as a registry entry. The "gateway/" prefix on
 * the full LiteLLM id keeps these apart from the real huggingface_hub entries,
 * which the idempotency check would otherwise silently adopt. The registry lives
 * for the process, so a change to `parameters` in config.yml takes effect on
 * restart.
 */
function registerFromParameters(litellmModel: string, parameters: ModelParameters): string {
	const name = `gateway/${litellmModel}`;
	if (!ecologitsModels.findModel(PARAMETERS_PROVIDER, name)) {
		ecologitsModels.addModel({
			provider: PARAMETERS_PROVIDER,
			name,
			architecture:
				parameters.active !== undefined
					? { type: "moe", parameters: { total: parameters.total, active: parameters.active } }
					: { type: "dense", parameters: parameters.total },
			warnings: null,
			sources: parameters.source ? [parameters.source] : null,
			deployment: null,
		});
	}
	return name;
}

/**
 * Resolve a gateway model to its ecologits lookup from what config.yml declares:
 * the `impact_model` on every closed generation model, or the `parameters` on
 * every open-weight one. Parameters win over the registry entry that shares the
 * model's name because a registry entry carries the vendor's own deployment speed
 * and data centre figures, and an open-weight model served from Bedrock or
 * Doubleword runs on neither. Returns the reason when no estimate is possible.
 */
export function resolveImpactModel(model: ImpactSource): ImpactResolution {
	if (model.mode && !GENERATION_MODES.has(model.mode)) return { ok: false, reason: "not-generation" };
	const zone = model.impact_zone ?? deriveImpactZone(model);
	if (model.parameters) {
		const modelName = registerFromParameters(model.litellm_model, model.parameters);
		return { ok: true, model: { provider: PARAMETERS_PROVIDER, modelName, zone, parameters: model.parameters } };
	}
	if (model.impact_model) {
		const { route: provider, rest: modelName } = splitRoute(model.impact_model);
		if (!provider || !ecologitsModels.findModel(provider, modelName)) return { ok: false, reason: "not-in-registry" };
		return { ok: true, model: { provider, modelName, zone } };
	}
	return { ok: false, reason: "not-in-registry" };
}

/** The per-metric estimate for some usage. Water is not aggregated, so it lives on ReferenceImpact. */
export interface ImpactEstimate {
	/** Greenhouse gas emissions, kg CO2 equivalent. */
	gwpKg: Range;
	/** Energy consumed, kWh. */
	energyKwh: Range;
}

/**
 * One model's estimate as the model page shows it. Water is included only here:
 * nothing aggregates it, so it never reads as an aggregated zero, and it is null
 * when ecologits has no water figure for the model.
 */
export interface ReferenceImpact extends ImpactEstimate {
	waterL: Range | null;
}

const ZERO_ESTIMATE: ImpactEstimate = { gwpKg: ZERO_RANGE, energyKwh: ZERO_RANGE };

function addEstimate(a: ImpactEstimate, b: ImpactEstimate): ImpactEstimate {
	return { gwpKg: addRange(a.gwpKg, b.gwpKg), energyKwh: addRange(a.energyKwh, b.energyKwh) };
}

/**
 * Estimate the impact of `requests` generations producing `outputTokens` in
 * total. ecologits models one request at a time as a small fixed cost plus a
 * per-token cost, so N requests of the average size reproduce the exact sum of
 * N individually estimated requests. Latency is left unbounded: it only lowers
 * the estimate for unusually fast responses, and the daily aggregate has none.
 */
export function estimateImpact(model: ImpactModel, outputTokens: number, requests: number): ReferenceImpact {
	const n = Math.max(1, requests);
	const out = llmImpacts({
		provider: model.provider,
		modelName: model.modelName,
		outputTokenCount: outputTokens / n,
		requestLatency: Number.POSITIVE_INFINITY,
		electricityMixZone: model.zone,
	});
	if (!out.gwp || !out.energy) return { ...ZERO_ESTIMATE, waterL: null };
	const scale = (r: Range): Range => ({ min: r.min * n, max: r.max * n });
	return {
		gwpKg: scale(toRange(out.gwp.value)),
		energyKwh: scale(toRange(out.energy.value)),
		waterL: out.wcf ? scale(toRange(out.wcf.value)) : null,
	};
}

/** Reference figure for a model page: one request of this many output tokens. */
export const REFERENCE_OUTPUT_TOKENS = 1_000;

/**
 * Cost-row model name to its resolution. LiteLLM's daily activity keys the
 * `models` breakdown by the underlying model id without its route prefix
 * ("gpt-4o", "eu.anthropic.claude-opus-4-7"), and only the `model_groups`
 * breakdown by the alias ("gpt-4o-uk"), so each deployment is indexed under
 * the alias, the full LiteLLM id and the id without its route. Several
 * deployments can share an id with different locations (a UK+Sweden pair);
 * the row cannot say which served it, so the first deployment listed stands
 * for all of them.
 */
export type ImpactIndex = ReadonlyMap<string, ImpactResolution>;

export function buildImpactIndex(models: ReadonlyArray<LitellmModel>): ImpactIndex {
	const index = new Map<string, ImpactResolution>();
	for (const m of models) {
		// A bare id with no route yields the same string twice and an id of "" yields
		// empty keys; the Set and the filter drop both, leaving distinct, real keys.
		const keys = [...new Set([m.name, m.litellm_model, splitRoute(m.litellm_model).rest])].filter((k) => k !== "");
		// First deployment wins per key. A later deployment sharing an underlying id
		// but not an alias still gets its own alias key, so a row keyed by alias
		// resolves to it, while rows keyed by the shared id keep the first.
		if (keys.every((k) => index.has(k))) continue;
		const resolution = resolveImpactModel(m);
		for (const k of keys) if (!index.has(k)) index.set(k, resolution);
	}
	return index;
}

/** A day's estimate, with how much of that day's output the estimate covers. */
export interface DailyImpact extends ImpactEstimate {
	date: string;
	/** Output tokens that were estimated. */
	estimatedTokens: number;
	/** All output tokens that day, estimated or not. */
	totalTokens: number;
}

const zeroDay = (date: string): DailyImpact => ({ ...ZERO_ESTIMATE, date, estimatedTokens: 0, totalTokens: 0 });

/**
 * The estimate per day over `dates` (oldest first), zero-filled. One pass over
 * the cost rows serves the tiles, the chart and the CSV: callers slice and sum
 * the days they need. Rows whose model has no estimate still count towards
 * `totalTokens`, so partial coverage is visible rather than reading as zero.
 * Only successful requests count as generations; failed ones produced nothing.
 */
export function impactPerDay(costs: ReadonlyArray<LitellmCost>, index: ImpactIndex, dates: ReadonlyArray<string>): DailyImpact[] {
	const byDate = new Map(dates.map((d) => [d, zeroDay(d)]));
	for (const c of costs) {
		const day = byDate.get(c.date);
		if (!day) continue;
		const res = index.get(c.model_name);
		const estimated = res?.ok && c.completion_tokens > 0;
		const e = estimated ? estimateImpact(res.model, c.completion_tokens, Math.max(1, c.api_requests - c.failed_requests)) : ZERO_ESTIMATE;
		byDate.set(c.date, {
			...addEstimate(day, e),
			date: day.date,
			totalTokens: day.totalTokens + c.completion_tokens,
			estimatedTokens: day.estimatedTokens + (estimated ? c.completion_tokens : 0),
		});
	}
	return dates.map((d) => byDate.get(d)!);
}

/** Window totals from a daily series, as the tiles and caption need them. */
export type ImpactTotals = Omit<DailyImpact, "date">;

export function sumImpact(days: ReadonlyArray<DailyImpact>): ImpactTotals {
	return days.reduce<ImpactTotals>(
		(acc, d) => ({ ...addEstimate(acc, d), estimatedTokens: acc.estimatedTokens + d.estimatedTokens, totalTokens: acc.totalTokens + d.totalTokens }),
		{ ...ZERO_ESTIMATE, estimatedTokens: 0, totalTokens: 0 },
	);
}

/** Share of output tokens covered by an estimate, 0 to 100. 100 when there were none. */
export function coveragePct(totals: Pick<ImpactTotals, "estimatedTokens" | "totalTokens">): number {
	return totals.totalTokens > 0 ? (totals.estimatedTokens / totals.totalTokens) * 100 : 100;
}

/** Sum a daily series into buckets at `granularity`, matching buildTrends. */
export function bucketImpact(daily: ReadonlyArray<ImpactEstimate>, granularity: Granularity): ImpactEstimate[] {
	return chunk(daily, GRANULARITY_DAYS[granularity]).map((group) => group.reduce(addEstimate, ZERO_ESTIMATE));
}

/** Plain-English reason a model has no estimate. */
export function unresolvedLabel(reason: ImpactUnresolvedReason): string {
	return reason === "not-generation"
		? "Not applicable: this model does not generate text."
		: "Not available: this model is not in the ecologits registry and its size is not published.";
}

/** The electricity mix zones this module can produce, as readable grid names. */
const ZONE_NAMES: Record<string, string> = {
	GBR: "UK grid",
	IRL: "Irish grid",
	SWE: "Swedish grid",
	BEL: "Belgian grid",
	USA: "US grid",
	WOR: "world average grid",
};

/** "UK grid", or the raw code for a zone set by hand that has no name here. */
export function zoneLabel(zone: string): string {
	return ZONE_NAMES[zone] ?? `${zone} grid`;
}

/** A number in en-GB style ("1,000", "2.5") with at most `digits` decimals. */
const num = (n: number, digits: number) => n.toLocaleString("en-GB", { maximumFractionDigits: digits });

/**
 * A formatter that picks the largest unit the value reaches. `steps` run from
 * the largest unit down, each as [threshold in the base unit, label, decimals];
 * the last step is the floor.
 */
function scaled(steps: ReadonlyArray<[threshold: number, unit: string, digits: number]>): (value: number) => string {
	return (value) => {
		const [threshold, unit, digits] = steps.find(([t]) => value >= t) ?? steps[steps.length - 1];
		return `${num(value / threshold, digits)} ${unit}`;
	};
}

/** Kilograms of CO2e as tonnes, kilograms or grams. */
export const formatCo2 = scaled([
	[1_000, "t CO₂e", 2],
	[1, "kg CO₂e", 1],
	[0.001, "g CO₂e", 0],
]);

/** Kilowatt hours as MWh, kWh or Wh. */
export const formatEnergy = scaled([
	[1_000, "MWh", 2],
	[1, "kWh", 1],
	[0.001, "Wh", 0],
]);

/** Litres, or millilitres below one. */
export const formatWater = scaled([
	[1, "L", 1],
	[0.001, "mL", 0],
]);

/** "235B total, 22B active" or "123B". */
export function formatParameters(p: ModelParameters): string {
	return p.active !== undefined ? `${num(p.total, 1)}B total, ${num(p.active, 1)}B active` : `${num(p.total, 1)}B`;
}

/** The model page's provenance phrase: the registry name, or the declared size the estimate was built from. */
export function impactSourceLabel(model: ImpactModel): string {
	return model.parameters ? `from its published size of ${formatParameters(model.parameters)}` : `for ${model.modelName}`;
}

/** "12 to 18 g CO₂e": a range in one unit, so the uncertainty is visible. */
export function formatRange(r: Range, format: (n: number) => string): string {
	const lo = format(r.min);
	const hi = format(r.max);
	if (lo === hi) return lo;
	// Every formatter above emits "<number> <unit>", so the unit starts at the first space.
	const unit = hi.slice(hi.indexOf(" "));
	return lo.endsWith(unit) ? `${lo.slice(0, -unit.length)} to ${hi}` : `${lo} to ${hi}`;
}
