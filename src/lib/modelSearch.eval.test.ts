/**
 * Model search answer-quality eval, run against a live dev server started with
 * MODEL_SEARCH_REFRESH=1 so it has provider pages and Arena data:
 *   MODEL_SEARCH_EVAL=1 npx vitest run src/lib/modelSearch.eval.test.ts
 * Optional EVAL_BASE_URL (default http://localhost:4321). Skipped otherwise.
 *
 * Answers are read from the same HTML partial the page uses, via the data
 * attributes each card carries, so the eval exercises the real path.
 *
 * Checks are relative to the current data (e.g. "a top Code Arena model we
 * serve"), so they stay valid as leaderboards and the catalogue change.
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import type { ArenaRanking } from './arena';
import { getAllModels, type LitellmModel } from './litellm';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:4321';
const TIMEOUT_MS = 90_000;

interface AskResult {
	suggestions: Array<{ name: string; reason: string; arena_evidence: Array<{ label: string }> }>;
	error?: string;
}

/** Cards from the /models/suggestions partial, read back from their data attributes. */
async function ask(q: string): Promise<AskResult> {
	const response = await fetch(`${BASE}/models/suggestions?q=${encodeURIComponent(q)}`);
	const html = await response.text();
	if (!response.ok) return { suggestions: [], error: `HTTP ${response.status}` };
	const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
	// Astro renders an empty attribute as a bare name, so data-evidence may have no value.
	const suggestions = [...html.matchAll(/data-model-name="([^"]*)" data-reason="([^"]*)" data-evidence(?:="([^"]*)")?/g)].map((m) => ({
		name: decode(m[1]),
		reason: decode(m[2]),
		arena_evidence: decode(m[3] ?? '').split('|').filter(Boolean).map((label) => ({ label })),
	}));
	return { suggestions };
}

async function arenaByModel(): Promise<Record<string, ArenaRanking[]>> {
	return (await (await fetch(`${BASE}/api/models/details`)).json()).arena;
}

/** Names of our models in the best tie group on a leaderboard. */
function topGroup(arena: Record<string, ArenaRanking[]>, label: string, slack = 0): Set<string> {
	const entries = Object.entries(arena).flatMap(([name, rs]) => rs.filter((r) => r.label === label).map((r) => [name, r.rank_ub] as const));
	const best = Math.min(...entries.map(([, ub]) => ub));
	return new Set(entries.filter(([, ub]) => ub <= best + slack).map(([name]) => name));
}

describe.skipIf(!process.env.MODEL_SEARCH_EVAL)('model search eval', () => {
	let models: ReadonlyArray<LitellmModel> = [];
	let arena: Record<string, ArenaRanking[]> = {};
	const byName = (n: string) => models.find((m) => m.name === n)!;

	it('loads data', async () => {
		models = (await getAllModels()).models;
		arena = await arenaByModel();
		expect(Object.keys(arena).length).toBeGreaterThan(20);
	}, TIMEOUT_MS);

	function checkCommon(result: AskResult) {
		expect(result.error).toBeUndefined();
		expect(result.suggestions.length).toBeGreaterThan(0);
		for (const s of result.suggestions) {
			const labels = new Set((arena[s.name] ?? []).map((r) => r.label));
			for (const e of s.arena_evidence) expect(labels.has(e.label), `${s.name} cites ${e.label}`).toBe(true);
		}
	}

	const cases: Array<[string, (r: AskResult) => void]> = [
		['best coder', (r) => {
			const top = topGroup(arena, 'Code Arena (building apps)', 2);
			expect(top.has(r.suggestions[0].name), `expected first pick in ${[...top]}`).toBe(true);
			expect(r.suggestions.some((s) => s.arena_evidence.length > 0), 'cards show Arena evidence').toBe(true);
		}],
		['best model for a coding agent', (r) => {
			const top = new Set([...topGroup(arena, 'Agent Arena overall', 2), ...topGroup(arena, 'Code Arena (building apps)', 1)]);
			expect(r.suggestions.some((s) => top.has(s.name)), `expected one of ${[...top]}`).toBe(true);
		}],
		['best model for long documents', (r) => {
			const top = topGroup(arena, 'Longer queries', 3);
			expect(r.suggestions.some((s) => top.has(s.name)), `expected one of ${[...top]}`).toBe(true);
		}],
		['cheapest model for simple tasks', (r) => {
			const costs = models.filter((m) => m.mode !== 'embedding' && m.input_cost_per_token !== undefined).map((m) => m.input_cost_per_token!).sort((a, b) => a - b);
			const quartile = costs[Math.floor(costs.length / 4)];
			for (const s of r.suggestions) expect(byName(s.name).input_cost_per_token ?? Infinity, `${s.name} cost`).toBeLessThanOrEqual(quartile);
		}],
		['best UK-hosted model for drafting documents', (r) => {
			for (const s of r.suggestions) expect(byName(s.name).location, `${s.name} location`).toBe('UK');
		}],
		['summarising sensitive policy papers', (r) => {
			for (const s of r.suggestions) expect(['UK', 'EU'], `${s.name} location`).toContain(byName(s.name).location);
		}],
		['which model is good at welsh', (r) => {
			expect(r.suggestions.length).toBeGreaterThan(0);
		}],
	];
	// Broad questions should get a full set of three.
	const WANT_THREE = new Set(['best coder', 'best model for long documents', 'cheapest model for simple tasks', 'which model is good at welsh']);

	for (const [q, check] of cases) {
		it(q, async () => {
			const r = await ask(q);
			checkCommon(r);
			check(r);
			if (WANT_THREE.has(q)) expect(r.suggestions.length, 'suggestion count').toBe(3);
		}, TIMEOUT_MS);
	}
});
