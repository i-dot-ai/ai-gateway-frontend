import { describe, expect, it } from 'vitest';
import { formatCost, formatDate, formatHost, formatMaker, formatPerMillion, formatTokenLimit, formatYesNo, hostingTagColour } from './format';

describe('format', () => {
	it('formats cost per million tokens, keeping small prices readable', () => {
		expect(formatPerMillion(0.0000044)).toBe('$4.40');
		expect(formatPerMillion(0.00000005)).toBe('$0.050');
		expect(formatPerMillion(undefined)).toBe('Not listed');
		expect(formatCost(0.0000044, 0.000022)).toBe('$4.40 input, $22.00 output per million tokens');
		expect(formatCost(undefined, undefined)).toBe('Not listed');
	});

	it('formats token counts compactly', () => {
		expect(formatTokenLimit(1_000_000)).toBe('1M tokens');
		expect(formatTokenLimit(1_048_576)).toBe('1M tokens');
		expect(formatTokenLimit(128_000)).toBe('128K tokens');
		expect(formatTokenLimit(262_144)).toBe('262.1K tokens');
		expect(formatTokenLimit(undefined)).toBe('Not listed');
	});

	it('formats maker, yes/no, hosting and dates', () => {
		expect(formatMaker('Anthropic', 'US')).toBe('Anthropic (US)');
		expect(formatMaker(undefined, undefined)).toBe('Not listed');
		expect(formatYesNo(true)).toBe('Yes');
		expect(formatYesNo(undefined)).toBe('Not listed');
		expect(hostingTagColour('UK')).toBe('green');
		expect(hostingTagColour('Global')).toBe('orange');
		expect(formatDate('2026-10-07T12:06:00Z', true)).toBe('7 October 2026 at 13:06');
	});
});

describe('formatHost', () => {
	it('returns the host, or the raw value when it is not a full URL', () => {
		expect(formatHost('https://platform.claude.com/docs/x')).toBe('platform.claude.com');
		expect(formatHost('docs.anthropic.com/models')).toBe('docs.anthropic.com/models');
		expect(formatHost('')).toBe('');
	});
});
