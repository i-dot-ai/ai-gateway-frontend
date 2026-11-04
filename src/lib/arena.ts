/**
 * Arena (arena.ai) human-preference rankings, from Arena's official CC-BY-4.0
 * dataset on Hugging Face (lmarena-ai/leaderboard-dataset). arena.ai's terms
 * forbid scraping the site itself, so this is the only source we use.
 *
 * Filled by the background refresh like modelDetails; requests only read it.
 */
import { createHash } from 'node:crypto';
import { parquetReadObjects } from 'hyparquet';
import { z } from 'zod';
import { STRONG_MODEL, chatJson } from './gatewayChat';
import { getLitellmConfig, type LitellmModel } from './litellm';
import { logger } from './logging';
import { modelBase } from './modelNames';

export const ARENA_DATASET_URL = 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset';
export const ARENA_LEADERBOARD_URL = 'https://arena.ai/leaderboard';

/** The leaderboards and categories we surface, with plain-English labels. */
const BOARDS: Array<{ subset: string; label: string; categories: Record<string, string> }> = [
	{
		subset: 'text_style_control',
		label: 'Text',
		categories: {
			overall: 'Text overall',
			coding: 'Coding questions (chat)',
			longer_query: 'Longer queries',
			industry_legal_and_government: 'Legal and government',
		},
	},
	// Arena's main coding leaderboard: models build working apps and people judge the results.
	{ subset: 'webdev', label: 'Code Arena', categories: { overall: 'Code Arena (building apps)' } },
	// Agent Arena: models run real multi-step agent sessions.
	{ subset: 'agent', label: 'Agent', categories: { overall: 'Agent Arena overall' } },
];

export interface ArenaRanking {
	board: string;
	category: string;
	label: string;
	/** Position by score. */
	rank: number;
	/**
	 * Arena's confidence-aware rank: 1 + models whose lower bound beats this
	 * model's upper bound. Models with overlapping intervals share it.
	 */
	rank_ub: number;
	/** True when other models share this rank_ub, i.e. a statistical tie. */
	tied: boolean;
	/** How many models this category ranks. */
	of: number;
	/** The Arena entry this came from, e.g. "gpt-5.4-high". */
	arena_model: string;
	published: string;
}

interface ArenaRow {
	model_name: string;
	category: string;
	rank: number;
	score: number;
	score_lower: number;
	score_upper: number;
	votes: number;
	published: string;
}

/** The best-ranked entry for one Arena base name in one category. */
interface IndexedEntry {
	row: ArenaRow;
	rankUb: number;
	tied: boolean;
}

interface CategoryIndex {
	of: number;
	best: Map<string, IndexedEntry>;
}

interface ArenaStore {
	/** subset -> category -> best entry per Arena base name. Raw rows are not kept. */
	index: Map<string, Map<string, CategoryIndex>>;
	/** subset -> newest publish date in that file. */
	published: Map<string, string>;
	etags: Map<string, string>;
	/** Our model base name -> Arena base name, from the LLM fallback, keyed by input hash. */
	llmMatches?: { key: string; map: Record<string, string> };
}

const store: ArenaStore = ((globalThis as { __arenaStore?: ArenaStore }).__arenaStore ??= {
	index: new Map(),
	published: new Map(),
	etags: new Map(),
});

const FETCH_TIMEOUT_MS = 30_000;

function fileUrl(subset: string): string {
	return `${ARENA_DATASET_URL}/resolve/main/${subset}/latest-00000-of-00001.parquet`;
}

