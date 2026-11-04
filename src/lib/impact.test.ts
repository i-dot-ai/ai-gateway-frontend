import { describe, expect, it } from 'vitest';
import type { LitellmCost, LitellmModel } from './litellm';
import {
	bucketImpact,
	buildImpactIndex,
	coveragePct,
	deriveImpactZone,
	estimateImpact,
	estimateRow,
	formatCo2,
	formatEnergy,
	formatParameters,
	formatRange,
	formatWater,
	impactPerDay,
	impactSourceLabel,
	rangeMid,
	resolveImpactModel,
	sumImpact,
	totalImpact,
	unresolvedLabel,
	zoneLabel,
} from './impact';

function model(overrides: Partial<LitellmModel> = {}): LitellmModel {
	return {
		id: 'id-1',
		name: 'bedrock-claude-opus-4-7-eu',
		provider: 'bedrock',
		mode: 'chat',
		litellm_model: 'bedrock/eu.anthropic.claude-opus-4-7',
		impact_model: 'anthropic/claude-opus-4-7',
		supports_vision: false,
		supports_function_calling: true,
		supports_audio_input: false,
		supports_reasoning: true,
		location: 'EU',
		...overrides,
	};
}

function cost(overrides: Partial<LitellmCost> = {}): LitellmCost {
	return {
		date: '2026-10-01',
		model_name: 'bedrock-claude-opus-4-7-eu',
		spend: 1,
		total_tokens: 1500,
		prompt_tokens: 500,
		completion_tokens: 1000,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		api_requests: 1,
		failed_requests: 0,
		key_alias: 'personal/alice@example.gov.uk/default',
		key_token: 'tok-alice',
		user_id: 'user-alice',
		team_id: '',
		team_name: '',
		...overrides,
	};
}

function resolved(m: LitellmModel) {
	const r = resolveImpactModel(m);
	if (!r.ok) throw new Error(`expected ${m.litellm_model} to resolve, got ${r.reason}`);
	return r.model;
}

