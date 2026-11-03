/**
 * Pure helpers for turning LiteLLM's daily cost/token rows into a date range
 * to query and into the labels/datasets shape Chart.js expects for a stacked
 * bar chart. Kept separate from litellm.ts (and free of any fetch/DOM code)
 * so the aggregation logic can be unit tested without mocking network calls.
 */
import type { LitellmCost } from "./litellm";

export type Timeframe = "last-week" | "last-month" | "last-quarter";
export type Breakdown = "teams" | "models";
export type Metric = "spend" | "tokens";

/** Rolling windows ending today, labelled in days so "month" isn't read as a calendar month. */
export const TIMEFRAMES: ReadonlyArray<{ value: Timeframe; label: string; days: number }> = [
	{ value: "last-week", label: "Last 7 days", days: 7 },
	{ value: "last-month", label: "Last 30 days", days: 30 },
	{ value: "last-quarter", label: "Last 90 days", days: 90 },
];

export const DEFAULT_TIMEFRAME: Timeframe = "last-month";

export const BREAKDOWNS: ReadonlyArray<{ value: Breakdown; label: string }> = [
	{ value: "teams", label: "Teams" },
	{ value: "models", label: "Models" },
];

export const METRICS: ReadonlyArray<{ value: Metric; label: string }> = [
	{ value: "spend", label: "Spend" },
	{ value: "tokens", label: "Tokens" },
];

/** Validate a raw query value against a known option list, falling back to `fallback` for missing or unrecognised input rather than trusting arbitrary query input downstream. Shared by every `{value,label}[]` query param (timeframe, breakdown, metric). */
export function parseOption<T extends string>(raw: string | null, options: ReadonlyArray<{ value: T }>, fallback: T): T {
	return options.some((o) => o.value === raw) ? (raw as T) : fallback;
}

/** Validate a raw `?timeframe` query value against the known timeframes. */
export function parseTimeframe(raw: string | null, fallback: Timeframe): Timeframe {
	return parseOption(raw, TIMEFRAMES, fallback);
}

/** The display label for a timeframe (e.g. "Last 30 days"). */
export function timeframeLabel(timeframe: Timeframe): string {
	return TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe;
}

/** The [start_date, end_date] (both inclusive, ISO `YYYY-MM-DD`) LiteLLM expects for this timeframe: exactly its `days` days, ending today (UTC). */
export function getDateRange(timeframe: Timeframe, now: Date = new Date()): { startDate: string; endDate: string } {
	const days = TIMEFRAMES.find((t) => t.value === timeframe)!.days;
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - (days - 1));

	return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/** The label a cost row falls under for the given breakdown - LiteLLM omits team_id for keys with no team, so those are grouped together rather than silently dropped. */
function seriesKey(cost: LitellmCost, breakdown: Breakdown): string {
	if (breakdown === "models") {
		return cost.model_name;
	}
	return cost.team_name || "personal";
}

// LiteLLM reports raw token counts, but those numbers get large fast - millions
// of tokens is the unit people actually reason about, and matches the axis
// label rendered alongside this value.
const TOKENS_PER_MILLION = 1_000_000;

function metricValue(cost: LitellmCost, metric: Metric): number {
	return metric === "spend" ? cost.spend : cost.total_tokens / TOKENS_PER_MILLION;
}

/** Series beyond this rank (by total value across the whole timeframe) are folded into "Other", so the chart stays readable when there are many teams/models. */
const MAX_NAMED_SERIES = 5;
const OTHER_LABEL = "Other";

export interface ChartData {
	labels: ReadonlyArray<string>;
	datasets: ReadonlyArray<{ label: string; data: ReadonlyArray<number> }>;
}

/**
 * One label per day present in `costs`, one dataset per team/model - each
 * dataset holds that series' value for every date (0 where it had none), so
 * Chart.js can stack them straightforwardly without gaps. Only the top
 * `MAX_NAMED_SERIES` series by total value keep their own name; the rest are
 * summed together into a single "Other" series.
 */
export function buildChartData(costs: ReadonlyArray<LitellmCost>, breakdown: Breakdown, metric: Metric): ChartData {
	const dates = [...new Set(costs.map((c) => c.date))].sort();

	const seriesTotals = new Map<string, number>();
	for (const cost of costs) {
		const key = seriesKey(cost, breakdown);
		seriesTotals.set(key, (seriesTotals.get(key) ?? 0) + metricValue(cost, metric));
	}

	const namedSeries = new Set(
		[...seriesTotals.entries()]
			.sort(([, a], [, b]) => b - a)
			.slice(0, MAX_NAMED_SERIES)
			.map(([name]) => name)
	);
	const hasOther = seriesTotals.size > namedSeries.size;

	const totals = new Map<string, number>();
	for (const cost of costs) {
		const key = seriesKey(cost, breakdown);
		const label = namedSeries.has(key) ? key : OTHER_LABEL;
		const bucketKey = `${cost.date}\u0000${label}`;
		totals.set(bucketKey, (totals.get(bucketKey) ?? 0) + metricValue(cost, metric));
	}

	const seriesNames = [...namedSeries].sort();
	if (hasOther) {
		seriesNames.push(OTHER_LABEL);
	}

	const datasets = seriesNames.map((name) => ({
		label: name,
		data: dates.map((date) => totals.get(`${date}\u0000${name}`) ?? 0),
	}));

	return { labels: dates, datasets };
}
