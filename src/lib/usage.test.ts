import { describe, expect, it } from "vitest";
import type { LitellmCost, LitellmProviderCost } from "./litellm";
import {
	bucketDailyUsage,
	bucketValues,
	compactAxis,
	formatChartTick,
	formatChartValue,
	formatSpan,
	formatFailureRate,
	formatRequests,
	formatShare,
	formatSpend,
	formatTokens,
	granularityFor,
	listDates,
	providerLabel,
	scaleBars,
	summariseDailyUsage,
	summariseKeyActivity,
	summariseKeyRequests,
	summariseKeysUsage,
	summariseModelSeries,
	summariseModelUsage,
	summariseProviderUsage,
} from "./usage";

function cost(partial: Partial<LitellmCost>): LitellmCost {
	return {
		date: "2026-09-01",
		model_name: "gpt-4",
		spend: 0,
		total_tokens: 0,
		prompt_tokens: 0,
		completion_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		api_requests: 0,
		failed_requests: 0,
		key_alias: "personal/a@example.com/default",
		key_token: "tok-a",
		user_id: "user-a",
		team_id: "",
		team_name: "",
		...partial,
	};
}

describe("summariseKeysUsage", () => {
	it("totals spend, tokens, requests, failures and the token breakdown across all rows", () => {
		const costs = [
			cost({ key_alias: "mine-1", spend: 1.5, total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, api_requests: 3, failed_requests: 1 }),
			cost({ key_alias: "mine-1", spend: 0.5, total_tokens: 50, prompt_tokens: 40, completion_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, api_requests: 2, failed_requests: 0 }),
			cost({ key_alias: "mine-2", spend: 2, total_tokens: 200, prompt_tokens: 150, completion_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, api_requests: 5, failed_requests: 2 }),
		];

		expect(summariseKeysUsage(costs)).toEqual({
			spend: 4, tokens: 350, requests: 10, failures: 3,
			promptTokens: 270, completionTokens: 80, cacheReadTokens: 190, cacheCreationTokens: 35,
		});
	});

	it("returns zeroes for empty inputs", () => {
		expect(summariseKeysUsage([])).toEqual({ spend: 0, tokens: 0, requests: 0, failures: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
	});
});

describe("summariseModelSeries", () => {
	const dates = ["2026-09-01", "2026-09-02"];
	const spend = (c: LitellmCost) => c.spend;

	it("keeps the top 5 models busiest first and folds the rest into Other", () => {
		const costs = ["a", "b", "c", "d", "e", "f", "g"].map((m, i) =>
			cost({ key_alias: "mine", model_name: m, spend: 10 - i }));
		const series = summariseModelSeries(costs, dates, spend);
		expect(series.map((s) => s.model)).toEqual(["a", "b", "c", "d", "e", "Other"]);
		expect(series[5].daily).toEqual([5 + 4, 0]);
	});

	it("aligns each series to the dates, zero-filling days without usage", () => {
		const costs = [
			cost({ key_alias: "mine", model_name: "gpt-4", date: "2026-09-02", spend: 2 }),
			cost({ key_alias: "mine", model_name: "claude", date: "2026-09-01", spend: 1 }),
		];
		expect(summariseModelSeries(costs, dates, spend)).toEqual([
			{ model: "gpt-4", daily: [0, 2] },
			{ model: "claude", daily: [1, 0] },
		]);
	});

	it("groups series by a custom key when given one", () => {
		const costs = [
			cost({ model_name: "gpt-4", team_name: "policy", date: "2026-09-01", spend: 1 }),
			cost({ model_name: "claude", team_name: "policy", date: "2026-09-01", spend: 2 }),
			cost({ model_name: "gpt-4", team_name: "", date: "2026-09-02", spend: 4 }),
		];
		expect(summariseModelSeries(costs, dates, spend, (c) => c.team_name || "Personal keys")).toEqual([
			{ model: "Personal keys", daily: [0, 4] },
			{ model: "policy", daily: [3, 0] },
		]);
	});

	it("returns an empty array for no rows", () => {
		expect(summariseModelSeries([], dates, spend)).toEqual([]);
	});
});

describe("summariseModelUsage", () => {
	it("totals each metric per model across all rows", () => {
		const costs = [
			cost({ model_name: "gpt-4", spend: 1, total_tokens: 100, api_requests: 3, failed_requests: 1 }),
			cost({ model_name: "gpt-4", spend: 2, total_tokens: 200, api_requests: 4, failed_requests: 0 }),
			cost({ model_name: "claude", spend: 0.5, total_tokens: 50, api_requests: 1, failed_requests: 0 }),
		];
		expect(summariseModelUsage(costs)).toEqual([
			{ model: "gpt-4", spend: 3, tokens: 300, requests: 7, failures: 1 },
			{ model: "claude", spend: 0.5, tokens: 50, requests: 1, failures: 0 },
		]);
	});

	it("returns an empty array for no rows", () => {
		expect(summariseModelUsage([])).toEqual([]);
	});

	it("groups by a custom key when given one", () => {
		const costs = [
			cost({ key_alias: "a", team_name: "policy", spend: 1 }),
			cost({ key_alias: "b", team_name: "policy", spend: 2 }),
			cost({ key_alias: "c", team_name: "", spend: 4 }),
		];
		expect(summariseModelUsage(costs, (c) => c.team_name || "Personal")).toEqual([
			{ model: "policy", spend: 3, tokens: 0, requests: 0, failures: 0 },
			{ model: "Personal", spend: 4, tokens: 0, requests: 0, failures: 0 },
		]);
	});
});

describe("summariseKeyRequests", () => {
	it("totals requests and failures per key across all rows", () => {
		const costs = [
			cost({ key_alias: "mine-1", api_requests: 10, failed_requests: 2, spend: 1 }),
			cost({ key_alias: "mine-1", api_requests: 5, failed_requests: 0, spend: 0.5 }),
			cost({ key_alias: "mine-2", api_requests: 8, failed_requests: 3, spend: 2 }),
		];
		expect(summariseKeyRequests(costs)).toEqual([
			{ name: "mine-1", requests: 15, failures: 2, spend: 1.5, tokens: 0 },
			{ name: "mine-2", requests: 8, failures: 3, spend: 2, tokens: 0 },
		]);
	});

	it("returns an empty array for no rows", () => {
		expect(summariseKeyRequests([])).toEqual([]);
	});
});

function providerCost(partial: Partial<LitellmProviderCost>): LitellmProviderCost {
	return {
		date: "2024-06-01",
		provider: "vertex_ai",
		spend: 0,
		total_tokens: 0,
		api_requests: 0,
		failed_requests: 0,
		key_alias: "personal/a@example.com/default",
		...partial,
	};
}

describe("summariseProviderUsage", () => {
	it("totals each metric per provider across all rows", () => {
		const costs = [
			providerCost({ provider: "vertex_ai", spend: 1, total_tokens: 100, api_requests: 3, failed_requests: 1 }),
			providerCost({ provider: "vertex_ai", spend: 2, total_tokens: 200, api_requests: 4, failed_requests: 0 }),
			providerCost({ provider: "openai", spend: 0.5, total_tokens: 50, api_requests: 1, failed_requests: 0 }),
		];
		expect(summariseProviderUsage(costs)).toEqual([
			{ provider: "vertex_ai", spend: 3, tokens: 300, requests: 7, failures: 1 },
			{ provider: "openai", spend: 0.5, tokens: 50, requests: 1, failures: 0 },
		]);
	});

	it("returns an empty array for no rows", () => {
		expect(summariseProviderUsage([])).toEqual([]);
	});
});

describe("providerLabel", () => {
	it("maps a known provider id to a friendly name", () => {
		expect(providerLabel("vertex_ai")).toBe("Vertex AI");
		expect(providerLabel("openai")).toBe("OpenAI");
	});

	it("labels the unknown bucket as Unattributed", () => {
		expect(providerLabel("unknown")).toBe("Unattributed");
	});

	it("falls through to the raw id for an unrecognised provider", () => {
		expect(providerLabel("some_new_provider")).toBe("some_new_provider");
	});
});

describe("summariseDailyUsage", () => {
	const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];

	it("totals each metric per day across all rows, zero-filling quiet days", () => {
		const costs = [
			cost({ key_alias: "mine", date: "2026-09-01", spend: 1, total_tokens: 100, api_requests: 4, failed_requests: 1 }),
			cost({ key_alias: "mine", date: "2026-09-01", spend: 0.5, total_tokens: 50, api_requests: 1, failed_requests: 0 }),
			cost({ key_alias: "theirs", date: "2026-09-02", spend: 9, total_tokens: 999, api_requests: 9, failed_requests: 9 }),
		];
		expect(summariseDailyUsage(costs, dates)).toEqual([
			{ date: "2026-09-01", spend: 1.5, tokens: 150, requests: 5, failures: 1 },
			{ date: "2026-09-02", spend: 9, tokens: 999, requests: 9, failures: 9 },
			{ date: "2026-09-03", spend: 0, tokens: 0, requests: 0, failures: 0 },
		]);
	});
});

describe("granularityFor", () => {
	it("uses days up to a month and weeks beyond", () => {
		expect(granularityFor(7)).toBe("day");
		expect(granularityFor(31)).toBe("day");
		expect(granularityFor(32)).toBe("week");
		expect(granularityFor(91)).toBe("week");
	});
});

describe("bucketDailyUsage", () => {
	const daily = [
		{ date: "2026-09-01", spend: 1, tokens: 10, requests: 2, failures: 0 },
		{ date: "2026-09-02", spend: 2, tokens: 20, requests: 3, failures: 1 },
		{ date: "2026-09-03", spend: 3, tokens: 30, requests: 4, failures: 0 },
	];

	it("returns one bucket per day unchanged at day granularity", () => {
		expect(bucketDailyUsage(daily, "day")).toEqual([
			{ date: "2026-09-01", end: "2026-09-01", spend: 1, tokens: 10, requests: 2, failures: 0 },
			{ date: "2026-09-02", end: "2026-09-02", spend: 2, tokens: 20, requests: 3, failures: 1 },
			{ date: "2026-09-03", end: "2026-09-03", spend: 3, tokens: 30, requests: 4, failures: 0 },
		]);
	});

	it("sums metrics into weekly buckets anchored to the first day, ending on the last", () => {
		const week = Array.from({ length: 9 }, (_, i) => ({
			date: `2026-09-${String(i + 1).padStart(2, "0")}`,
			spend: 1,
			tokens: 10,
			requests: 1,
			failures: 0,
		}));
		expect(bucketDailyUsage(week, "week")).toEqual([
			{ date: "2026-09-01", end: "2026-09-07", spend: 7, tokens: 70, requests: 7, failures: 0 },
			{ date: "2026-09-08", end: "2026-09-09", spend: 2, tokens: 20, requests: 2, failures: 0 },
		]);
	});
});

describe("bucketValues", () => {
	it("sums an ordered value series into buckets of the granularity's size", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8];
		expect(bucketValues(values, "day")).toEqual(values);
		expect(bucketValues(values, "week")).toEqual([28, 8]);
	});
});

