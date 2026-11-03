import { describe, expect, it } from 'vitest';
import { safePath } from './safePath';

describe('safePath', () => {
	it('allows a same-site absolute path', () => {
		expect(safePath('/usage')).toBe('/usage');
	});

	it('preserves query strings on a same-site path', () => {
		expect(safePath('/usage?timeframe=last-week')).toBe('/usage?timeframe=last-week');
	});

	it('falls back to "/" for protocol-relative URLs', () => {
		expect(safePath('//evil.com')).toBe('/');
	});

	it('falls back to "/" for absolute URLs', () => {
		expect(safePath('http://evil.com')).toBe('/');
		expect(safePath('https://evil.com/path')).toBe('/');
	});

	it('falls back to "/" for javascript: URLs', () => {
		expect(safePath('javascript:alert(1)')).toBe('/');
	});

	it('falls back to "/" for relative paths without a leading slash', () => {
		expect(safePath('usage')).toBe('/');
	});

	it('falls back to "/" for empty, null or undefined values', () => {
		expect(safePath('')).toBe('/');
		expect(safePath(null)).toBe('/');
		expect(safePath(undefined)).toBe('/');
	});
});
