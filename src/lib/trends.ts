/**
 * Pure helpers for the platform-wide "trends" view - how gateway usage moves
 * over time, rather than the current point-in-time mix the stacked usage chart
 * showed. Turns LiteLLM's daily cost/token rows into one value per day, week or
 * 30-day block for each headline metric (active entities, active keys, tokens,
 * spend, requests). Kept free of any fetch/DOM code so the aggregation can be unit
 * tested without mocking network calls, matching costs.ts / usage.ts.
 */
import type { LitellmCost } from "./litellm";
import { DEFAULT_TIMEFRAME, TIMEFRAMES, getDateRange, parseTimeframe, type Timeframe } from "./costs";
import { GRANULARITY_DAYS, bucketSpans, listDates, shiftDate, type DailyUsage, type Granularity } from "./usage";

export { listDates, shiftDate };

/**
 * The "active X" panel can be read by two different entities. A cost row carries
 * both, so switching dimension is a re-count of the same rows, never a re-fetch:
 * - users: distinct people (user_id), joined onto each key from /key/list. A
 *   person holds several keys, so this counts people, not keys.
 * - teams: distinct teams (team_id), carried directly on each row.
 * (Projects were considered but are unused on this deployment - every key's
 * project_id is null - so they'd be a permanently empty line.)
 */
export type EntityDimension = "users" | "teams";

export const ENTITY_DIMENSIONS: ReadonlyArray<{ value: EntityDimension; label: string; noun: string }> = [
	{ value: "users", label: "Users", noun: "users" },
	{ value: "teams", label: "Teams", noun: "teams" },
];

/**
 * A row's identity under each dimension, or null when the row can't be
 * attributed to one (a key with no owner, or no team). Null rows are left out
 * of the distinct counts rather than lumped into a fake "unknown" entity - the
 * bulk of that unattributed traffic is health-check and service tokens, which
 * aren't people or teams, so counting them would overstate adoption.
 */
const identityFor: Record<EntityDimension, (cost: LitellmCost) => string | null> = {
	users: (c) => c.user_id,
	teams: (c) => c.team_id || null,
};

/**
 * LiteLLM's health-check probe is one internal key that calls every model on a
 * timer - infrastructure self-monitoring, not real usage. At scale it dwarfs the
 * request/token counts (hundreds of thousands of calls a week for ~$0), so it's
 * always excluded, including from the key count (it's one key). It has no user
 * or team, so the active user/team counts never saw it. Matched by its stable
 * internal token, since its alias is blank.
 */
export const HEALTH_CHECK_KEY_TOKEN = "litellm-internal-health-check";

/** Whether a cost row belongs to the internal health-check key. */
export function isHealthCheckCost(cost: LitellmCost): boolean {
	return cost.key_token === HEALTH_CHECK_KEY_TOKEN;
}

/** Drop the internal health-check key's rows. */
export function excludeHealthCheck(costs: ReadonlyArray<LitellmCost>): LitellmCost[] {
	return costs.filter((c) => !isHealthCheckCost(c));
}

/**
 * Signed period-over-period change of `current` against `previous`, as a
 * percentage, or null when there's no comparable baseline - the previous value
 * was absent (the comparison window failed to load) or zero (a % change off zero
 * is undefined). Drives every KPI tile's change chip.
 */
export function pctChange(current: number, previous: number | undefined): number | null {
	return previous && previous > 0 ? ((current - previous) / previous) * 100 : null;
}

/** The longest custom range allowed: the platform-wide cost scan (and its previous-window comparison) grows with the range. */
export const MAX_CUSTOM_DAYS = 365;

export interface TrendRange {
	/** YYYY-MM-DD, inclusive. */
	startDate: string;
	endDate: string;
	days: number;
	/** The preset in use, or null for a custom range. */
	preset: Timeframe | null;
	/** The raw ?from / ?to values, to refill the date inputs. */
	from: string;
	to: string;
	/** Set when a custom range was rejected; the range then falls back to the default preset. */
	error?: { field: "from" | "to"; message: string };
}