describe("formatFailureRate", () => {
	it("returns 0% when there are no failures or no requests", () => {
		expect(formatFailureRate(0, 100)).toBe("0%");
		expect(formatFailureRate(0, 0)).toBe("0%");
		expect(formatFailureRate(5, 0)).toBe("0%");
	});

	it("shows up to two decimals and trims trailing zeroes", () => {
		expect(formatFailureRate(1, 1000)).toBe("0.1%");
		expect(formatFailureRate(2, 3200)).toBe("0.06%");
		expect(formatFailureRate(1, 8)).toBe("12.5%");
		expect(formatFailureRate(5, 5)).toBe("100%");
	});

	it("rounds to the requested number of decimals", () => {
		expect(formatFailureRate(299, 10_000, 1)).toBe("3%");
		expect(formatFailureRate(2991, 100_000, 1)).toBe("3%");
		expect(formatFailureRate(294, 10_000, 1)).toBe("2.9%");
		expect(formatFailureRate(1, 50_000, 1)).toBe("<0.1%");
	});

	it("never rounds a genuine failure down to 0%", () => {
		expect(formatFailureRate(1, 50_000)).toBe("<0.01%");
	});
});

describe("formatShare", () => {
	it("returns 0% when the part or whole is zero", () => {
		expect(formatShare(0, 100)).toBe("0%");
		expect(formatShare(50, 0)).toBe("0%");
	});

	it("rounds to a whole-number percentage", () => {
		expect(formatShare(1, 4)).toBe("25%");
		expect(formatShare(2, 3)).toBe("67%");
	});

	it("never rounds a real share down to 0% or up to 100%", () => {
		expect(formatShare(1, 1000)).toBe("<1%");
		expect(formatShare(996, 1000)).toBe("99%");
		expect(formatShare(1000, 1000)).toBe("100%");
	});
});

