/**
 * Pure helpers for the model "down-detector" status timeline - turning
 * LiteLLM's per-model health-check records into up/down segments, uptime
 * percentages and roll-ups. Kept free of any fetch/DOM code (the fetchers live
 * in litellm.ts) so the bucketing logic can be unit tested without the network.
 *
 * Windows come in two granularities: the models list shows a 24-hour hourly
 * window for a glanceable "is it up right now" read, while a model's detail
 * page shows a wider 90-day daily history.
 */
import type { LitellmHealthCheck } from "./litellm";

export type HealthWindow = "24h" | "7d" | "90d";

/** Hourly buckets for the 24h window; daily for the multi-day windows. */
export type Granularity = "hour" | "day";

export interface HealthWindowDef {
	value: HealthWindow;
	label: string;
	granularity: Granularity;
	/** How many segments (buckets) the window draws. */
	buckets: number;
}

export const HEALTH_WINDOWS: ReadonlyArray<HealthWindowDef> = [
	{ value: "24h", label: "24 hours", granularity: "hour", buckets: 24 },
	{ value: "7d", label: "7 days", granularity: "day", buckets: 7 },
	{ value: "90d", label: "90 days", granularity: "day", buckets: 90 },
];

/** The definition for a window, falling back to 7 days for anything unknown. */
export function windowDef(window: HealthWindow): HealthWindowDef {
	return HEALTH_WINDOWS.find((w) => w.value === window) ?? HEALTH_WINDOWS[1];
}

/**
 * Everything that differs between an hourly and a daily bucket lives here, so
 * the rest of the module (and the timeline component) never branches on the
 * granularity string: the bucket-key format is defined once, alongside the code
 * that reads it back into an instant.
 */
interface GranularityDef {
	/** Milliseconds spanned by one bucket. */
	stepMs: number;
	/** Truncate an ISO timestamp to this granularity's bucket key. */
	keyOf(iso: string): string;
	/** The current bucket's start (UTC epoch ms) for a given `now`. */
	floor(now: Date): number;
	/** The full ISO instant at the start of a bucket key. */
	keyToIso(key: string): string;
	/** Singular unit word, for accessible summaries ("hour" / "day"). */
	unit: string;
}

