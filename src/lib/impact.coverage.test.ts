import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { resolveImpactModel } from './impact';
import { toLitellmModel } from './litellm';

/**
 * How config.yml resolves against the ecologits registry (ADR-0005). Entries
 * are mapped with the same function the app uses for /v2/model/info, so this
 * reads config exactly as the pages will. It keeps the declarations honest (an
 * `impact_model` the registry does not know fails), requires every open-weight
 * generation model to declare its size with a source, and prints the full
 * resolution table as the audit of what each model maps to.
 *
 * config.yml belongs to the gateway (core-llm-gateway/backend), so this only
 * runs in the monorepo layout; it is skipped when that checkout is absent.
 */
const configPath = new URL('../../../backend/config/config.yml', import.meta.url);
const hasGatewayConfig = existsSync(configPath);

describe.skipIf(!hasGatewayConfig)('impact resolution of config.yml', () => {
	// Strict parse: a repeated key would be silently collapsed by LiteLLM's PyYAML, so fail here instead.
	const config = hasGatewayConfig ? parse(readFileSync(configPath, 'utf8')) : { model_list: [] };
	const entries = (config.model_list as unknown[]).map((raw) => {
		const model = toLitellmModel(raw);
		return { model, result: resolveImpactModel(model) };
	});
	const generation = entries.filter(({ result }) => result.ok || result.reason !== 'not-generation');
	const declared = entries.filter(({ model }) => model.impact_model !== undefined);

	// Open-weight models whose size we have not been able to confirm. Each needs a
	// reason; the list should only ever shrink.
	const UNCONFIRMED_SIZE: Record<string, string> = {
		'locai-jupiter-n-120b-uk': 'alias says 120B, model card says Jupiter-G-8B; awaiting Locai',
	};
	// Closed models the ecologits registry has not sized yet, so there is nothing
	// to declare. Remove an entry once the registry has it and declare impact_model.
	const NOT_YET_IN_REGISTRY: Record<string, string> = {
		'bedrock-claude-haiku-5-5-eu': 'in the upstream Python registry; arrives with the next ecologits.js release',
		'gemini-4-argon-global': 'not yet in the ecologits registry',
	};

	it('declares impact_model entries the registry knows', () => {
		const unknown = declared.filter(({ result }) => !result.ok && result.reason === 'not-in-registry');
		expect(unknown.map(({ model }) => `${model.name}: ${model.impact_model}`)).toEqual([]);
	});

	it('declares impact_model on every closed generation model the registry knows', () => {
		const missing = generation
			.filter(({ model }) => !model.open_weight && !(model.name in NOT_YET_IN_REGISTRY))
			.filter(({ model }) => model.impact_model === undefined)
			.map(({ model }) => model.name);
		expect(missing).toEqual([]);
	});

	it('declares parameters with a source on every open-weight generation model', () => {
		const missing = generation
			.filter(({ model }) => model.open_weight && !(model.name in UNCONFIRMED_SIZE))
			.filter(({ model }) => !model.parameters?.source)
			.map(({ model }) => model.name);
		expect(missing).toEqual([]);
	});

	it('covers most generation models', () => {
		const resolved = generation.filter(({ result }) => result.ok);
		const pct = (100 * resolved.length) / generation.length;
		const lines = generation.map(({ model, result }) =>
			result.ok
				? `  ok    ${model.name.padEnd(40)} -> ${result.model.provider}/${result.model.modelName} (${result.model.zone}) ${result.model.parameters ? 'parameters' : 'declared'}`
				: `  MISS  ${model.name.padEnd(40)}    ${model.litellm_model}`,
		);
		console.log(`impact coverage: ${resolved.length}/${generation.length} generation models (${pct.toFixed(0)}%), ${declared.length} declared\n${lines.join('\n')}`);
		expect(pct).toBeGreaterThanOrEqual(90);
	});
});