describe("scaleBars", () => {
	it("scales each value to 0-100 against the series max", () => {
		expect(scaleBars([0, 50, 100], 8)).toEqual([0, 50, 100]);
	});

	it("keeps zero at 0 but lifts small non-zero values to the floor", () => {
		expect(scaleBars([0, 1, 100], 12)).toEqual([0, 12, 100]);
	});

	it("returns all zeroes when every value is zero", () => {
		expect(scaleBars([0, 0, 0], 8)).toEqual([0, 0, 0]);
	});

	it("returns an empty array for no values", () => {
		expect(scaleBars([], 8)).toEqual([]);
	});
});

describe("listDates", () => {
	it("lists inclusive UTC days oldest first", () => {
		expect(listDates("2026-09-01", "2026-09-04")).toEqual([
			"2026-09-01",
			"2026-09-02",
			"2026-09-03",
			"2026-09-04",
		]);
	});

	it("returns a single day when start equals end", () => {
		expect(listDates("2026-09-01", "2026-09-01")).toEqual(["2026-09-01"]);
	});
});

describe("summariseKeyActivity", () => {
	const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];

	it("totals tokens per day for the alias, zero-filling quiet days", () => {
		const costs = [
			cost({ key_alias: "mine", date: "2026-09-01", total_tokens: 100 }),
			cost({ key_alias: "mine", date: "2026-09-01", total_tokens: 50 }),
			cost({ key_alias: "mine", date: "2026-09-03", total_tokens: 200 }),
			cost({ key_alias: "theirs", date: "2026-09-02", total_tokens: 999 }),
		];
		expect(summariseKeyActivity(costs, "mine", dates)).toEqual({
			daily: [150, 0, 200],
			lastActive: "2026-09-03",
		});
	});

	it("reports null lastActive when the key is unused", () => {
		expect(summariseKeyActivity([], "mine", dates)).toEqual({
			daily: [0, 0, 0],
			lastActive: null,
		});
	});
});

