/**
 * Finance export endpoint - generates a CSV of Gateway usage costs.
 *
 * GET /api/finance/export?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns a CSV with monthly spend broken down by model, team, and user.
 *
 * Requires:
 * - User to be signed in (ALB OIDC)
 */
import type { APIRoute } from 'astro';
import { getCosts } from '../../../lib/litellm';

/**
 * Derive provider from model name or litellm model string.
 * Check platform prefixes first (bedrock/, vertex_ai/) before model family names.
 */
export function deriveProvider(modelName: string): string {
	const lower = modelName.toLowerCase();
	// Platform prefixes first - these indicate where the model is hosted
	if (lower.startsWith('bedrock') || lower.includes('/bedrock')) return 'AWS Bedrock';
	if (lower.startsWith('vertex') || lower.includes('/vertex')) return 'Google Cloud';
	// Then model family names
	if (lower.includes('claude') || lower.includes('anthropic')) return 'Anthropic';
	if (lower.includes('gpt') || lower.includes('openai')) return 'OpenAI';
	if (lower.includes('gemini') || lower.includes('google')) return 'Google';
	if (lower.includes('mistral')) return 'Mistral';
	if (lower.includes('llama')) return 'Meta';
	return 'Other';
}

/**
 * Escape a value for CSV (wrap in quotes if it contains comma, quote, or newline).
 */
function csvEscape(value: string | number): string {
	const str = String(value);
	if (str.includes(',') || str.includes('"') || str.includes('\n')) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

/**
 * Convert rows to CSV string.
 */
function toCsv(headers: string[], rows: (string | number)[][]): string {
	const headerLine = headers.map(csvEscape).join(',');
	const dataLines = rows.map(row => row.map(csvEscape).join(','));
	return [headerLine, ...dataLines].join('\n');
}

export const GET: APIRoute = async ({ url }) => {
	// Parse date params
	const startDate = url.searchParams.get('start');
	const endDate = url.searchParams.get('end');

	if (!startDate || !endDate) {
		return new Response('Missing start or end date. Use ?start=YYYY-MM-DD&end=YYYY-MM-DD', {
			status: 400,
		});
	}

	// Validate date format
	const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
	if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
		return new Response('Invalid date format. Use YYYY-MM-DD', { status: 400 });
	}

	if (startDate > endDate) {
		return new Response('Start date must be before end date', { status: 400 });
	}

	// Fetch data
	const costsResult = await getCosts(startDate, endDate);

	if (costsResult.error) {
		return new Response(`Failed to fetch costs: ${costsResult.error}`, { status: 500 });
	}

	const costs = costsResult.costs;

	// CSV headers
	const headers = [
		'Month',
		'Model',
		'Model provider',
		'Product or team',
		'User ID',
		'Request count',
		'Input tokens',
		'Output tokens',
		'Total tokens',
		'Cost ($)',
	];

	// Aggregate by month, model, team, user
	const agg = new Map<string, {
		month: string;
		model: string;
		provider: string;
		team: string;
		user_id: string;
		request_count: number;
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		cost_usd: number;
	}>();

	for (const cost of costs) {
		const month = cost.date.slice(0, 7); // "YYYY-MM"
		const teamName = cost.team_name || 'Unassigned';
		const userId = cost.user_id ?? 'unknown';
		const provider = deriveProvider(cost.model_name);
		const key = `${month}|${cost.model_name}|${teamName}|${userId}`;

		const existing = agg.get(key);
		if (existing) {
			existing.request_count += cost.api_requests;
			existing.input_tokens += cost.prompt_tokens;
			existing.output_tokens += cost.completion_tokens;
			existing.total_tokens += cost.total_tokens;
			existing.cost_usd += cost.spend;
		} else {
			agg.set(key, {
				month,
				model: cost.model_name,
				provider,
				team: teamName,
				user_id: userId,
				request_count: cost.api_requests,
				input_tokens: cost.prompt_tokens,
				output_tokens: cost.completion_tokens,
				total_tokens: cost.total_tokens,
				cost_usd: cost.spend,
			});
		}
	}

	// Sort by month, model, team, user
	const rows = Array.from(agg.values())
		.sort((a, b) => {
			if (a.month !== b.month) return a.month.localeCompare(b.month);
			if (a.model !== b.model) return a.model.localeCompare(b.model);
			if (a.team !== b.team) return a.team.localeCompare(b.team);
			return a.user_id.localeCompare(b.user_id);
		})
		.map(row => [
			row.month,
			row.model,
			row.provider,
			row.team,
			row.user_id,
			row.request_count,
			row.input_tokens,
			row.output_tokens,
			row.total_tokens,
			row.cost_usd.toFixed(2),
		]);

	const csv = toCsv(headers, rows);

	// Return as download
	const filename = `gateway-finance-report-${startDate}-to-${endDate}.csv`;

	return new Response(csv, {
		status: 200,
		headers: {
			'Content-Type': 'text/csv',
			'Content-Disposition': `attachment; filename="${filename}"`,
		},
	});
};
