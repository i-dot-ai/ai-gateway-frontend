import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_DAYS, trendFetchStart, bucketAlignedStart, buildTrends, excludeHealthCheck, parseTrendRange, pctChange, rangeParams, trendGranularityFor, trendPresetsFetchRange, trendTotals } from './trends';
import { HEALTH_CHECK_KEY_TOKEN, type LitellmCost } from './litellm';
import { listDates } from './usage';

function cost(overrides: Partial<LitellmCost> = {}): LitellmCost {
	return {
		date: '2024-06-01',
		model_name: 'gpt-4',
		spend: 1,
		total_tokens: 100,
		prompt_tokens: 60,
		completion_tokens: 40,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		api_requests: 2,
		failed_requests: 0,
		key_alias: 'personal/alice@example.gov.uk/default',
		key_token: 'tok-alice',
		user_id: 'user-alice',
		team_id: '',
		team_name: '',
		...overrides,
	};
}

describe('trends', () => {
	describe('buildTrends', () => {
		it('counts distinct users per bucket, once each however many keys they use', () => {
			const dates = ['2024-06-01', '2024-06-02', '2024-06-03'];
			const costs = [
				cost({ date: '2024-06-01', user_id: 'user-alice' }),
				cost({ date: '2024-06-02', user_id: 'user-alice', key_token: 'tok-alice-1' }),
				cost({ date: '2024-06-02', user_id: 'user-alice', key_token: 'tok-alice-2' }),
				cost({ date: '2024-06-03', user_id: 'user-bob' }),
				// No attributable user (service/deleted key) -> not counted.
				cost({ date: '2024-06-03', user_id: null }),
			];

			expect(buildTrends(costs, dates, 'day').active.users).toEqual([1, 1, 1]);
		});

		it('counts distinct teams, skipping rows with no team', () => {
			const dates = ['2024-06-01', '2024-06-02'];
			const costs = [
				cost({ date: '2024-06-01', team_id: 'team-eng', user_id: null }),
				cost({ date: '2024-06-01', team_id: 'team-eng', user_id: 'user-alice' }),
				cost({ date: '2024-06-02', team_id: 'team-ops' }),
				cost({ date: '2024-06-02', team_id: '' }),
			];

			expect(buildTrends(costs, dates, 'day').active.teams).toEqual([1, 1]);
		});

		it('sums metrics per day and zero-fills quiet days', () => {
			const dates = ['2024-06-01', '2024-06-02', '2024-06-03'];
			const costs = [
				cost({ date: '2024-06-01', spend: 2, total_tokens: 100, api_requests: 3, failed_requests: 1, key_token: 'tok-a' }),
				cost({ date: '2024-06-01', spend: 3, total_tokens: 50, api_requests: 1, failed_requests: 0, key_token: 'tok-b' }),
				cost({ date: '2024-06-03', spend: 1, total_tokens: 25, api_requests: 4, failed_requests: 2, key_token: 'tok-a' }),
			];

			const trends = buildTrends(costs, dates, 'day');

			expect(trends.buckets).toEqual(dates.map((d) => ({ date: d, end: d })));
			expect(trends.spend).toEqual([5, 0, 1]);
			expect(trends.tokens).toEqual([150, 0, 25]);
			expect(trends.requests).toEqual([4, 0, 4]);
			expect(trends.failures).toEqual([1, 0, 2]);
			expect(trends.activeKeys).toEqual([2, 0, 1]);
		});

		it('groups weeks from the first date, counting entities once per week and summing metrics', () => {
			const dates = listDates('2024-06-01', '2024-06-14');
			const costs = [
				cost({ date: '2024-06-01', user_id: 'user-alice', spend: 1 }),
				cost({ date: '2024-06-05', user_id: 'user-alice', spend: 2 }),
				cost({ date: '2024-06-07', user_id: 'user-bob', spend: 3 }),
				cost({ date: '2024-06-08', user_id: 'user-alice', spend: 4 }),
			];

			const trends = buildTrends(costs, dates, 'week');

			expect(trends.buckets).toEqual([
				{ date: '2024-06-01', end: '2024-06-07' },
				{ date: '2024-06-08', end: '2024-06-14' },
			]);
			expect(trends.active.users).toEqual([2, 1]);
			expect(trends.spend).toEqual([6, 4]);
		});

		it('ignores rows outside the dates', () => {
			const trends = buildTrends([cost({ date: '2024-05-31', spend: 9 })], ['2024-06-01'], 'day');
			expect(trends.spend).toEqual([0]);
		});
	});

	describe('trendGranularityFor', () => {
		it('plots daily up to a fortnight, weekly to about six months, then 30-day blocks', () => {
			expect(trendGranularityFor(7)).toBe('day');
			expect(trendGranularityFor(14)).toBe('day');
			expect(trendGranularityFor(30)).toBe('week');
			expect(trendGranularityFor(90)).toBe('week');
			expect(trendGranularityFor(182)).toBe('week');
			expect(trendGranularityFor(365)).toBe('month');
		});
	});

	describe('bucketAlignedStart', () => {
		it('leaves a range that divides into whole buckets alone', () => {
			expect(bucketAlignedStart('2024-06-01', '2024-06-14', 'week')).toBe('2024-06-01');
			expect(bucketAlignedStart('2024-06-01', '2024-06-07', 'day')).toBe('2024-06-01');
		});

		it('pulls the start back so the oldest bucket is whole', () => {
			// 30 days -> 5 weeks (35 days) ending on the end date.
			const start = bucketAlignedStart('2024-06-01', '2024-06-30', 'week');
			expect(start).toBe('2024-05-27');
			expect(listDates(start, '2024-06-30')).toHaveLength(35);
		});
	});

	describe('parseTrendRange', () => {
		const TODAY = '2026-10-08';
		const parse = (qs: string) => parseTrendRange(new URLSearchParams(qs), TODAY);

		it('defaults to the last 30 days ending today, inclusive', () => {
			const r = parse('');
			expect(r).toMatchObject({ preset: 'last-month', startDate: '2026-09-09', endDate: TODAY, days: 30 });
			expect(r.error).toBeUndefined();
		});

		it('reads a preset, ignoring unknown values', () => {
			expect(parse('timeframe=last-week')).toMatchObject({ preset: 'last-week', startDate: '2026-10-02', days: 7 });
			expect(parse('timeframe=last-quarter').days).toBe(90);
			expect(parse('timeframe=bogus').preset).toBe('last-month');
		});

		it('accepts a valid custom range', () => {
			expect(parse('from=2026-09-01&to=2026-09-30')).toMatchObject({ preset: null, startDate: '2026-09-01', endDate: '2026-09-30', days: 30 });
			expect(parse(`from=${TODAY}&to=${TODAY}`).days).toBe(1);
		});

		it('rejects a bad custom range, falling back to the default and keeping the raw input', () => {
			const cases: Array<[string, 'from' | 'to']> = [
				['to=2026-09-30', 'from'],
				['from=2026-09-01', 'to'],
				['from=2026-02-30&to=2026-03-01', 'from'],
				['from=2026-13-01&to=2026-09-01', 'from'],
				['from=2026-10-01&to=2026-10-09', 'to'],
				['from=2026-09-30&to=2026-09-01', 'from'],
			];
			for (const [qs, field] of cases) {
				const r = parse(qs);
				expect(r.error?.field, qs).toBe(field);
				expect(r.preset, qs).toBe('last-month');
			}
			expect(parse('from=2026-09-30&to=2026-09-01')).toMatchObject({ from: '2026-09-30', to: '2026-09-01' });
		});

		it(`caps a custom range at ${MAX_CUSTOM_DAYS} days`, () => {
			expect(parse('from=2025-10-09&to=2026-10-08').error).toBeUndefined();
			expect(parse('from=2025-10-08&to=2026-10-08').error?.field).toBe('from');
		});
	});

	describe('rangeParams', () => {
		const TODAY = '2026-10-08';
		it('omits the default preset, keeps others, and writes custom ranges as from/to', () => {
			expect(rangeParams(parseTrendRange(new URLSearchParams(''), TODAY)).toString()).toBe('');
			expect(rangeParams(parseTrendRange(new URLSearchParams('timeframe=last-week'), TODAY)).toString()).toBe('timeframe=last-week');
			expect(rangeParams(parseTrendRange(new URLSearchParams('from=2026-09-01&to=2026-09-30'), TODAY)).toString()).toBe('from=2026-09-01&to=2026-09-30');
		});
	});

	describe('trendPresetsFetchRange', () => {
		it('spans the longest preset and its comparison window', () => {
			expect(trendPresetsFetchRange('2026-10-09')).toEqual({ startDate: '2026-04-13', endDate: '2026-10-09' });
		});
	});

	describe('trendFetchStart', () => {
		it('reaches back one range length, covering the previous window and any chart lead-in', () => {
			expect(trendFetchStart({ startDate: '2024-06-11', days: 30 })).toBe('2024-05-12');
			// The longest lead-in (a 30-day bucket) still falls inside the fetched span.
			const start = '2024-01-01';
			expect(trendFetchStart({ startDate: start, days: 183 }) <= bucketAlignedStart(start, '2024-07-01', 'month')).toBe(true);
		});
	});

	describe('excludeHealthCheck', () => {
		it('drops the internal health-check key without mutating the input', () => {
			const rows = [
				cost({ key_token: 'tok-real', api_requests: 5 }),
				cost({ key_token: HEALTH_CHECK_KEY_TOKEN, api_requests: 9999 }),
			];
			expect(excludeHealthCheck(rows).map((c) => c.key_token)).toEqual(['tok-real']);
			expect(rows).toHaveLength(2);
		});
	});

	describe('trendTotals', () => {
		it('counts distinct users/teams/keys once over the window and sums the metric totals', () => {
			const dates = ['2024-06-01', '2024-06-02'];
			const costs = [
				cost({ date: '2024-06-01', spend: 2, total_tokens: 100, api_requests: 3, failed_requests: 1, user_id: 'user-alice', team_id: 'team-eng', key_token: 'tok-a' }),
				cost({ date: '2024-06-01', spend: 3, total_tokens: 50, api_requests: 1, failed_requests: 0, user_id: 'user-bob', team_id: 'team-eng', key_token: 'tok-b' }),
				// alice again the next day: still one distinct user, same key -> one key, no team.
				cost({ date: '2024-06-02', spend: 1, total_tokens: 25, api_requests: 4, failed_requests: 2, user_id: 'user-alice', team_id: '', key_token: 'tok-a' }),
			];

			const totals = trendTotals(costs, dates);

			expect(totals.users).toBe(2); // alice, bob
			expect(totals.teams).toBe(1); // team-eng
			expect(totals.keys).toBe(2); // tok-a, tok-b
			expect(totals.spend).toBe(6);
			expect(totals.tokens).toBe(175);
			expect(totals.requests).toBe(8);
			expect(totals.failed).toBe(3); // 1 + 0 + 2
			expect(totals.successful).toBe(5);
			expect(totals.failureRate).toBe(37.5);
		});

		it('excludes rows outside the display range from the distinct counts', () => {
			const displayDates = ['2024-06-02'];
			const costs = [
				cost({ date: '2024-06-01', user_id: 'user-before', key_token: 'tok-x' }), // before display
				cost({ date: '2024-06-02', user_id: 'user-alice', key_token: 'tok-a' }),
			];

			const totals = trendTotals(costs, displayDates);
			expect(totals.users).toBe(1); // only alice
			expect(totals.keys).toBe(1);
		});
	});

	describe('pctChange', () => {
		it('returns the signed percentage change against the previous value', () => {
			expect(pctChange(150, 100)).toBe(50);
			expect(pctChange(75, 100)).toBe(-25);
			expect(pctChange(100, 100)).toBe(0);
		});

		it('returns null when there is no comparable baseline (undefined or zero previous)', () => {
			expect(pctChange(100, undefined)).toBeNull();
			expect(pctChange(100, 0)).toBeNull();
		});
	});

});