describe("formatSpend", () => {
	it("formats as USD with two decimals", () => {
		expect(formatSpend(0)).toBe("$0.00");
		expect(formatSpend(4.2)).toBe("$4.20");
		expect(formatSpend(1234.5)).toBe("$1,234.50");
		expect(formatSpend(43981.11)).toBe("$43,981.11");
	});
});

describe("formatTokens", () => {
	it("uses M / k suffixes above their thresholds and raw below 1,000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(2_300_000)).toBe("2.3M");
		expect(formatTokens(36_287_300_000)).toBe("36.3B");
	});
});

describe("formatRequests", () => {
	it("uses the same compact formatting as tokens", () => {
		expect(formatRequests(0)).toBe("0");
		expect(formatRequests(950)).toBe("950");
		expect(formatRequests(12_000)).toBe("12.0k");
	});
});

describe("formatChartTick", () => {
	const ticks = (...vs: number[]) => vs.map((value) => ({ value }));

	it("shows whole dollars when every spend tick is whole", () => {
		expect(formatChartTick(20, "spend", ticks(0, 20, 40))).toBe("$20");
		expect(formatChartTick(1000, "spend", ticks(0, 1000))).toBe("$1,000");
	});

	it("shows cents when any spend tick is fractional, so small spends don't read $0", () => {
		expect(formatChartTick(0, "spend", ticks(0, 0.25, 0.5))).toBe("$0.00");
		expect(formatChartTick(1, "spend", ticks(0, 0.5, 1))).toBe("$1.00");
	});

	it("ticks counts compactly", () => {
		expect(formatChartTick(15_000, "count")).toBe("15k");
		expect(formatChartTick(2_500, "count")).toBe("2.5k");
		expect(formatChartTick(400, "count")).toBe("400");
	});

	it("drops a trailing .0 from compact token ticks", () => {
		expect(formatChartTick(2_000_000, "tokens")).toBe("2M");
		expect(formatChartTick(1_500_000, "tokens")).toBe("1.5M");
	});

	it("ticks carbon in grams with a decimal below 1k, compactly above", () => {
		expect(formatChartTick(0.5, "carbon")).toBe("0.5");
		expect(formatChartTick(400, "carbon")).toBe("400");
		expect(formatChartTick(2_500, "carbon")).toBe("2.5k");
	});
});

describe("formatChartValue", () => {
	it("labels carbon tooltips in grams of CO2e", () => {
		expect(formatChartValue(63.64, "carbon")).toBe("63.6 g CO₂e");
		expect(formatChartValue(1250, "carbon")).toBe("1,250 g CO₂e");
	});
});

describe("compactAxis", () => {
	it("steps in whole compact units so no tick lands on a decimal", () => {
		expect(compactAxis(2_600_000)).toEqual({ max: 3_000_000, stepSize: 1_000_000 });
		expect(compactAxis(12_345)).toEqual({ max: 15_000, stepSize: 5_000 });
		expect(compactAxis(800)).toEqual({ max: 800, stepSize: 200 });
	});

	it("never steps below 1, and handles an empty axis", () => {
		expect(compactAxis(3)).toEqual({ max: 3, stepSize: 1 });
		expect(compactAxis(0)).toEqual({ max: 1, stepSize: 1 });
	});
});

describe("formatSpan", () => {
	it("labels a single day or a start-to-end span", () => {
		expect(formatSpan({ date: "2026-09-09", end: "2026-09-09" })).toBe("9 Sept 2026");
		expect(formatSpan({ date: "2026-09-09" })).toBe("9 Sept 2026");
		expect(formatSpan({ date: "2026-09-09", end: "2026-09-15" })).toBe("9 Sept 2026 to 15 Sept 2026");
		expect(formatSpan({ date: "2026-09-09", end: "2026-09-15" }, (d) => d)).toBe("2026-09-09 to 2026-09-15");
	});
});
