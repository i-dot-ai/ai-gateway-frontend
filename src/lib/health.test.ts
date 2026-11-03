import { describe, expect, it } from "vitest";
import type { LitellmHealthCheck } from "./litellm";
import {
	bucketHealth,
	bucketKeys,
	formatUptime,
	statusLabel,
	summariseModelHealth,
	windowDef,
	windowStartIso,
} from "./health";

function check(partial: Partial<LitellmHealthCheck>): LitellmHealthCheck {
	return {
		model: "gpt-4o",
		status: "healthy",
		checkedAt: "2026-09-20T00:00:00.000Z",
		...partial,
	};
}

describe("windowDef", () => {
	it("maps windows to their granularity and bucket counts", () => {
		expect(windowDef("24h")).toMatchObject({ granularity: "hour", buckets: 24 });
		expect(windowDef("7d")).toMatchObject({ granularity: "day", buckets: 7 });
		expect(windowDef("90d")).toMatchObject({ granularity: "day", buckets: 90 });
	});
});

describe("bucketKeys", () => {
	it("returns one hourly key per hour, ending at the current hour, oldest first", () => {
		const keys = bucketKeys("24h", new Date("2026-09-22T13:30:00Z"));
		expect(keys).toHaveLength(24);
		expect(keys[0]).toBe("2026-09-21T14");
		expect(keys[keys.length - 1]).toBe("2026-09-22T13");
	});

	it("returns one daily key per day, ending today, oldest first", () => {
		const keys = bucketKeys("7d", new Date("2026-09-22T13:00:00Z"));
		expect(keys).toHaveLength(7);
		expect(keys[0]).toBe("2026-09-16");
		expect(keys[keys.length - 1]).toBe("2026-09-22");
	});

	it("returns 90 daily keys for the 90-day window", () => {
		expect(bucketKeys("90d", new Date("2026-09-22T00:00:00Z"))).toHaveLength(90);
	});
});

describe("windowStartIso", () => {
	it("gives the full ISO instant of the first bucket", () => {
		expect(windowStartIso("24h", new Date("2026-09-22T13:30:00Z"))).toBe("2026-09-21T14:00:00.000Z");
		expect(windowStartIso("7d", new Date("2026-09-22T13:00:00Z"))).toBe("2026-09-16T00:00:00.000Z");
	});
});

describe("bucketHealth (daily)", () => {
	const keys = ["2026-09-18", "2026-09-19", "2026-09-20"];

	it("classifies each day and aligns to the key window", () => {
		const checks = [
			// 2026-09-18: all healthy -> operational
			check({ checkedAt: "2026-09-18T00:00:00Z", status: "healthy" }),
			check({ checkedAt: "2026-09-18T06:00:00Z", status: "healthy" }),
			// 2026-09-19: one of two unhealthy -> degraded
			check({ checkedAt: "2026-09-19T00:00:00Z", status: "healthy" }),
			check({ checkedAt: "2026-09-19T06:00:00Z", status: "unhealthy" }),
			// 2026-09-20: all unhealthy -> outage
			check({ checkedAt: "2026-09-20T00:00:00Z", status: "unhealthy" }),
		];
		const buckets = bucketHealth(checks, keys, "day");

		expect(buckets.map((b) => b.status)).toEqual(["operational", "degraded", "outage"]);
		expect(buckets[0].uptimePct).toBe(100);
		expect(buckets[1].uptimePct).toBe(50);
		expect(buckets[2].uptimePct).toBe(0);
	});

	it("marks buckets with no checks as no-data with null uptime", () => {
		const buckets = bucketHealth([], keys, "day");
		expect(buckets).toHaveLength(3);
		expect(buckets.every((b) => b.status === "no-data")).toBe(true);
		expect(buckets.every((b) => b.uptimePct === null && b.total === 0)).toBe(true);
	});

	it("ignores checks outside the window", () => {
		const buckets = bucketHealth([check({ checkedAt: "2026-01-01T00:00:00Z" })], keys, "day");
		expect(buckets.every((b) => b.total === 0)).toBe(true);
	});
});

