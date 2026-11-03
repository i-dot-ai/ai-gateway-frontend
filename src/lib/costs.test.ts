import { describe, expect, it } from 'vitest';
import { BREAKDOWNS, METRICS, buildChartData, getDateRange, parseOption, parseTimeframe } from './costs';
import type { LitellmCost } from './litellm';

describe('costs', () => {
	describe('getDateRange', () => {
		it('returns exactly the timeframe\'s days, inclusive, ending today', () => {
			const now = new Date('2024-06-15T10:30:00Z');

			expect(getDateRange('last-week', now)).toEqual({ startDate: '2024-06-09', endDate: '2024-06-15' });
			expect(getDateRange('last-month', now)).toEqual({ startDate: '2024-05-17', endDate: '2024-06-15' });
			expect(getDateRange('last-quarter', now)).toEqual({ startDate: '2024-03-18', endDate: '2024-06-15' });
		});
	});

	describe('parseTimeframe', () => {
		it('accepts a known timeframe and falls back for missing or unrecognised input', () => {
			expect(parseTimeframe('last-quarter', 'last-month')).toBe('last-quarter');
			expect(parseTimeframe(null, 'last-month')).toBe('last-month');
			expect(parseTimeframe('not-a-timeframe', 'last-week')).toBe('last-week');
		});
	});

	describe('parseOption', () => {
		it('accepts a known value and falls back for missing or unrecognised input', () => {
			expect(parseOption('models', BREAKDOWNS, 'teams')).toBe('models');
			expect(parseOption(null, BREAKDOWNS, 'teams')).toBe('teams');
			expect(parseOption('nonsense', BREAKDOWNS, 'teams')).toBe('teams');
			expect(parseOption('tokens', METRICS, 'spend')).toBe('tokens');
			expect(parseOption('', METRICS, 'spend')).toBe('spend');
		});
	});

	describe('buildChartData', () => {
		function cost(overrides: Partial<LitellmCost> = {}): LitellmCost {
			return {
				date: '2024-06-01',
				model_name: 'gpt-4',
				spend: 1,
				total_tokens: 100,
				prompt_tokens: 0,
				completion_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				api_requests: 0,
				failed_requests: 0,
				key_alias: 'key-1',
				key_token: 'tok-1',
				user_id: 'user-1',
				team_id: 'team-a',
				team_name: 'Team A',
				...overrides,
			};
		}

		it('groups by model and sums spend per day', () => {
			const costs = [
				cost({ date: '2024-06-01', model_name: 'gpt-4', spend: 1 }),
				cost({ date: '2024-06-01', model_name: 'gpt-4', spend: 2 }),
				cost({ date: '2024-06-01', model_name: 'claude', spend: 3 }),
				cost({ date: '2024-06-02', model_name: 'gpt-4', spend: 4 }),
			];

			const result = buildChartData(costs, 'models', 'spend');

			expect(result.labels).toEqual(['2024-06-01', '2024-06-02']);
			expect(result.datasets).toEqual(
				expect.arrayContaining([
					{ label: 'gpt-4', data: [3, 4] },
					{ label: 'claude', data: [3, 0] },
				])
			);
		});

		it('groups by team and sums tokens per day, converted to millions', () => {
			const costs = [
				cost({ date: '2024-06-01', team_name: 'Team A', total_tokens: 1_000_000 }),
				cost({ date: '2024-06-01', team_name: 'Team B', total_tokens: 2_500_000 }),
			];

			const result = buildChartData(costs, 'teams', 'tokens');

			expect(result.labels).toEqual(['2024-06-01']);
			expect(result.datasets).toEqual(
				expect.arrayContaining([
					{ label: 'Team A', data: [1] },
					{ label: 'Team B', data: [2.5] },
				])
			);
		});

		it('groups keys with no team under "personal"', () => {
			const costs = [cost({ team_name: '' })];

			const result = buildChartData(costs, 'teams', 'spend');

			expect(result.datasets.map((d) => d.label)).toEqual(['personal']);
		});

		it('returns empty labels and datasets for no costs', () => {
			expect(buildChartData([], 'teams', 'spend')).toEqual({ labels: [], datasets: [] });
		});

		it('keeps only the top 5 series by total value and folds the rest into "Other"', () => {
			const costs = [
				cost({ date: '2024-06-01', model_name: 'model-1', spend: 60 }),
				cost({ date: '2024-06-01', model_name: 'model-2', spend: 50 }),
				cost({ date: '2024-06-01', model_name: 'model-3', spend: 40 }),
				cost({ date: '2024-06-01', model_name: 'model-4', spend: 30 }),
				cost({ date: '2024-06-01', model_name: 'model-5', spend: 20 }),
				cost({ date: '2024-06-01', model_name: 'model-6', spend: 10 }),
				cost({ date: '2024-06-01', model_name: 'model-7', spend: 5 }),
			];

			const result = buildChartData(costs, 'models', 'spend');

			expect(result.datasets).toHaveLength(6);
			expect(result.datasets).toEqual(
				expect.arrayContaining([
					{ label: 'model-1', data: [60] },
					{ label: 'model-2', data: [50] },
					{ label: 'model-3', data: [40] },
					{ label: 'model-4', data: [30] },
					{ label: 'model-5', data: [20] },
					{ label: 'Other', data: [15] },
				])
			);
		});

		it('does not add an "Other" series when there are 5 or fewer series', () => {
			const costs = [
				cost({ model_name: 'model-1', spend: 1 }),
				cost({ model_name: 'model-2', spend: 2 }),
			];

			const result = buildChartData(costs, 'models', 'spend');

			expect(result.datasets.map((d) => d.label)).not.toContain('Other');
		});

		it('aggregates "Other" across multiple days independently', () => {
			const costs = [
				cost({ date: '2024-06-01', model_name: 'model-1', spend: 100 }),
				cost({ date: '2024-06-01', model_name: 'model-2', spend: 90 }),
				cost({ date: '2024-06-01', model_name: 'model-3', spend: 80 }),
				cost({ date: '2024-06-01', model_name: 'model-4', spend: 70 }),
				cost({ date: '2024-06-01', model_name: 'model-5', spend: 60 }),
				cost({ date: '2024-06-01', model_name: 'model-6', spend: 1 }),
				cost({ date: '2024-06-02', model_name: 'model-7', spend: 2 }),
			];

			const result = buildChartData(costs, 'models', 'spend');
			const other = result.datasets.find((d) => d.label === 'Other');

			expect(result.labels).toEqual(['2024-06-01', '2024-06-02']);
			expect(other).toEqual({ label: 'Other', data: [1, 2] });
		});
	});
});