/** Download, in parallel, any leaderboard whose file changed since the last run. */
export async function refreshArena(): Promise<{ updated: string[] }> {
	const results = await Promise.all(
		BOARDS.map(async (board) => {
			try {
				// The resolve URL redirects to a CDN; its x-linked-etag identifies the file version.
				const head = await fetch(fileUrl(board.subset), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
				const etag = head.headers.get('x-linked-etag') ?? head.headers.get('etag') ?? '';
				if (etag && store.etags.get(board.subset) === etag) return undefined;
				if (!etag) logger.warn({ subset: board.subset, status: head.status }, 'Arena file has no etag, downloading every refresh');

				const response = await fetch(fileUrl(board.subset), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
				if (!response.ok) throw new Error(`Arena ${board.subset} returned ${response.status}`);
				const raw = (await parquetReadObjects({ file: await response.arrayBuffer() })) as Array<Record<string, unknown>>;
				loadBoard(board, raw.map(toArenaRow).filter((r): r is ArenaRow => r !== undefined));
				if (etag) store.etags.set(board.subset, etag);
				return board.subset;
			} catch (e) {
				logger.warn({ subset: board.subset, err: e }, 'Arena leaderboard fetch failed');
				return undefined;
			}
		}),
	);
	return { updated: results.filter((s): s is string => s !== undefined) };
}

function loadBoard(board: (typeof BOARDS)[number], rows: ArenaRow[]): void {
	store.index.set(board.subset, buildIndex(rows, board.categories));
	store.published.set(board.subset, rows.reduce((max, r) => (r.published > max ? r.published : max), ''));
}

function buildIndex(rows: ArenaRow[], categories: Record<string, string>): Map<string, CategoryIndex> {
	const byCategory = new Map<string, ArenaRow[]>(Object.keys(categories).map((c) => [c, []]));
	for (const r of rows) byCategory.get(r.category)?.push(r);

	const index = new Map<string, CategoryIndex>();
	for (const [category, inCategory] of byCategory) {
		const lowers = inCategory.map((r) => r.score_lower).sort((a, b) => b - a);
		const rankUbs = inCategory.map((r) => 1 + countAbove(lowers, r.score_upper));
		const tieSizes = new Map<number, number>();
		for (const ub of rankUbs) tieSizes.set(ub, (tieSizes.get(ub) ?? 0) + 1);

		const best = new Map<string, IndexedEntry>();
		inCategory.forEach((row, i) => {
			const base = arenaBase(row.model_name);
			const current = best.get(base);
			if (current && current.row.rank <= row.rank) return;
			best.set(base, { row, rankUb: rankUbs[i], tied: (tieSizes.get(rankUbs[i]) ?? 0) > 1 });
		});
		index.set(category, { of: inCategory.length, best });
	}
	return index;
}

/** Count of values in a descending list strictly greater than x. */
function countAbove(desc: number[], x: number): number {
	let lo = 0;
	let hi = desc.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (desc[mid] > x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Normalise the two row shapes: rating boards and the agent board. */
export function toArenaRow(r: Record<string, unknown>): ArenaRow | undefined {
	const name = typeof r.model_name === 'string' ? r.model_name : undefined;
	const category = typeof r.category === 'string' ? r.category : undefined;
	const rank = Number(r.rank);
	if (!name || !category || !Number.isFinite(rank)) return undefined;
	const isAgent = r.score !== undefined;
	return {
		model_name: name,
		category,
		rank,
		score: Number(isAgent ? r.score : r.rating),
		score_lower: Number(isAgent ? r.score_ci_lower : r.rating_lower),
		score_upper: Number(isAgent ? r.score_ci_upper : r.rating_upper),
		votes: Number(isAgent ? r.session_count : r.vote_count) || 0,
		published: toIsoDate(r.leaderboard_publish_date),
	};
}

/** "YYYY-MM-DD", whether the column decodes to a string or a Date, so dates compare as text. */
function toIsoDate(v: unknown): string {
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
	return typeof v === 'string' ? v.slice(0, 10) : '';
}

// Arena suffixes for reasoning effort, thinking budgets and snapshot dates.
const VARIANT_SUFFIX = /-(minimal|low|medium|high|xhigh|max|thinking|thinking-minimal|\d+k|\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

/** Arena name -> comparable base with effort, budget and date suffixes removed, e.g. "GPT 5.4 (High)" -> gpt-5-4. */
export function arenaBase(name: string): string {
	let s = name.toLowerCase().replace(/\(([^)]*)\)/g, '-$1').replace(/[\s._]+/g, '-').replace(/-+/g, '-').replace(/-$/, '');
	for (let m = VARIANT_SUFFIX.exec(s); m; m = VARIANT_SUFFIX.exec(s)) s = s.slice(0, m.index);
	return s;
}

/** The Arena base our alias maps to: its own base (modelNames.ts) unless the LLM matched it elsewhere. */
function arenaTarget(model: LitellmModel): string {
	const base = modelBase(model.name);
	return store.llmMatches?.map[base] ?? base;
}

/** Arena rankings for a model, best variant per category. Empty when unmatched. */
export function arenaRankings(model: LitellmModel): ArenaRanking[] {
	const target = arenaTarget(model);
	const out: ArenaRanking[] = [];
	for (const board of BOARDS) {
		const index = store.index.get(board.subset);
		if (!index) continue;
		for (const [category, label] of Object.entries(board.categories)) {
			const entry = index.get(category);
			const best = entry?.best.get(target);
			if (!entry || !best) continue;
			const { row } = best;
			out.push({
				board: board.label,
				category,
				label,
				rank: row.rank,
				rank_ub: best.rankUb,
				tied: best.tied,
				of: entry.of,
				arena_model: row.model_name,
				published: row.published,
			});
		}
	}
	return out;
}

/** True when a model has any Arena ranking; cheaper than arenaRankings(model).length. */
export function hasArenaRankings(model: LitellmModel): boolean {
	const target = arenaTarget(model);
	for (const categories of store.index.values()) for (const entry of categories.values()) if (entry.best.has(target)) return true;
	return false;
}

/** Newest publish date across the loaded leaderboards. */
export function arenaPublished(): string | undefined {
	let latest: string | undefined;
	for (const p of store.published.values()) if (p && (!latest || p > latest)) latest = p;
	return latest;
}

const ArenaMatchesSchema = z.object({
	matches: z.array(z.object({
		ours: z.string().describe('One of our names, exactly as listed'),
		arena: z.string().describe('The Arena name for the same model and version, exactly as listed'),
	})),
});

/**
 * For our models with no exact Arena match, ask an LLM to map their base name
 * to an Arena base, only when it is the same model and version. One call per
 * change to either list; answers naming unknown Arena bases are dropped.
 */
export async function matchUnmatchedWithLlm(models: ReadonlyArray<LitellmModel>): Promise<void> {
	const arenaBases = [
		...new Set([...store.index.values()].flatMap((cats) => [...cats.values()].flatMap((c) => [...c.best.keys()]))),
	].sort();
	if (arenaBases.length === 0) return;
	const known = new Set(arenaBases);
	// Base name plus the underlying model id, which carries details aliases drop
	// (e.g. ministral-8b is bedrock/mistral.ministral-3-8b-instruct).
	const underlying = new Map<string, string>();
	for (const m of models) {
		const base = modelBase(m.name);
		if (m.mode !== 'embedding' && !known.has(base) && !underlying.has(base)) underlying.set(base, m.litellm_model);
	}
	const unmatched = [...underlying.keys()].sort();
	const key = createHash('sha256').update(JSON.stringify({ unmatched: [...underlying], arenaBases })).digest('hex');
	if (store.llmMatches?.key === key || unmatched.length === 0) return;

	const { config } = getLitellmConfig();
	if (!config) return;
	const raw = await chatJson(config, STRONG_MODEL.model, [
		{
			role: 'system',
			content: `Map each of our model names to the Arena leaderboard name for the same model and version.
Each of our names is followed by the underlying model id it runs; use the id to identify the
model. Only map when certain. A different size, version, generation or family is not a match
(e.g. "gpt-4o" vs "gpt-4o-mini", "glm-5" vs "glm-5.1", Ministral 3 8B vs "ministral-8b-2410").
Use only exact names from the lists, our name without the id; leave out models with no match.`,
		},
		{
			role: 'user',
			content: `Our names:\n${unmatched.map((b) => `${b} (runs ${underlying.get(b)})`).join('\n')}\n\nArena names:\n${arenaBases.join('\n')}`,
		},
	], ArenaMatchesSchema, { name: 'arena_matches', params: STRONG_MODEL.params });
	if (raw.error !== undefined) {
		logger.warn({ error: raw.error }, 'Arena name matching failed');
		return;
	}
	const ours = new Set(unmatched);
	const map: Record<string, string> = {};
	for (const { ours: k, arena: v } of raw.value.matches) if (ours.has(k) && known.has(v)) map[k] = v;
	store.llmMatches = { key, map };
}

/** Test hook. */
export function resetArena(rows?: Record<string, ArenaRow[]>): void {
	store.index = new Map();
	store.published = new Map();
	for (const board of BOARDS) if (rows?.[board.subset]) loadBoard(board, rows[board.subset]);
	store.etags = new Map();
	store.llmMatches = undefined;
}

/** Short text for a ranking, e.g. "tied #1 of 408 (12th by score)" or "#1 of 138". */
export function describeRank(r: Pick<ArenaRanking, 'rank' | 'rank_ub' | 'tied' | 'of'>): string {
	if (!r.tied && r.rank_ub === r.rank) return `#${r.rank} of ${r.of}`;
	return `${r.tied ? 'tied ' : ''}#${r.rank_ub} of ${r.of} (${ordinal(r.rank)} by score)`;
}

function ordinal(n: number): string {
	const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
	return `${n}${s}`;
}