describe('impact', () => {
	describe('deriveImpactZone', () => {
		const zone = (litellm_model: string, location?: string) => deriveImpactZone({ litellm_model, location });

		it('narrows EU by route', () => {
			expect(zone('azure/gpt-5.2', 'EU')).toBe('SWE');
			expect(zone('vertex_ai/gemini-2.5-pro', 'EU')).toBe('BEL');
			expect(zone('bedrock/eu.anthropic.claude-opus-4-7', 'EU')).toBe('IRL');
		});

		it('maps the other locations directly and falls back to the world mix', () => {
			expect(zone('azure/gpt-5.2', 'UK')).toBe('GBR');
			expect(zone('azure/gpt-5.2', 'US')).toBe('USA');
			expect(zone('azure/gpt-5.2', 'Global')).toBe('WOR');
			expect(zone('azure/gpt-5.2', undefined)).toBe('WOR');
		});
	});

	describe('resolveImpactModel', () => {
		it('resolves the declared impact_model and the zone from location', () => {
			expect(resolved(model())).toEqual({ provider: 'anthropic', modelName: 'claude-opus-4-7', zone: 'IRL' });
			expect(resolved(model({ litellm_model: 'azure/gpt-5.2', impact_model: 'openai/gpt-5.2', location: 'UK' }))).toEqual({ provider: 'openai', modelName: 'gpt-5.2', zone: 'GBR' });
		});

		it('falls back to the declared parameters when the registry has no entry', () => {
			const params = { total: 1000, active: 32, source: 'https://huggingface.co/moonshotai/Kimi-K2.5' };
			const kimi = model({ litellm_model: 'bedrock/moonshotai.kimi-k2.5', impact_model: undefined, location: 'UK', parameters: params });
			expect(resolved(kimi)).toEqual({ provider: 'huggingface_hub', modelName: 'gateway/bedrock/moonshotai.kimi-k2.5', zone: 'GBR', parameters: params });
			const e = estimateImpact(resolved(kimi), 1000, 1);
			expect(e.gwpKg.min).toBeGreaterThan(0);
			// A dense model of the same total is far costlier per token than a sparse one.
			const dense = resolved(model({ litellm_model: 'bedrock/example.dense-1t', impact_model: undefined, location: 'UK', parameters: { total: 1000 } }));
			expect(estimateImpact(dense, 1000, 1).gwpKg.min).toBeGreaterThan(e.gwpKg.min * 5);
		});

		it('prefers declared parameters over a declared registry entry, and reports an unknown one', () => {
			// A registry entry carries the vendor's own deployment figures; a Bedrock-served copy runs on neither.
			expect(resolved(model({ parameters: { total: 999 } })).parameters).toEqual({ total: 999 });
			// A declared entry the registry lacks is reported, not silently accepted.
			expect(resolveImpactModel(model({ impact_model: 'anthropic/claude-99' }))).toEqual({ ok: false, reason: 'not-in-registry' });
		});

		it('honours impact_model and impact_zone overrides from config.yml', () => {
			expect(resolved(model({ litellm_model: 'bedrock/mistral.ministral-3-8b-instruct', location: 'UK', impact_model: 'mistralai/ministral-8b-2512' }))).toEqual({
				provider: 'mistralai',
				modelName: 'ministral-8b-2512',
				zone: 'GBR',
			});
			expect(resolved(model({ impact_zone: 'FRA' })).zone).toBe('FRA');
		});

		it('says why a model has no estimate', () => {
			expect(resolveImpactModel(model({ mode: 'embedding', litellm_model: 'azure/text-embedding-3-large' }))).toEqual({ ok: false, reason: 'not-generation' });
			expect(resolveImpactModel(model({ mode: 'audio_transcription', litellm_model: 'azure/whisper' }))).toEqual({ ok: false, reason: 'not-generation' });
			expect(resolveImpactModel(model({ litellm_model: 'bedrock/qwen.qwen3-vl-235b-a22b', impact_model: undefined, location: 'UK' }))).toEqual({ ok: false, reason: 'not-in-registry' });
			// A declared entry naming something the registry lacks is reported, not silently accepted.
			expect(resolveImpactModel(model({ impact_model: 'anthropic/claude-99' }))).toEqual({ ok: false, reason: 'not-in-registry' });
			expect(unresolvedLabel('not-in-registry')).toMatch(/not in the ecologits registry and its size is not published/);
		});
	});

	describe('estimateImpact', () => {
		const opus = resolved(model());

		it('returns positive min/max ranges for every metric', () => {
			const e = estimateImpact(opus, 1000, 1);
			// Every registry model carries a water figure today; null is reserved for one that does not.
			expect(e.waterL).not.toBeNull();
			for (const r of [e.gwpKg, e.energyKwh, e.waterL!]) {
				expect(r.min).toBeGreaterThan(0);
				expect(r.max).toBeGreaterThanOrEqual(r.min);
			}
		});

		it('grows with output tokens', () => {
			expect(estimateImpact(opus, 2000, 1).gwpKg.min).toBeGreaterThan(estimateImpact(opus, 1000, 1).gwpKg.min);
		});

		it('reproduces the sum of individually estimated requests from their total and count', () => {
			const sizes = [100, 300, 600];
			const separately = sizes.map((n) => estimateImpact(opus, n, 1)).reduce((s, e) => s + e.gwpKg.max, 0);
			const together = estimateImpact(opus, 1000, 3).gwpKg.max;
			expect(together).toBeCloseTo(separately, 12);
		});

		it('is cleaner on a low-carbon grid than on the world mix', () => {
			const sweden = estimateImpact({ ...opus, zone: 'SWE' }, 1000, 1).gwpKg.max;
			const world = estimateImpact({ ...opus, zone: 'WOR' }, 1000, 1).gwpKg.max;
			expect(sweden).toBeLessThan(world);
		});
	});

	describe('impactPerDay and sumImpact', () => {
		const index = buildImpactIndex([
			model(),
			model({ id: 'id-2', name: 'bedrock-qwen3-vl-uk', litellm_model: 'bedrock/qwen.qwen3-vl-235b-a22b', impact_model: undefined, location: 'UK' }),
		]);
		const opus = resolved(model());

		it('sums rows per day, zero-fills quiet days and reports coverage over all output tokens', () => {
			const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
			const costs = [
				cost({ date: '2026-10-01', completion_tokens: 1000 }),
				cost({ date: '2026-10-02', completion_tokens: 500 }),
				// Out of range: ignored entirely.
				cost({ date: '2026-09-30', completion_tokens: 9000 }),
				// No estimate for this model, but its tokens count towards the total.
				cost({ date: '2026-10-02', model_name: 'bedrock-qwen3-vl-uk', completion_tokens: 500 }),
			];
			const days = impactPerDay(costs, index, dates);
			expect(days.map((d) => d.date)).toEqual(dates);
			expect(days.map((d) => d.totalTokens)).toEqual([1000, 1000, 0]);
			expect(days.map((d) => d.estimatedTokens)).toEqual([1000, 500, 0]);
			expect(days[2].gwpKg).toEqual({ min: 0, max: 0 });

			const t = sumImpact(days);
			expect(t.estimatedTokens).toBe(1500);
			expect(t.totalTokens).toBe(2000);
			expect(coveragePct(t)).toBe(75);
			const expected = estimateImpact(opus, 1000, 1).gwpKg.max + estimateImpact(opus, 500, 1).gwpKg.max;
			expect(t.gwpKg.max).toBeCloseTo(expected, 12);
		});

		it('counts only successful requests as generations', () => {
			const dates = ['2026-10-01'];
			const one = impactPerDay([cost({ api_requests: 1, failed_requests: 0 })], index, dates)[0].gwpKg.max;
			const withFailures = impactPerDay([cost({ api_requests: 5, failed_requests: 4 })], index, dates)[0].gwpKg.max;
			expect(withFailures).toBeCloseTo(one, 12);
		});

		it('is 100% covered when there was no usage', () => {
			expect(coveragePct(sumImpact(impactPerDay([], index, ['2026-10-01'])))).toBe(100);
		});

		it('skips unknown model aliases and rows with no output', () => {
			const t = sumImpact(impactPerDay([cost({ model_name: 'no-such-alias' }), cost({ completion_tokens: 0 })], index, ['2026-10-01']));
			expect(t.gwpKg.max).toBe(0);
			expect(t.estimatedTokens).toBe(0);
			expect(t.totalTokens).toBe(1000);
		});

		it('buckets a daily series from the start', () => {
			const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
			const daily = impactPerDay([cost({ date: '2026-10-01' }), cost({ date: '2026-10-08' })], index, dates);
			const weekly = bucketImpact(daily, 'week');
			expect(weekly).toHaveLength(2);
			expect(weekly[0].gwpKg.max).toBeCloseTo(daily[0].gwpKg.max, 12);
			expect(weekly[1].gwpKg.max).toBeCloseTo(daily[7].gwpKg.max, 12);
		});
	});

	describe('estimateRow', () => {
		const index = buildImpactIndex([
			model(),
			model({ id: 'id-2', name: 'bedrock-qwen3-vl-uk', litellm_model: 'bedrock/qwen.qwen3-vl-235b-a22b', impact_model: undefined, location: 'UK' }),
		]);
		const opus = resolved(model());

		it('estimates a row from its successful requests', () => {
			const e = estimateRow(cost({ completion_tokens: 1000, api_requests: 5, failed_requests: 3 }), index);
			const expected = estimateImpact(opus, 1000, 2);
			expect(e).toEqual({ gwpKg: expected.gwpKg, energyKwh: expected.energyKwh });
		});

		it('is null for an unresolved model, an unknown alias or a row with no output', () => {
			expect(estimateRow(cost({ model_name: 'bedrock-qwen3-vl-uk' }), index)).toBeNull();
			expect(estimateRow(cost({ model_name: 'no-such-alias' }), index)).toBeNull();
			expect(estimateRow(cost({ completion_tokens: 0 }), index)).toBeNull();
		});

	});

	describe('totalImpact', () => {
		const index = buildImpactIndex([
			model(),
			model({ id: 'id-2', name: 'bedrock-qwen3-vl-uk', litellm_model: 'bedrock/qwen.qwen3-vl-235b-a22b', impact_model: undefined, location: 'UK' }),
		]);
		const opus = resolved(model());

		it('sums estimated rows and counts unestimated output towards coverage', () => {
			const costs = [
				cost({ completion_tokens: 1000 }),
				cost({ completion_tokens: 400, api_requests: 3 }),
				cost({ model_name: 'bedrock-qwen3-vl-uk', completion_tokens: 600 }),
			];
			const t = totalImpact(costs.map((c) => [c, estimateRow(c, index)] as const));
			const expected = estimateImpact(opus, 1000, 1).gwpKg.max + estimateImpact(opus, 400, 3).gwpKg.max;
			expect(t.gwpKg.max).toBeCloseTo(expected, 12);
			expect(t.estimatedTokens).toBe(1400);
			expect(t.totalTokens).toBe(2000);
			expect(coveragePct(t)).toBe(70);
		});

		it('is zero with full coverage for no rows', () => {
			const t = totalImpact([]);
			expect(t.gwpKg).toEqual({ min: 0, max: 0 });
			expect(coveragePct(t)).toBe(100);
		});
	});

	describe('buildImpactIndex', () => {
		it('answers for the alias, the full LiteLLM id and the id without its route, as cost rows carry any of them', () => {
			// LiteLLM's daily activity keys models by the underlying id ("eu.anthropic.claude-opus-4-7"), not the alias.
			const index = buildImpactIndex([model()]);
			for (const key of ['bedrock-claude-opus-4-7-eu', 'bedrock/eu.anthropic.claude-opus-4-7', 'eu.anthropic.claude-opus-4-7']) {
				const r = index.get(key);
				expect(r?.ok && r.model.modelName, key).toBe('claude-opus-4-7');
			}
			expect(index.get('claude-opus-4-7')).toBeUndefined();
		});

		it('gives a later deployment its own alias key while the shared underlying id keeps the first', () => {
			// gpt-5.2-uk and gpt-5.2-sweden both route to azure/gpt-5.2. A row keyed by alias
			// resolves to that deployment; a row keyed by the bare id cannot say which served it.
			const index = buildImpactIndex([
				model({ name: 'gpt-5.2-uk', litellm_model: 'azure/gpt-5.2', location: 'UK', impact_model: 'openai/gpt-5.2' }),
				model({ name: 'gpt-5.2-sweden', litellm_model: 'azure/gpt-5.2', location: 'EU', impact_model: 'openai/gpt-5.2' }),
			]);
			const zone = (key: string) => { const r = index.get(key); return r?.ok ? r.model.zone : r; };
			expect(zone('gpt-5.2-uk')).toBe('GBR');
			expect(zone('gpt-5.2-sweden')).toBe('SWE');
			expect(zone('gpt-5.2')).toBe('GBR');
			expect(zone('azure/gpt-5.2')).toBe('GBR');
		});

		it('drops empty keys and collapses a bare id that has no route', () => {
			const index = buildImpactIndex([model({ name: 'bare', litellm_model: 'gpt-4o', impact_model: 'openai/gpt-4o' })]);
			expect([...index.keys()].sort()).toEqual(['bare', 'gpt-4o']);
			expect(index.has('')).toBe(false);
		});

		it('keeps the first deployment listed for an alias shared across locations', () => {
			const index = buildImpactIndex([
				model({ name: 'gpt-5.2-uk+sweden', litellm_model: 'azure/gpt-5.2', impact_model: 'openai/gpt-5.2', location: 'UK' }),
				model({ name: 'gpt-5.2-uk+sweden', litellm_model: 'azure/gpt-5.2', impact_model: 'openai/gpt-5.2', location: 'EU' }),
			]);
			const r = index.get('gpt-5.2-uk+sweden');
			expect(r?.ok && r.model.zone).toBe('GBR');
		});
	});

	describe('zoneLabel', () => {
		it('names the grids the resolver produces and falls back for a hand-set zone', () => {
			expect(zoneLabel('GBR')).toBe('UK grid');
			expect(zoneLabel('IRL')).toBe('Irish grid');
			expect(zoneLabel('WOR')).toBe('world average grid');
			expect(zoneLabel('NLD')).toBe('NLD grid');
		});
	});

	describe('provenance', () => {
		it('formats parameter counts and says where the architecture came from', () => {
			expect(formatParameters({ total: 235, active: 22 })).toBe('235B total, 22B active');
			expect(formatParameters({ total: 123 })).toBe('123B');
			expect(formatParameters({ total: 117, active: 5.1 })).toBe('117B total, 5.1B active');
			expect(impactSourceLabel(resolved(model()))).toBe('for claude-opus-4-7');
			const fromParams = resolved(model({ litellm_model: 'bedrock/moonshotai.kimi-k2.5', parameters: { total: 1000, active: 32 } }));
			expect(impactSourceLabel(fromParams)).toBe('from its published size of 1,000B total, 32B active');
		});
	});

	describe('formatting', () => {
		it('picks a unit by size', () => {
			expect(formatCo2(0.0123)).toBe('12 g CO₂e');
			// Light personal use keeps a decimal rather than reading as zero.
			expect(formatCo2(0.0004)).toBe('0.4 g CO₂e');
			expect(formatCo2(0.0042)).toBe('4.2 g CO₂e');
			expect(formatEnergy(0.0008)).toBe('0.8 Wh');
			expect(formatCo2(2.5)).toBe('2.5 kg CO₂e');
			expect(formatCo2(1500)).toBe('1.5 t CO₂e');
			expect(formatEnergy(0.25)).toBe('250 Wh');
			expect(formatEnergy(12.34)).toBe('12.3 kWh');
			expect(formatEnergy(2000)).toBe('2 MWh');
			expect(formatWater(0.5)).toBe('500 mL');
			expect(formatWater(3)).toBe('3 L');
		});

		it('shares the unit across a range, or spells both out when they differ', () => {
			expect(formatRange({ min: 0.012, max: 0.018 }, formatCo2)).toBe('12 to 18 g CO₂e');
			expect(formatRange({ min: 0.8, max: 1.2 }, formatCo2)).toBe('800 g CO₂e to 1.2 kg CO₂e');
			expect(formatRange({ min: 0.01, max: 0.01 }, formatCo2)).toBe('10 g CO₂e');
			expect(rangeMid({ min: 2, max: 4 })).toBe(3);
		});
	});
});
