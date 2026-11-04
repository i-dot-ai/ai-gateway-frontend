import { describe, expect, it } from 'vitest';
import { getDateRange, parseOption, parseTimeframe } from './costs';

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
			const options = [{ value: 'users' }, { value: 'teams' }] as const;
			expect(parseOption('teams', options, 'users')).toBe('teams');
			expect(parseOption(null, options, 'users')).toBe('users');
			expect(parseOption('nonsense', options, 'users')).toBe('users');
			expect(parseOption('', options, 'users')).toBe('users');
		});
	});
});
