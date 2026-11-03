/**
 * Pure helpers for the "usage at a glance" summaries. Totals whatever cost
 * rows it's given - callers filter to the keys they care about first.
 * Kept free of fetch/DOM code so it can be unit tested without the network.
 */
import type { LitellmCost, LitellmProviderCost } from "./litellm";

export interface KeysUsage {
	spend: number;
	tokens: number;
	requests: number;
	/** Of those requests, how many failed. */
	failures: number;
	/** Input tokens. promptTokens + completionTokens sums to tokens. */
	promptTokens: number;
	/** Output tokens. */
	completionTokens: number;
	/** Input tokens served from the prompt cache (a subset of promptTokens). */
	cacheReadTokens: number;
	/** Input tokens written to the prompt cache (a subset of promptTokens). */
	cacheCreationTokens: number;
}

/** Total spend, tokens, requests, failures and the token breakdown across the cost rows. */
export function summariseKeysUsage(costs: ReadonlyArray<LitellmCost>): KeysUsage {
	const u: KeysUsage = { spend: 0, tokens: 0, requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
	for (const cost of costs) {
		u.spend += cost.spend;
		u.tokens += cost.total_tokens;
		u.requests += cost.api_requests;
		u.failures += cost.failed_requests;
		u.promptTokens += cost.prompt_tokens;
		u.completionTokens += cost.completion_tokens;
		u.cacheReadTokens += cost.cache_read_input_tokens;
		u.cacheCreationTokens += cost.cache_creation_input_tokens;
	}
	return u;
}

/**
 * Fold rows into per-group accumulators keyed by `keyOf`, preserving first-seen
 * order. Shared by every per-group summary (model, provider and key): they
 * differ only in the grouping field and the metrics carried. `init` builds a
 * group's zeroed accumulator when its first row is seen (reading only the
 * row's label, not its values); `add` then folds every row in.
 */
function aggregateBy<T, R>(
	rows: ReadonlyArray<T>,
	keyOf: (row: T) => string,
	init: (row: T) => R,
	add: (acc: R, row: T) => void,
): R[] {
	const byKey = new Map<string, R>();
	for (const row of rows) {
		const key = keyOf(row);
		let acc = byKey.get(key);
		if (!acc) {
			acc = init(row);
			byKey.set(key, acc);
		}
		add(acc, row);
	}
	return [...byKey.values()];
}

export interface ModelUsage {
	model: string;
	spend: number;
	tokens: number;
	requests: number;
	/** Of those requests, how many failed. */
	failures: number;
}

/** Usage totalled per model, unsorted. `groupOf` picks a different grouping (e.g. team), reported in `model`. */
export function summariseModelUsage(
	costs: ReadonlyArray<LitellmCost>,
	groupOf: (c: LitellmCost) => string = (c) => c.model_name,
): ModelUsage[] {
	return aggregateBy(
		costs,
		groupOf,
		(c) => ({ model: groupOf(c), spend: 0, tokens: 0, requests: 0, failures: 0 }),
		(m, c) => {
			m.spend += c.spend;
			m.tokens += c.total_tokens;
			m.requests += c.api_requests;
			m.failures += c.failed_requests;
		},
	);
}

export interface ModelSeries {
	/** Model name, or "Other" for the folded tail. */
	model: string;
	/** Per-date metric values, aligned one-to-one with the `dates` passed in. */
	daily: number[];
}

/** Series beyond this rank fold into "Other" so a stacked chart stays readable. */
const MODEL_SERIES_LIMIT = 5;
const OTHER_MODEL = "Other";

/**
 * Per-model daily series for one metric, each aligned to `dates` (0 where a
 * model had no usage that day). Only the top `MODEL_SERIES_LIMIT` models by
 * total keep their own series, busiest first; the rest fold into a trailing
 * "Other" so a stacked chart doesn't sprout a series per long-tail model.
 * `value` picks the metric from a row (spend, tokens, ...); `groupOf` picks
 * the series a row belongs to (the model by default).
 */
export function summariseModelSeries(
	costs: ReadonlyArray<LitellmCost>,
	dates: ReadonlyArray<string>,
	value: (c: LitellmCost) => number,
	groupOf: (c: LitellmCost) => string = (c) => c.model_name,
): ModelSeries[] {
	const dateIndex = new Map(dates.map((d, i) => [d, i]));

	const totals = new Map<string, number>();
	for (const c of costs) {
		totals.set(groupOf(c), (totals.get(groupOf(c)) ?? 0) + value(c));
	}
	const ranked = [...totals.entries()].sort(([, a], [, b]) => b - a);
	const named = new Set(ranked.slice(0, MODEL_SERIES_LIMIT).map(([m]) => m));
	const hasOther = totals.size > named.size;

	const byModel = new Map<string, number[]>();
	for (const m of named) byModel.set(m, dates.map(() => 0));
	if (hasOther) byModel.set(OTHER_MODEL, dates.map(() => 0));
	for (const c of costs) {
		const i = dateIndex.get(c.date);
		if (i === undefined) continue;
		byModel.get(named.has(groupOf(c)) ? groupOf(c) : OTHER_MODEL)![i] += value(c);
	}

	const out: ModelSeries[] = ranked.slice(0, MODEL_SERIES_LIMIT).map(([m]) => ({ model: m, daily: byModel.get(m)! }));
	if (hasOther) out.push({ model: OTHER_MODEL, daily: byModel.get(OTHER_MODEL)! });
	return out;
}

export interface RequestSource {
	/** Key alias (or other grouping label). */
	name: string;
	requests: number;
	/** Of those requests, how many failed. */
	failures: number;
	spend: number;
	tokens: number;
}

/** Requests, failures, spend and tokens totalled per key, unsorted. */
export function summariseKeyRequests(costs: ReadonlyArray<LitellmCost>): RequestSource[] {
	return aggregateBy(
		costs,
		(c) => c.key_alias,
		(c) => ({ name: c.key_alias, requests: 0, failures: 0, spend: 0, tokens: 0 }),
		(k, c) => {
			k.requests += c.api_requests;
			k.failures += c.failed_requests;
			k.spend += c.spend;
			k.tokens += c.total_tokens;
		},
	);
}

export interface ProviderUsage {
	provider: string;
	spend: number;
	tokens: number;
	requests: number;
	/** Of those requests, how many failed. */
	failures: number;
}

/** Usage totalled per backend provider, unsorted. */
export function summariseProviderUsage(costs: ReadonlyArray<LitellmProviderCost>): ProviderUsage[] {
	return aggregateBy(
		costs,
		(c) => c.provider,
		(c) => ({ provider: c.provider, spend: 0, tokens: 0, requests: 0, failures: 0 }),
		(p, c) => {
			p.spend += c.spend;
			p.tokens += c.total_tokens;
			p.requests += c.api_requests;
			p.failures += c.failed_requests;
		},
	);
}

/**
 * Failure rate as a percentage string. Rounds to at most `decimals` places but
 * never down to "0%" while failures exist: a rate below the smallest step (e.g.
 * 0.01%) shows as "<0.01%" so a genuine failure is never hidden by rounding.
 */
export function formatFailureRate(failures: number, requests: number, decimals = 2): string {
	if (requests === 0 || failures === 0) return "0%";
	const pct = (failures / requests) * 100;
	const floor = 10 ** -decimals;
	if (pct < floor) return `<${floor}%`;
	return `${parseFloat(pct.toFixed(decimals))}%`;
}

/**
 * `part` as a whole-number percentage of `whole`, for share-of-total columns.
 * Never rounds a real value away: a non-zero share below 1% shows as "<1%", and
 * a share just under the whole never rounds up to a misleading "100%".
 */
export function formatShare(part: number, whole: number): string {
	if (whole === 0 || part === 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct < 1) return "<1%";
	if (pct > 99 && part < whole) return "99%";
	return `${Math.round(pct)}%`;
}

// Friendly names for the backend providers LiteLLM reports. Anything we don't
// recognise falls through to its raw name so a new provider still shows up
// rather than being hidden. LiteLLM's "unknown" bucket is requests that never
// reached a backend (they failed first), so we call it "Unattributed" to make
// that clear rather than reading as a mystery provider.
const PROVIDER_LABELS: Record<string, string> = {
	vertex_ai: "Vertex AI",
	bedrock: "Bedrock",
	openai: "OpenAI",
	azure: "Azure",
	anthropic: "Anthropic",
	unknown: "Unattributed",
};

/** Friendly provider name from LiteLLM's raw provider id, falling back to the raw id. */
export function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

export interface DailyUsage {
	/** YYYY-MM-DD. For a multi-day bucket this is the first day it covers. */
	date: string;
	/** YYYY-MM-DD of the last day a multi-day bucket covers; unset for single days. */
	end?: string;
	spend: number;
	tokens: number;
	requests: number;
	/** Of those requests, how many failed. */
	failures: number;
}

/**
 * Usage totalled per day, one entry per date in `dates` (oldest first).
 * Quiet days come back as zeroes so charts stay aligned.
 */
export function summariseDailyUsage(
	costs: ReadonlyArray<LitellmCost>,
	dates: ReadonlyArray<string>,
): DailyUsage[] {
	const byDate = new Map<string, DailyUsage>();
	for (const date of dates) byDate.set(date, { date, spend: 0, tokens: 0, requests: 0, failures: 0 });
	for (const cost of costs) {
		const bucket = byDate.get(cost.date);
		if (!bucket) continue;
		bucket.spend += cost.spend;
		bucket.tokens += cost.total_tokens;
		bucket.requests += cost.api_requests;
		bucket.failures += cost.failed_requests;
	}
	return dates.map((date) => byDate.get(date)!);
}

export type Granularity = "day" | "week" | "month";

/**
 * Bar granularity for the home page's windowed series, chosen from the window
 * length so a long range doesn't render as hundreds of unreadable slivers:
 * daily up to a month, weekly beyond (the longest timeframe is a quarter).
 * Driven by day count rather than the timeframe name, so it stays correct if
 * ranges change. (The trends page switches earlier; see trendGranularityFor.)
 */
export function granularityFor(days: number): Granularity {
	return days <= 31 ? "day" : "week";
}

/** Days per bucket. A "month" is a fixed 30-day block, so every bucket is the same length. */
export const GRANULARITY_DAYS: Record<Granularity, number> = { day: 1, week: 7, month: 30 };

/** Split an ordered series into consecutive groups of `size`, the last possibly shorter. */
export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Group an ordered (oldest-first) daily series into buckets at `granularity`,
 * summing each metric. Each bucket is anchored to its first day's date and
 * carries an `end` date so a tooltip can name the span it covers. At `day`
 * granularity this is one bucket per day.
 */
export function bucketDailyUsage(daily: ReadonlyArray<DailyUsage>, granularity: Granularity): DailyUsage[] {
	return chunk(daily, GRANULARITY_DAYS[granularity]).map((group) => {
		const b: DailyUsage = { date: group[0].date, end: group[group.length - 1].date, spend: 0, tokens: 0, requests: 0, failures: 0 };
		for (const d of group) {
			b.spend += d.spend;
			b.tokens += d.tokens;
			b.requests += d.requests;
			b.failures += d.failures;
		}
		return b;
	});
}

/** The span each `granularity` bucket covers over `dates`, aligned one-to-one with bucketDailyUsage. */
export function bucketSpans(dates: ReadonlyArray<string>, granularity: Granularity): Array<Pick<DailyUsage, "date" | "end">> {
	return chunk(dates, GRANULARITY_DAYS[granularity]).map((group) => ({ date: group[0], end: group[group.length - 1] }));
}

/** Sum an ordered daily value series (e.g. a key's per-day tokens) into `granularity` buckets, aligned one-to-one with bucketDailyUsage. */
export function bucketValues(values: ReadonlyArray<number>, granularity: Granularity): number[] {
	return chunk(values, GRANULARITY_DAYS[granularity]).map((group) => group.reduce((sum, v) => sum + v, 0));
}

export interface KeyActivity {
	/** Tokens per day across the window, oldest first - one entry per date in `dates`. */
	daily: number[];
	/** YYYY-MM-DD of the most recent day this key was used, or null if unused. */
	lastActive: string | null;
}

/** Today as YYYY-MM-DD, in UTC. */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/** A YYYY-MM-DD date shifted by `days` (negative to go back), in UTC. */
export function shiftDate(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD dates from `startDate` to `endDate`, oldest first. */
export function listDates(startDate: string, endDate: string): string[] {
	const out: string[] = [];
	const day = new Date(`${startDate}T00:00:00Z`);
	const end = new Date(`${endDate}T00:00:00Z`);
	while (day <= end) {
		out.push(day.toISOString().slice(0, 10));
		day.setUTCDate(day.getUTCDate() + 1);
	}
	return out;
}

/**
 * Per-day token totals for a single key over `dates`. Days with no rows come
 * back as 0 so the sparkline stays aligned with the date window.
 */
export function summariseKeyActivity(
	costs: ReadonlyArray<LitellmCost>,
	alias: string,
	dates: ReadonlyArray<string>,
): KeyActivity {
	const byDate = new Map<string, number>();
	for (const cost of costs) {
		if (cost.key_alias !== alias) continue;
		byDate.set(cost.date, (byDate.get(cost.date) ?? 0) + cost.total_tokens);
	}
	let lastActive: string | null = null;
	for (const date of dates) {
		if ((byDate.get(date) ?? 0) > 0) lastActive = date;
	}
	return { daily: dates.map((date) => byDate.get(date) ?? 0), lastActive };
}

/**
 * Scale a series to bar heights (0-100) against its own busiest value, so the
 * shape of use is visible even for a lightly-used series. Zero stays 0; any
 * non-zero value gets at least `floor` so a small bar is still visible.
 */
export function scaleBars(values: ReadonlyArray<number>, floor: number): number[] {
	const max = Math.max(...values, 0);
	if (max === 0) return values.map(() => 0);
	return values.map((v) => (v === 0 ? 0 : Math.max(floor, Math.round((v / max) * 100))));
}

export function formatSpend(spend: number): string {
	// Thousands separators so large platform totals stay readable ($43,981.11).
	return `$${spend.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact count - billions/millions/thousands with one decimal, raw below 1,000. */
function compact(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/** Compact spend for headline tiles ($44.0k), where the exact figure lives in the CSV. Below $1,000 keep the cents. */
export function formatSpendCompact(spend: number): string {
	if (spend >= 1_000) return `$${compact(spend)}`;
	return formatSpend(spend);
}

export function formatTokens(tokens: number): string {
	return compact(tokens);
}

export function formatRequests(requests: number): string {
	return compact(requests);
}

/** Drop a compact figure's trailing ".0" for round values: "5.0k" -> "5k". */
export function trimCompact(s: string): string {
	return s.replace(/\.0(?=[kMB]?$)/, "");
}

/** A bucket's label: a single day, or "start to end" when it spans several. */
export function formatSpan(span: Pick<DailyUsage, "date" | "end">, formatDate: (isoDate: string) => string = formatChartDate): string {
	return span.end && span.end !== span.date ? `${formatDate(span.date)} to ${formatDate(span.end)}` : formatDate(span.date);
}

/** Chart value for tooltips: spend, compact tokens, or a plain count. */
export function formatChartValue(value: number, format: string): string {
	if (format === "spend") return formatSpend(value);
	if (format === "tokens") return formatTokens(value);
	return value.toLocaleString("en-GB");
}

/**
 * Chart axis tick: compact figures (5k, 10k, 2M) with no trailing ".0", for
 * counts as well as tokens - tooltips keep the full count. Spend shows whole
 * dollars unless any tick on the axis is fractional (small spends), then cents,
 * so ticks like $0.25 never collapse to "$0".
 */
export function formatChartTick(value: number, format: string, ticks: ReadonlyArray<{ value: number }> = []): string {
	if (format === "spend") {
		return ticks.some((t) => !Number.isInteger(t.value)) ? formatSpend(value) : `$${value.toLocaleString("en-GB")}`;
	}
	return trimCompact(compact(value));
}

/** Round a raw step up to a "nice" 1/2/5-times-magnitude value, at least 1. */
function niceStep(x: number): number {
	if (x <= 1) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(x)));
	const n = x / pow;
	return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/**
 * A y-axis max and step for compact (token/count) scales that land every tick on
 * a whole compact unit (1M, 2M, 3M rather than 1.5M), so the axis reads without
 * decimals. The step is a whole number of the max's unit (k/M/B).
 */
export function compactAxis(max: number): { max: number; stepSize: number } {
	if (max <= 0) return { max: 1, stepSize: 1 };
	const unit = max >= 1e9 ? 1e9 : max >= 1e6 ? 1e6 : max >= 1e3 ? 1e3 : 1;
	const stepSize = niceStep(max / unit / 5) * unit;
	return { max: Math.ceil(max / stepSize) * stepSize, stepSize };
}

/**
 * Shared chart theme, per the i.AI Design System chart colours
 * (i-ai-design-system.ai.gov.uk/styles/chart-colours): black tint 80% for axes
 * and lines, black for labels.
 */
export const CHART_FONT = { family: '"Inter", Helvetica, Arial, sans-serif', size: 16 };
export const CHART_GRID_COLOR = "#cecece";
export const CHART_TICK_COLOR = "var(--govuk-text-colour)";

/** The chart font at page body size: 19px on desktop, 16px below the tablet breakpoint. Browser only. */
export function chartFont(): typeof CHART_FONT {
	return { ...CHART_FONT, size: window.matchMedia("(min-width: 40.0625em)").matches ? 19 : 16 };
}

/**
 * Resolves a `var(--token)` colour to its computed value, since canvas can't
 * read CSS variables. Other colours pass through. Browser only.
 */
export function themeColour(colour: string): string {
	const name = /^var\((--[\w-]+)\)$/.exec(colour)?.[1];
	if (!name) return colour;
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || colour;
}

/**
 * i.AI Design System categorical chart palette, in the kit's order: primary
 * blue, blue shade 50%, primary magenta, purple/teal/orange tint 25%.
 */
export const CHART_PALETTE = ["#1d70b8", "#0f385c", "#ca357c", "#7f65b7", "#50a1a5", "#f7996a"];

/** Single-series accent (area charts, meters, sparklines): the palette's first colour. */
export const CHART_ACCENT = CHART_PALETTE[0];

/** A short chart label from an ISO date (YYYY-MM-DD), e.g. "1 Aug", in UTC. */
export function formatDay(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * A chart-axis date label from an ISO date (YYYY-MM-DD), e.g. "1 Aug 2026".
 * Parsed as UTC so the day never shifts across timezones. Shared by the bar and
 * line chart client scripts so both label their axes identically.
 */
export function formatChartDate(isoDate: string): string {
	const date = new Date(`${isoDate}T00:00:00Z`);
	const day = date.getUTCDate();
	const month = date.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
	const year = date.getUTCFullYear();
	return `${day} ${month} ${year}`;
}
