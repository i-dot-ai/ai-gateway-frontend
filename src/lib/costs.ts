/**
 * Pure helpers for the timeframe presets and the date range LiteLLM is queried
 * for. Kept separate from litellm.ts (and free of any fetch/DOM code) so they
 * can be unit tested without mocking network calls.
 */
export type Timeframe = "last-week" | "last-month" | "last-quarter";

/** Rolling windows ending today, labelled in days so "month" isn't read as a calendar month. */
export const TIMEFRAMES: ReadonlyArray<{ value: Timeframe; label: string; days: number }> = [
	{ value: "last-week", label: "Last 7 days", days: 7 },
	{ value: "last-month", label: "Last 30 days", days: 30 },
	{ value: "last-quarter", label: "Last 90 days", days: 90 },
];

export const DEFAULT_TIMEFRAME: Timeframe = "last-month";

/** Validate a raw query value against a known option list, falling back to `fallback` for missing or unrecognised input rather than trusting arbitrary query input downstream. Shared by every `{value,label}[]` query param (timeframe, entity). */
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
