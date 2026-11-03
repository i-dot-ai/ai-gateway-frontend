/**
 * One way to present model facts everywhere (suggestion cards, detail page),
 * so cost, context and hosting read the same wherever they appear.
 */

export const NOT_LISTED = 'Not listed';

/** USD per token -> "$4.40" per million tokens. */
export function formatPerMillion(perToken: number | undefined): string {
	if (perToken === undefined) return NOT_LISTED;
	const perM = perToken * 1e6;
	return `$${perM < 0.1 ? perM.toFixed(3) : perM.toFixed(2)}`;
}

/** "$4.40 input, $22.00 output per million tokens". */
export function formatCost(inputPerToken: number | undefined, outputPerToken: number | undefined): string {
	return (inputPerToken === undefined && outputPerToken === undefined) ? NOT_LISTED 
		: `${formatPerMillion(inputPerToken)} input, ${formatPerMillion(outputPerToken)} output per million tokens`;
}

/** Context or output limit: 1000000 -> "1M tokens", 128000 -> "128K tokens". */
export function formatTokenLimit(n: number | undefined): string {
	if (!n) return NOT_LISTED;
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M tokens`;
	if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K tokens`;
	return `${n} tokens`;
}

/** "Anthropic (US)". */
export function formatMaker(lab: string | undefined, country: string | undefined): string {
	return (!lab && !country) ? NOT_LISTED : [lab, country && `(${country})`].filter(Boolean).join(' ');
}

export function formatYesNo(value: boolean | undefined): string {
	return value === undefined ? NOT_LISTED : value ? 'Yes' : 'No';
}

/**
 * Tag colour for a hosting location. UK and EU are what most users must check
 * for (data residency), so they stand out; anything else is orange.
 */
export function hostingTagColour(location: string | undefined): 'green' | 'blue' | 'orange' {
	if (location === 'UK') return 'green';
	if (location === 'EU') return 'blue';
	return 'orange';
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/** "7 October 2026" or "7 October 2026 at 13:06", in UK time. */
export function formatDate(iso: string, withTime = false): string {
	const d = new Date(iso);
	return withTime ? `${dateFmt.format(d)} at ${timeFmt.format(d)}` : dateFmt.format(d);
}

/** A URL's host for link text, e.g. "platform.claude.com"; the raw value if it is not a full URL. */
export function formatHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
