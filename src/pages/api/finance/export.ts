/**
 * Finance export endpoint - generates an Excel report of Gateway usage costs.
 *
 * GET /api/finance/export?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns an .xlsx file with two sheets:
 * - Model breakdown: daily spend by product/team, provider, model
 * - User breakdown: daily spend by user ID (summed across models)
 *
 * Requires:
 * - User to be signed in (ALB OIDC)
 */
import type { APIRoute } from 'astro';
import ExcelJS from 'exceljs';
import { getCosts, getTeams } from '../../../lib/litellm';

// HMRC monthly exchange rate (USD to GBP) - update monthly
// Source: https://www.gov.uk/government/publications/hmrc-exchange-rates-for-2026-monthly
const EXCHANGE_RATE = 0.79;
const EXCHANGE_RATE_MONTH = 'Nov 2026';

/**
 * Derive provider from model name or litellm model string.
 * The costs data includes provider breakdown, but we also need it per-row.
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

	// Build workbook
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'AI Gateway';
	workbook.created = new Date();

	// ----- Tab 1: Model breakdown -----
	const modelSheet = workbook.addWorksheet('Model breakdown');

	// Column headers
	modelSheet.columns = [
		{ header: 'Date', key: 'date', width: 12 },
		{ header: 'Product or team', key: 'team', width: 20 },
		{ header: 'Model provider', key: 'provider', width: 15 },
		{ header: 'Model', key: 'model', width: 35 },
		{ header: 'Request count', key: 'request_count', width: 14 },
		{ header: 'Input tokens', key: 'input_tokens', width: 14 },
		{ header: 'Output tokens', key: 'output_tokens', width: 14 },
		{ header: 'Total tokens', key: 'total_tokens', width: 14 },
		{ header: 'Cost ($)', key: 'cost_usd', width: 12 },
		{ header: `Cost (£) - exch rate ${EXCHANGE_RATE} (${EXCHANGE_RATE_MONTH})`, key: 'cost_gbp', width: 30 },
	];

	// Aggregate by date, team, provider, model
	const modelAgg = new Map<string, {
		date: string;
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
		const teamName = cost.team_id ? (teamNamesById.get(cost.team_id) ?? cost.team_id) : 'Unassigned';
		const provider = deriveProvider(cost.model_name);
		const key = `${cost.date}|${teamName}|${provider}|${cost.model_name}`;

		const existing = modelAgg.get(key);
		if (existing) {
			existing.request_count += cost.api_requests;
			existing.input_tokens += cost.prompt_tokens;
			existing.output_tokens += cost.completion_tokens;
			existing.total_tokens += cost.total_tokens;
			existing.cost_usd += cost.spend;
		} else {
			modelAgg.set(key, {
				date: cost.date,
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

	// Sort by date, team, model and add rows
	const modelRows = Array.from(modelAgg.values()).sort((a, b) => {
		if (a.date !== b.date) return a.date.localeCompare(b.date);
		if (a.team !== b.team) return a.team.localeCompare(b.team);
		return a.model.localeCompare(b.model);
	});

	for (const row of modelRows) {
		modelSheet.addRow({
			...row,
			cost_gbp: row.cost_usd * EXCHANGE_RATE,
		});
	}

	// Format currency columns
	modelSheet.getColumn('cost_usd').numFmt = '"$"#,##0.00';
	modelSheet.getColumn('cost_gbp').numFmt = '"£"#,##0.00';

	// Bold header row
	modelSheet.getRow(1).font = { bold: true };

	// ----- Tab 2: User breakdown -----
	const userSheet = workbook.addWorksheet('User breakdown');

	userSheet.columns = [
		{ header: 'Date', key: 'date', width: 12 },
		{ header: 'Unique User ID (UUID)', key: 'user_id', width: 40 },
		{ header: 'Cost ($)', key: 'cost_usd', width: 12 },
		{ header: `Cost (£) - exch rate ${EXCHANGE_RATE} (${EXCHANGE_RATE_MONTH})`, key: 'cost_gbp', width: 30 },
	];

	// Aggregate by date, user
	const userAgg = new Map<string, {
		date: string;
		user_id: string;
		cost_usd: number;
	}>();

	for (const cost of costs) {
		// user_id from costs is actually the key owner
		const userId = cost.user_id ?? 'unknown';
		const key = `${cost.date}|${userId}`;

		const existing = userAgg.get(key);
		if (existing) {
			existing.cost_usd += cost.spend;
		} else {
			userAgg.set(key, {
				date: cost.date,
				user_id: userId,
				cost_usd: cost.spend,
			});
		}
	}

	// Sort by date, user and add rows with user info lookup
	const userRows = Array.from(userAgg.values()).sort((a, b) => {
		if (a.date !== b.date) return a.date.localeCompare(b.date);
		return a.user_id.localeCompare(b.user_id);
	});

	for (const row of userRows) {
		userSheet.addRow({
			date: row.date,
			user_id: row.user_id,
			cost_usd: row.cost_usd,
			cost_gbp: row.cost_usd * EXCHANGE_RATE,
		});
	}

	// Format currency columns
	userSheet.getColumn('cost_usd').numFmt = '"$"#,##0.00';
	userSheet.getColumn('cost_gbp').numFmt = '"£"#,##0.00';

	// Bold header row
	userSheet.getRow(1).font = { bold: true };

	// Generate buffer
	const buffer = await workbook.xlsx.writeBuffer();

	// Return as download
	const filename = `gateway-finance-report-${startDate}-to-${endDate}.xlsx`;

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="${filename}"`,
		},
	});
};
