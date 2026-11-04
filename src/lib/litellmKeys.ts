/**
 * Client for LiteLLM's virtual-key admin API - mirrors
 * slack-app/litellm_user_management.py's endpoints and behaviour.
 */
import { getTeams, litellmFetch } from './litellm';
import { logger } from './logging';
import type { LitellmTeamList } from './litellm';

export const KEY_ALIAS_PATTERN = /^[a-zA-Z]+(?:[-_]+[a-zA-Z0-9]+)*$/;

const DEFAULT_KEY_DURATION = process.env.KEY_DURATION || '60d';

// Mirrors slack-app/litellm_user_management.py's UNSELECTABLE_TEAMS.
const UNSELECTABLE_TEAMS = new Set(['platform', 'infra-playground', 'personal']);

// Alias of the team personal (no-team) keys are scoped to.
const PERSONAL_TEAM_ALIAS = 'personal';

// Applied at user level - LiteLLM tracks this as one bucket per user_id,
// shared across all of a user's keys.
const DEFAULT_USER_TPM_LIMIT = 10_000_000;
const DEFAULT_USER_RPM_LIMIT = 5_000;
const DEFAULT_USER_MAX_BUDGET = 4_000.0;
const DEFAULT_USER_BUDGET_DURATION = '30d';

export interface LitellmKey {
	token: string;
	alias: string;
	/** ISO-8601, or undefined if the key never expires. */
	expires?: string;
	teamId?: string;
}

export interface ResolveUserResult {
	userId?: string;
	error?: string;
}

/**
 * The user-level budget and rate limits LiteLLM shares across all of a user's
 * keys. Budget accumulates over budget_duration and resets at resetAt; the
 * tpm/rpm limits are per-minute caps. Any field the proxy omits comes back null.
 */
export interface UserBudget {
	/** Spend so far in the current budget period. */
	spend: number;
	/** Budget ceiling for the period, or null if uncapped. */
	maxBudget: number | null;
	/** ISO-8601 timestamp the budget next resets, or null if unknown. */
	resetAt: string | null;
	/** Tokens-per-minute cap, or null if uncapped. */
	tpmLimit: number | null;
	/** Requests-per-minute cap, or null if uncapped. */
	rpmLimit: number | null;
}

export interface LitellmUserKeysResult {
	keys: ReadonlyArray<LitellmKey>;
	/** Present when /user/info returned the user's budget block. */
	budget?: UserBudget;
	error?: string;
}

export interface GenerateKeyResult {
	key?: string;
	alias?: string;
	error?: string;
}

export interface DeleteKeyResult {
	ok: boolean;
	error?: string;
}

/** The LiteLLM user id for this email, or undefined if there is no such user. Never creates one. */
export async function getUserId(email: string): Promise<ResolveUserResult> {
	const { body, error } = await litellmFetch('/user/list', { params: { user_email: email }, log: { email } });
	if (error !== undefined) return { error };

	const userId = body?.users?.[0]?.user_id;
	return { userId: typeof userId === 'string' ? userId : undefined };
}

/**
 * Resolves the user id, creating the account if needed. Only call this from
 * the generate action - viewing the page must use getUserId instead, so it
 * never creates an account as a side effect.
 */
export async function getOrCreateUserId(email: string): Promise<ResolveUserResult> {
	const existing = await getUserId(email);
	if (existing.userId !== undefined || existing.error !== undefined) {
		return existing;
	}

	const { body, error } = await litellmFetch('/user/new', {
		json: {
			user_email: email,
			username: email,
			user_role: 'internal_user',
			auto_create_key: false,
			tpm_limit: DEFAULT_USER_TPM_LIMIT,
			rpm_limit: DEFAULT_USER_RPM_LIMIT,
			max_budget: DEFAULT_USER_MAX_BUDGET,
			budget_duration: DEFAULT_USER_BUDGET_DURATION,
		},
		expect: (b) => typeof b?.user_id === 'string',
		log: { email },
	});
	if (error !== undefined) return { error };

	logger.info({ email, userId: body.user_id }, 'Created LiteLLM user');
	return { userId: body.user_id };
}

/**
 * Resets this user's tpm/rpm to the current defaults.
 *
 * Deliberately excludes max_budget/budget_duration - LiteLLM resets
 * budget_reset_at to "now + duration" whenever budget_duration is passed,
 * so setting it on every key regen would stop the budget ever resetting.
 */