export const GRANULARITY: Record<Granularity, GranularityDef> = {
	// "2026-09-22T14:03:11.000Z" -> "2026-09-22T14".
	hour: {
		stepMs: 3_600_000,
		keyOf: (iso) => iso.slice(0, 13),
		floor: (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()),
		keyToIso: (key) => `${key}:00:00.000Z`,
		unit: "hour",
	},
	// "2026-09-22T14:03:11.000Z" -> "2026-09-22".
	day: {
		stepMs: 86_400_000,
		keyOf: (iso) => iso.slice(0, 10),
		floor: (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
		keyToIso: (key) => `${key}T00:00:00.000Z`,
		unit: "day",
	},
};

/**
 * The inclusive list of bucket keys ending at the current hour/day (oldest
 * first) - one entry per segment the timeline draws, so a bucket with no checks
 * still gets a (grey "no data") slot rather than being dropped.
 */
export function bucketKeys(window: HealthWindow, now: Date = new Date()): string[] {
	const def = windowDef(window);
	const g = GRANULARITY[def.granularity];
	const end = g.floor(now);
	const keys: string[] = [];
	for (let i = def.buckets - 1; i >= 0; i--) {
		keys.push(g.keyOf(new Date(end - i * g.stepMs).toISOString()));
	}
	return keys;
}

/**
 * The full ISO instant at the start of a window's first bucket, used as the
 * lower bound when paging `/health/history` (which has no date-range filter).
 */
export function windowStartIso(window: HealthWindow, now: Date = new Date()): string {
	const g = GRANULARITY[windowDef(window).granularity];
	return g.keyToIso(bucketKeys(window, now)[0]);
}

export type DayStatus = "operational" | "degraded" | "outage" | "no-data";

/** Statuses worst-last, the single source for legends and status iteration. */
export const STATUSES: ReadonlyArray<DayStatus> = ["operational", "degraded", "outage", "no-data"];

/** The Tag colour for a status - shared by every page that tags a model. */
export const STATUS_TAG: Record<DayStatus, "green" | "yellow" | "red" | "grey"> = {
	operational: "green",
	degraded: "yellow",
	outage: "red",
	"no-data": "grey",
};

/** Worse statuses rank higher, so rows/banners can sort problems to the top. */
const STATUS_RANK: Record<DayStatus, number> = {
	"no-data": 0,
	operational: 1,
	degraded: 2,
	outage: 3,
};

export interface HealthBucket {
	/** Truncated-ISO key this segment covers: "YYYY-MM-DD" or "YYYY-MM-DDTHH" (UTC). */
	key: string;
	/** Health checks recorded in this bucket. */
	total: number;
	/** Of those, how many reported unhealthy. */
	unhealthy: number;
	status: DayStatus;
	/** Percentage of checks that were healthy, or null when there were none. */
	uptimePct: number | null;
}

/** Classify a bucket from its healthy/unhealthy check counts. */
function classify(total: number, unhealthy: number): DayStatus {
	if (total === 0) return "no-data";
	if (unhealthy === 0) return "operational";
	if (unhealthy >= total) return "outage";
	return "degraded";
}

/**
 * One bucket per key in `keys` (oldest first) for a single model's checks.
 * Checks are placed by the UTC hour/day of their `checkedAt`; anything outside
 * the window is ignored. Empty buckets come back as `no-data` so the strip
 * stays aligned to the window.
 */
export function bucketHealth(
	checks: ReadonlyArray<LitellmHealthCheck>,
	keys: ReadonlyArray<string>,
	granularity: Granularity,
): HealthBucket[] {
	const keyOf = GRANULARITY[granularity].keyOf;
	const byKey = new Map<string, { total: number; unhealthy: number }>();
	for (const key of keys) byKey.set(key, { total: 0, unhealthy: 0 });
	for (const check of checks) {
		const bucket = byKey.get(keyOf(check.checkedAt));
		if (!bucket) continue;
		bucket.total += 1;
		if (check.status === "unhealthy") bucket.unhealthy += 1;
	}
	return keys.map((key) => {
		const { total, unhealthy } = byKey.get(key)!;
		return {
			key,
			total,
			unhealthy,
			status: classify(total, unhealthy),
			uptimePct: total > 0 ? ((total - unhealthy) / total) * 100 : null,
		};
	});
}

export interface ModelHealth {
	/** The model label the checks are grouped under. */
	model: string;
	segments: HealthBucket[];
	/** Healthy checks as a percentage of all checks in the window, or null if none. */
	uptimePct: number | null;
	/** Status of this model's single most recent check (never "degraded"). */
	currentStatus: DayStatus;
	/** Buckets in the window with at least one unhealthy check. */
	incidents: number;
}

/** The most recent check's status for a model (operational/outage), or no-data. */
function currentStatusOf(checks: ReadonlyArray<LitellmHealthCheck>): DayStatus {
	let latest: LitellmHealthCheck | undefined;
	for (const check of checks) {
		if (!latest || check.checkedAt > latest.checkedAt) latest = check;
	}
	if (!latest) return "no-data";
	return latest.status === "unhealthy" ? "outage" : "operational";
}

export interface HealthRollup {
	/** Models that have at least one check in the window. */
	modelsWithData: number;
	/** Models whose latest check is unhealthy. */
	down: number;
	/** Models with one or more incident buckets in the window (but currently up). */
	recentIncidents: number;
	/** The worst current status across models, for the banner colour. */
	worst: DayStatus;
}

export interface HealthSummary {
	models: ModelHealth[];
	rollup: HealthRollup;
}

/**
 * Combine health-check lists (typically the `/health/latest` snapshot and the
 * `/health/history` page), dropping duplicates by (model, checkedAt) - the most
 * recent check appears in both sources.
 */
export function mergeHealthChecks(...lists: ReadonlyArray<ReadonlyArray<LitellmHealthCheck>>): LitellmHealthCheck[] {
	const seen = new Set<string>();
	const merged: LitellmHealthCheck[] = [];
	for (const list of lists) {
		for (const check of list) {
			const key = `${check.model}\u0000${check.checkedAt}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(check);
		}
	}
	return merged;
}

/**
 * Per-model health over the window plus an overall roll-up for the status
 * banner. `modelLabels` drives which rows appear and in what order to start
 * (usually every configured model), so a model with no checks still shows a
 * row of grey "no data" segments rather than vanishing. Rows are then sorted
 * worst-first: current outages, then models with recent incidents, then by
 * ascending uptime, so problems surface at a glance.
 */
export function summariseModelHealth(
	checks: ReadonlyArray<LitellmHealthCheck>,
	modelLabels: ReadonlyArray<string>,
	keys: ReadonlyArray<string>,
	granularity: Granularity,
): HealthSummary {
	const byModel = new Map<string, LitellmHealthCheck[]>();
	for (const label of modelLabels) byModel.set(label, []);
	for (const check of checks) {
		// Only track checks for a model we're rendering a row for.
		const list = byModel.get(check.model);
		if (list) list.push(check);
	}

	const models: ModelHealth[] = [...byModel.entries()].map(([model, modelChecks]) => {
		const segments = bucketHealth(modelChecks, keys, granularity);
		// One pass over the segments for the totals and the incident count.
		let total = 0;
		let unhealthy = 0;
		let incidents = 0;
		for (const s of segments) {
			total += s.total;
			unhealthy += s.unhealthy;
			if (s.status === "degraded" || s.status === "outage") incidents += 1;
		}
		return {
			model,
			segments,
			uptimePct: total > 0 ? ((total - unhealthy) / total) * 100 : null,
			currentStatus: currentStatusOf(modelChecks),
			incidents,
		};
	});

	models.sort((a, b) => {
		const rank = STATUS_RANK[b.currentStatus] - STATUS_RANK[a.currentStatus];
		if (rank !== 0) return rank;
		if (b.incidents !== a.incidents) return b.incidents - a.incidents;
		const au = a.uptimePct ?? Infinity;
		const bu = b.uptimePct ?? Infinity;
		if (au !== bu) return au - bu;
		return a.model.localeCompare(b.model);
	});

	// One pass over the models for every roll-up counter.
	const rollup: HealthRollup = { modelsWithData: 0, down: 0, recentIncidents: 0, worst: "no-data" };
	for (const m of models) {
		if (m.currentStatus !== "no-data") rollup.modelsWithData += 1;
		if (m.currentStatus === "outage") rollup.down += 1;
		else if (m.incidents > 0) rollup.recentIncidents += 1;
		if (STATUS_RANK[m.currentStatus] > STATUS_RANK[rollup.worst]) rollup.worst = m.currentStatus;
	}

	return { models, rollup };
}

/** Uptime as a percentage string (e.g. "99.82%"), or "No data" when unmeasured. */
export function formatUptime(uptimePct: number | null): string {
	if (uptimePct === null) return "No data";
	// Two decimals is the statuspage convention, but never round a real dip up
	// to a misleading "100%".
	if (uptimePct > 99.99 && uptimePct < 100) return "99.99%";
	return `${parseFloat(uptimePct.toFixed(2))}%`;
}

/** Human label for a status, used in tooltips and the legend. */
export function statusLabel(status: DayStatus): string {
	switch (status) {
		case "operational":
			return "Operational";
		case "degraded":
			return "Degraded";
		case "outage":
			return "Outage";
		case "no-data":
			return "No data";
	}
}