describe("bucketHealth (hourly)", () => {
	const keys = ["2026-09-20T00", "2026-09-20T01", "2026-09-20T02"];

	it("buckets checks by the hour", () => {
		const checks = [
			check({ checkedAt: "2026-09-20T00:10:00Z", status: "healthy" }),
			check({ checkedAt: "2026-09-20T01:05:00Z", status: "healthy" }),
			check({ checkedAt: "2026-09-20T01:45:00Z", status: "unhealthy" }),
			check({ checkedAt: "2026-09-20T02:30:00Z", status: "unhealthy" }),
		];
		const buckets = bucketHealth(checks, keys, "hour");
		expect(buckets.map((b) => b.status)).toEqual(["operational", "degraded", "outage"]);
	});
});

describe("summariseModelHealth", () => {
	const keys = ["2026-09-19", "2026-09-20"];

	it("keeps a row for a configured model with no checks", () => {
		const { models } = summariseModelHealth([], ["gpt-4o", "claude"], keys, "day");
		expect(models).toHaveLength(2);
		expect(models.every((m) => m.uptimePct === null && m.currentStatus === "no-data")).toBe(true);
	});

	it("derives current status from the single most recent check", () => {
		const checks = [
			check({ model: "gpt-4o", checkedAt: "2026-09-20T00:00:00Z", status: "unhealthy" }),
			check({ model: "gpt-4o", checkedAt: "2026-09-20T06:00:00Z", status: "healthy" }),
		];
		const { models } = summariseModelHealth(checks, ["gpt-4o"], keys, "day");
		// Latest check (06:00) is healthy, so current status is operational even
		// though the day as a whole was degraded.
		expect(models[0].currentStatus).toBe("operational");
		expect(models[0].incidents).toBe(1);
		expect(models[0].uptimePct).toBe(50);
	});

	it("sorts worst-first: current outages before healthy models", () => {
		const checks = [
			check({ model: "healthy-model", checkedAt: "2026-09-20T00:00:00Z", status: "healthy" }),
			check({ model: "down-model", checkedAt: "2026-09-20T00:00:00Z", status: "unhealthy" }),
		];
		const { models, rollup } = summariseModelHealth(checks, ["healthy-model", "down-model"], keys, "day");
		expect(models[0].model).toBe("down-model");
		expect(rollup.down).toBe(1);
		expect(rollup.worst).toBe("outage");
	});

	it("counts models with recent incidents that have since recovered", () => {
		const checks = [
			check({ model: "flaky", checkedAt: "2026-09-19T00:00:00Z", status: "unhealthy" }),
			check({ model: "flaky", checkedAt: "2026-09-20T00:00:00Z", status: "healthy" }),
		];
		const { rollup } = summariseModelHealth(checks, ["flaky"], keys, "day");
		expect(rollup.down).toBe(0);
		expect(rollup.recentIncidents).toBe(1);
	});

	it("ignores checks for models not in the label list", () => {
		const { models } = summariseModelHealth(
			[check({ model: "unlisted", status: "unhealthy" })],
			["gpt-4o"],
			keys,
			"day",
		);
		expect(models).toHaveLength(1);
		expect(models[0].currentStatus).toBe("no-data");
	});
});

describe("formatUptime", () => {
	it("shows No data for null", () => {
		expect(formatUptime(null)).toBe("No data");
	});

	it("formats percentages without misleading rounding", () => {
		expect(formatUptime(100)).toBe("100%");
		expect(formatUptime(99.816)).toBe("99.82%");
		expect(formatUptime(99.999)).toBe("99.99%");
		expect(formatUptime(0)).toBe("0%");
	});
});

describe("statusLabel", () => {
	it("labels every status", () => {
		expect(statusLabel("operational")).toBe("Operational");
		expect(statusLabel("degraded")).toBe("Degraded");
		expect(statusLabel("outage")).toBe("Outage");
		expect(statusLabel("no-data")).toBe("No data");
	});
});