export async function ensureUserLimits(userId: string): Promise<{ ok: boolean; error?: string }> {
	const { error } = await litellmFetch('/user/update', {
		json: { user_id: userId, tpm_limit: DEFAULT_USER_TPM_LIMIT, rpm_limit: DEFAULT_USER_RPM_LIMIT },
		log: { userId },
	});
	return error === undefined ? { ok: true } : { ok: false, error };
}

/** Every key this user holds. /user/info returns each key in full, expiry included. */
export async function getUserKeys(userId: string): Promise<LitellmUserKeysResult> {
	const { body, error } = await litellmFetch('/user/info', {
		params: { user_id: userId },
		expect: (b) => Array.isArray(b?.keys),
		log: { userId },
	});
	if (error !== undefined) return { keys: [], error };

	return {
		keys: body.keys.map((key: any) => ({
			token: key.token,
			alias: key.key_alias ?? 'unknown',
			expires: key.expires ?? undefined,
			teamId: key.team_id ?? undefined,
		})),
		budget: parseUserBudget(body.user_info),
	};
}

/** Pulls the user-level budget/limits out of /user/info's user_info block, or undefined if absent. */
function parseUserBudget(info: any): UserBudget | undefined {
	if (!info || typeof info !== 'object') return undefined;
	const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
	return {
		spend: num(info.spend) ?? 0,
		maxBudget: num(info.max_budget),
		resetAt: typeof info.budget_reset_at === 'string' ? info.budget_reset_at : null,
		tpmLimit: num(info.tpm_limit),
		rpmLimit: num(info.rpm_limit),
	};
}

/** The teams a user may assign a key to - litellm.ts's getTeams(), minus UNSELECTABLE_TEAMS. */
export async function listTeams(): Promise<LitellmTeamList> {
	const result = await getTeams();
	if (result.error !== undefined) return result;

	return { teams: result.teams.filter((team) => !UNSELECTABLE_TEAMS.has(team.name)) };
}

export interface ResolveTeamResult {
	teamId?: string;
	error?: string;
}

/** The id of the "personal" team, found by alias. */
export async function getPersonalTeamId(): Promise<ResolveTeamResult> {
	const { teams, error } = await getTeams();
	if (error !== undefined) return { error };

	const team = teams.find((t) => t.name === PERSONAL_TEAM_ALIAS);
	if (!team) return { error: `LiteLLM team "${PERSONAL_TEAM_ALIAS}" not found` };

	return { teamId: team.id };
}

/**
 * Issues a key for this user, optionally scoped to a team (defaults to
 * "personal"). Call ensureUserLimits beforehand - limits are enforced at
 * user level.
 */
export async function generateKey(params: { userId: string; alias: string; teamId?: string }): Promise<GenerateKeyResult> {
	let teamId = params.teamId;
	if (!teamId) {
		const { teamId: personalTeamId, error: teamError } = await getPersonalTeamId();
		if (!personalTeamId) return { error: teamError };
		teamId = personalTeamId;
	}

	const { body, error } = await litellmFetch('/key/generate', {
		json: {
			// Hardcoded, matching the Slack app - revisit once teams/policies are designed.
			models: ['all-team-models'],
			user_id: params.userId,
			duration: DEFAULT_KEY_DURATION,
			key_alias: params.alias,
			team_id: teamId,
		},
		expect: (b) => typeof b?.key === 'string',
		log: { alias: params.alias },
	});
	if (error !== undefined) return { error };

	logger.info({ alias: params.alias, userId: params.userId }, 'Generated LiteLLM key');
	return { key: body.key, alias: params.alias };
}

export async function deleteKey(token: string): Promise<DeleteKeyResult> {
	// Already gone (e.g. a double-submit) is the desired end state - treat as success.
	const { status, error } = await litellmFetch('/key/delete', { json: { keys: [token] }, tolerate: 404 });
	if (status === 404) logger.info({ token }, 'Key already deleted');
	return error === undefined ? { ok: true } : { ok: false, error };
}

/** The fixed three-segment alias shape: `{team-or-personal}/{email}/{description}`. */
export function buildKeyAlias(email: string, description: string, team?: string): string {
	return `${team || 'personal'}/${email}/${description}`;
}

/** The description segment of a three-segment alias, or the raw alias otherwise. Handles null/undefined gracefully. */
export function keyName(alias: string | null | undefined): string {
	if (!alias) return "unknown";
	const parts = alias.split('/');
	return parts.length === 3 ? parts[2] : alias;
}
