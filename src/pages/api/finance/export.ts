/**
 * Finance export endpoint - generates a ZIP with two CSVs of Gateway usage costs.
 *
 * GET /api/finance/export?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns a .zip file containing:
 * - model-breakdown.csv: daily spend by product/team, provider, model
 * - user-breakdown.csv: daily spend by user ID (summed across models)
 *
 * Requires:
 * - User to be signed in (ALB OIDC)
 */
import type { APIRoute } from 'astro';
import JSZip from 'jszip';
import { getCosts, getTeams } from '../../../lib/litellm';



/**
 * Derive provider from model name or litellm model string.
 * Check platform prefixes first (bedrock/, vertex_ai/) before model family names.
 */
function deriveProvider(modelName: string): string {
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
	const [costsResult, teamsResult] = await Promise.all([
		getCosts(startDate, endDate),
		getTeams(),
	]);

	if (costsResult.error) {
		return new Response(`Failed to fetch costs: ${costsResult.error}`, { status: 500 });
	}

	const costs = costsResult.costs;
	const teamNamesById = new Map(teamsResult.teams.map((t) => [t.id, t.name]));

	// ----- CSV 1: Model breakdown -----
	const modelHeaders = [
		'Month',
		'Product or team',
		'Model provider',
		'Model',
		'Request count',
		'Input tokens',
		'Output tokens',
		'Total tokens',
		'Cost ($)',
	];

	// Aggregate by month, team, provider, model
	const modelAgg = new Map<string, {
		month: string;
		team: string;
		provider: string;
		model: string;
		request_count: number;
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		cost_usd: number;
	}>();

	for (const cost of costs) {
		const month = cost.date.slice(0, 7); // "YYYY-MM"
		const teamName = cost.team_id ? (teamNamesById.get(cost.team_id) ?? cost.team_id) : 'Unassigned';
		const provider = deriveProvider(cost.model_name);
		const key = `${month}|${teamName}|${provider}|${cost.model_name}`;

		const existing = modelAgg.get(key);
		if (existing) {
			existing.request_count += cost.api_requests;
			existing.input_tokens += cost.prompt_tokens;
			existing.output_tokens += cost.completion_tokens;
			existing.total_tokens += cost.total_tokens;
			existing.cost_usd += cost.spend;
		} else {
			modelAgg.set(key, {
				month,
				team: teamName,
				provider,
				model: cost.model_name,
				request_count: cost.api_requests,
				input_tokens: cost.prompt_tokens,
				output_tokens: cost.completion_tokens,
				total_tokens: cost.total_tokens,
				cost_usd: cost.spend,
			});
		}
	}

	// Sort by month, team, model
	const modelRows = Array.from(modelAgg.values())
		.sort((a, b) => {
			if (a.month !== b.month) return a.month.localeCompare(b.month);
			if (a.team !== b.team) return a.team.localeCompare(b.team);
			return a.model.localeCompare(b.model);
		})
		.map(row => [
			row.month,
			row.team,
			row.provider,
			row.model,
			row.request_count,
			row.input_tokens,
			row.output_tokens,
			row.total_tokens,
			row.cost_usd.toFixed(2),
		]);

	const modelCsv = toCsv(modelHeaders, modelRows);

	// ----- CSV 2: User breakdown -----
	const userHeaders = [
		'Month',
		'Unique User ID (UUID)',
		'Cost ($)',
	];

	// Aggregate by month, user
	const userAgg = new Map<string, {
		month: string;
		user_id: string;
		cost_usd: number;
	}>();

	for (const cost of costs) {
		const month = cost.date.slice(0, 7); // "YYYY-MM"
		const userId = cost.user_id ?? 'unknown';
		const key = `${month}|${userId}`;

		const existing = userAgg.get(key);
		if (existing) {
			existing.cost_usd += cost.spend;
		} else {
			userAgg.set(key, {
				month,
				user_id: userId,
				cost_usd: cost.spend,
			});
		}
	}

	// Sort by month, user
	const userRows = Array.from(userAgg.values())
		.sort((a, b) => {
			if (a.month !== b.month) return a.month.localeCompare(b.month);
			return a.user_id.localeCompare(b.user_id);
		})
		.map(row => [
			row.month,
			row.user_id,
			row.cost_usd.toFixed(2),
		]);

	const userCsv = toCsv(userHeaders, userRows);

	// ----- Create ZIP -----
	const zip = new JSZip();
	zip.file('model-breakdown.csv', modelCsv);
	zip.file('user-breakdown.csv', userCsv);

	const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

	// Return as download
	const filename = `gateway-finance-report-${startDate}-to-${endDate}.zip`;

	return new Response(zipBuffer, {
		status: 200,
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="${filename}"`,
		},
	});
};