function isIsoDate(value: string): boolean {
	// The round trip rejects overflowed dates like 30 Feb; the NaN check stops an out-of-range month throwing.
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && shiftDate(value, 0) === value;
}

function daysBetween(startDate: string, endDate: string): number {
	return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function presetRange(preset: Timeframe, today: string): Pick<TrendRange, "startDate" | "endDate" | "days" | "preset"> {
	const { startDate, endDate } = getDateRange(preset, new Date(`${today}T00:00:00Z`));
	return { startDate, endDate, days: daysBetween(startDate, endDate), preset };
}

function customRangeError(from: string, to: string, today: string): TrendRange["error"] {
	if (!isIsoDate(from)) return { field: "from", message: "Enter a real start date" };
	if (!isIsoDate(to)) return { field: "to", message: "Enter a real end date" };
	if (to > today) return { field: "to", message: "End date must be today or in the past" };
	if (from > to) return { field: "from", message: "Start date must be the same as or before the end date" };
	if (daysBetween(from, to) > MAX_CUSTOM_DAYS) return { field: "from", message: `Date range must be ${MAX_CUSTOM_DAYS} days or fewer` };
	return undefined;
}

/**
 * The window the page and CSV cover, from `?from`+`?to` (a custom range) or
 * `?timeframe` (a preset). A custom range that fails validation falls back to
 * the default preset and carries the error to show beside the inputs.
 */
export function parseTrendRange(params: URLSearchParams, today: string): TrendRange {
	const from = params.get("from") ?? "";
	const to = params.get("to") ?? "";
	if (from || to) {
		const error = customRangeError(from, to, today);
		if (!error) return { startDate: from, endDate: to, days: daysBetween(from, to), preset: null, from, to };
		return { ...presetRange(DEFAULT_TIMEFRAME, today), from, to, error };
	}
	return { ...presetRange(parseTimeframe(params.get("timeframe"), DEFAULT_TIMEFRAME), today), from, to };
}

/** The query params for a preset, omitting the default to keep URLs clean. */
export function presetParams(preset: Timeframe): URLSearchParams {
	return new URLSearchParams(preset === DEFAULT_TIMEFRAME ? {} : { timeframe: preset });
}

/** The query params that reproduce `range`. */
export function rangeParams(range: TrendRange): URLSearchParams {
	return range.preset === null ? new URLSearchParams({ from: range.startDate, to: range.endDate }) : presetParams(range.preset);
}

/**
 * The first date to fetch for `range`: the start of the equal-length window
 * before it, which the tile deltas compare against. It also covers the chart's
 * bucket-aligned lead-in (at most one bucket, never longer than the range), so
 * one cached scan serves the page and the CSV.
 */
export function trendFetchStart(range: Pick<TrendRange, "startDate" | "days">): string {
	return shiftDate(range.startDate, -range.days);
}

/** The span every preset (and its CSV) fetches: the longest preset's fetch range. */
export function trendPresetsFetchRange(today: string): { startDate: string; endDate: string } {
	const longest = TIMEFRAMES.reduce((a, b) => (b.days > a.days ? b : a));
	const range = presetRange(longest.value, today);
	return { startDate: trendFetchStart(range), endDate: range.endDate };
}

/**
 * How finely the charts plot a window: daily for short ranges, weekly up to
 * about six months, 30-day blocks beyond. Plotting a month or more day by day
 * is mostly weekday/weekend noise, which buries the trend. Earlier than the home
 * page's granularityFor, which can afford to stay daily because its bars don't
 * need the bucket-aligned lead-in below.
 */
export function trendGranularityFor(days: number): Granularity {
	if (days <= 14) return "day";
	if (days <= 182) return "week";
	return "month";
}

/**
 * The first date of the chart's x-axis: `startDate` pulled back so the window
 * divides into whole buckets ending on `endDate`. Without this the oldest
 * bucket would be partial and read as a dip that never happened.
 */
export function bucketAlignedStart(startDate: string, endDate: string, granularity: Granularity): string {
	const size = GRANULARITY_DAYS[granularity];
	const buckets = Math.ceil(daysBetween(startDate, endDate) / size);
	return shiftDate(endDate, -(buckets * size - 1));
}

export interface Trends {
	/** Each bucket's first and last day (YYYY-MM-DD). */
	buckets: Array<Pick<DailyUsage, "date" | "end">>;
	/** Distinct users and teams active in each bucket. */
	active: Record<EntityDimension, number[]>;
	/** Distinct keys used in each bucket. */
	activeKeys: number[];
	spend: number[];
	tokens: number[];
	requests: number[];
	failures: number[];
}

/**
 * Every headline metric per bucket over `dates` (oldest first, grouped into
 * runs of GRANULARITY_DAYS[granularity] from the start). Users, teams and keys
 * are counted once per bucket, in one pass; spend/tokens/requests/failures are
 * summed. Quiet buckets come back as zeroes so every series stays aligned.
 */
export function buildTrends(
	costs: ReadonlyArray<LitellmCost>,
	dates: ReadonlyArray<string>,
	granularity: Granularity,
): Trends {
	const size = GRANULARITY_DAYS[granularity];
	const bucketOf = new Map(dates.map((d, i) => [d, Math.floor(i / size)]));
	const buckets = bucketSpans(dates, granularity);
	const users = buckets.map(() => new Set<string>());
	const teams = buckets.map(() => new Set<string>());
	const keys = buckets.map(() => new Set<string>());
	const zeroes = () => buckets.map(() => 0);
	const spend = zeroes();
	const tokens = zeroes();
	const requests = zeroes();
	const failures = zeroes();
	for (const c of costs) {
		const b = bucketOf.get(c.date);
		if (b === undefined) continue;
		const user = identityFor.users(c);
		const team = identityFor.teams(c);
		if (user) users[b].add(user);
		if (team) teams[b].add(team);
		keys[b].add(c.key_token);
		spend[b] += c.spend;
		tokens[b] += c.total_tokens;
		requests[b] += c.api_requests;
		failures[b] += c.failed_requests;
	}
	return {
		buckets,
		active: { users: users.map((s) => s.size), teams: teams.map((s) => s.size) },
		activeKeys: keys.map((s) => s.size),
		spend,
		tokens,
		requests,
		failures,
	};
}

export interface TrendTotals {
	/** Distinct users active at any point in the window. */
	users: number;
	/** Distinct teams active at any point in the window. */
	teams: number;
	/** Distinct keys used at any point in the window. */
	keys: number;
	/** Total requests over the window. */
	requests: number;
	/** Of those requests, how many failed or succeeded over the window. */
	failed: number;
	successful: number;
	/** Failed as a percentage of all requests (0 when there were none). */
	failureRate: number;
	/** Total tokens over the window. */
	tokens: number;
	/** Total spend over the window. */
	spend: number;
}

/**
 * Window-wide headline figures for the KPI tiles: distinct users, teams and keys
 * seen across the display range (counted once each), and the summed
 * request/token/spend totals. Costs may include rows from outside the display
 * range (the previous window and the chart's lead-in), so every figure is
 * restricted to `displayDates`.
 */
export function trendTotals(costs: ReadonlyArray<LitellmCost>, displayDates: ReadonlyArray<string>): TrendTotals {
	const inRange = new Set(displayDates);
	const users = new Set<string>();
	const teams = new Set<string>();
	const keys = new Set<string>();
	let requests = 0;
	let failed = 0;
	let tokens = 0;
	let spend = 0;
	for (const c of costs) {
		if (!inRange.has(c.date)) continue;
		if (c.user_id) users.add(c.user_id);
		if (c.team_id) teams.add(c.team_id);
		keys.add(c.key_token);
		requests += c.api_requests;
		failed += c.failed_requests;
		tokens += c.total_tokens;
		spend += c.spend;
	}
	return {
		users: users.size,
		teams: teams.size,
		keys: keys.size,
		requests,
		failed,
		successful: Math.max(0, requests - failed),
		failureRate: requests > 0 ? (failed / requests) * 100 : 0,
		tokens,
		spend,
	};
}
