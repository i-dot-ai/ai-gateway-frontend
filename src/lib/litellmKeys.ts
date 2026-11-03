/**
 * Client for LiteLLM's virtual-key admin API - mirrors
 * slack-app/litellm_user_management.py's endpoints and behaviour.
 */
import { apiUrl, getLitellmConfig, getTeams, logger, REQUEST_TIMEOUT_MS, unknownErrorMessage } from './litellm';
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
	const { config, error: configError } = getLitellmConfig();
	if (!config) return { error: configError };

	try {
		const response = await fetch(apiUrl(config, '/user/list', { user_email: email }), {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			return { error: `LiteLLM returned ${response.status}` };
		}

		const userId = body?.users?.[0]?.user_id;
		return { userId: typeof userId === 'string' ? userId : undefined };
	} catch (e) {
		logger.error({ err: e, email }, 'Unknown error contacting LiteLLM');
		return { error: unknownErrorMessage(e) };
	}
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

	const { config, error: configError } = getLitellmConfig();
	if (!config) return { error: configError };

	try {
		const response = await fetch(apiUrl(config, '/user/new'), {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				user_email: email,
				username: email,
				user_role: 'internal_user',
				auto_create_key: false,
				tpm_limit: DEFAULT_USER_TPM_LIMIT,
				rpm_limit: DEFAULT_USER_RPM_LIMIT,
				max_budget: DEFAULT_USER_MAX_BUDGET,
				budget_duration: DEFAULT_USER_BUDGET_DURATION,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok || typeof body?.user_id !== 'string') {
			logger.error({ status: response.status, email }, 'Failed to create LiteLLM user');
			return { error: `LiteLLM returned ${response.status}` };
		}

		logger.info({ email, userId: body.user_id }, 'Created LiteLLM user');
		return { userId: body.user_id };
	} catch (e) {
		logger.error({ err: e, email }, 'Unknown error contacting LiteLLM');
		return { error: unknownErrorMessage(e) };
	}
}

/**
 * Resets this user's tpm/rpm to the current defaults.
 *
 * Deliberately excludes max_budget/budget_duration - LiteLLM resets
 * budget_reset_at to "now + duration" whenever budget_duration is passed,
 * so setting it on every key regen would stop the budget ever resetting.
 */
export async function ensureUserLimits(userId: string): Promise<{ ok: boolean; error?: string }> {
	const { config, error: configError } = getLitellmConfig();
	if (!config) return { ok: false, error: configError };

	try {
		const response = await fetch(apiUrl(config, '/user/update'), {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				user_id: userId,
				tpm_limit: DEFAULT_USER_TPM_LIMIT,
				rpm_limit: DEFAULT_USER_RPM_LIMIT,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			logger.error({ status: response.status, userId }, 'Failed to update LiteLLM user limits');
			return { ok: false, error: `LiteLLM returned ${response.status}` };
		}
		return { ok: true };
	} catch (e) {
		logger.error({ err: e, userId }, 'Unknown error contacting LiteLLM');
		return { ok: false, error: unknownErrorMessage(e) };
	}
}

/** Every key this user holds. /user/info returns each key in full, expiry included. */
export async function getUserKeys(userId: string): Promise<LitellmUserKeysResult> {
	const { config, error: configError } = getLitellmConfig();
	if (!config) return { keys: [], error: configError };

	try {
		const response = await fetch(apiUrl(config, '/user/info', { user_id: userId }), {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok || !Array.isArray(body?.keys)) {
			return { keys: [], error: `LiteLLM returned ${response.status}` };
		}

		return {
			keys: body.keys.map((key: any) => ({
				token: key.token,
				alias: key.key_alias ?? 'unknown',
				expires: key.expires ?? undefined,
				teamId: key.team_id ?? undefined,
			})),
			budget: parseUserBudget(body.user_info),
		};
	} catch (e) {
		logger.error({ err: e, userId }, 'Unknown error contacting LiteLLM');
		return { keys: [], error: unknownErrorMessage(e) };
	}
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
	const { config, error: configError } = getLitellmConfig();
	if (!config) return { error: configError };

	let teamId = params.teamId;
	if (!teamId) {
		const { teamId: personalTeamId, error: teamError } = await getPersonalTeamId();
		if (!personalTeamId) return { error: teamError };
		teamId = personalTeamId;
	}

	try {
		const response = await fetch(apiUrl(config, '/key/generate'), {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				// Hardcoded, matching the Slack app - revisit once teams/policies are designed.
				models: ['all-team-models'],
				user_id: params.userId,
				duration: DEFAULT_KEY_DURATION,
				key_alias: params.alias,
				team_id: teamId,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		if (!response.ok || typeof body?.key !== 'string') {
			logger.error({ status: response.status, alias: params.alias }, 'Failed to generate LiteLLM key');
			return { error: `LiteLLM returned ${response.status}` };
		}

		logger.info({ alias: params.alias, userId: params.userId }, 'Generated LiteLLM key');
		return { key: body.key, alias: params.alias };
	} catch (e) {
		logger.error({ err: e, alias: params.alias }, 'Unknown error contacting LiteLLM');
		return { error: unknownErrorMessage(e) };
	}
}

export async function deleteKey(token: string): Promise<DeleteKeyResult> {
	const { config, error: configError } = getLitellmConfig();
	if (!config) return { ok: false, error: configError };

	try {
		const response = await fetch(apiUrl(config, '/key/delete'), {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys: [token] }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			// Already gone (e.g. a double-submit) is the desired end state - treat as success.
			if (response.status === 404) {
				logger.info({ token }, 'Key already deleted');
				return { ok: true };
			}
			logger.error({ status: response.status }, 'Failed to delete LiteLLM key');
			return { ok: false, error: `LiteLLM returned ${response.status}` };
		}

		return { ok: true };
	} catch (e) {
		logger.error({ err: e }, 'Unknown error contacting LiteLLM');
		return { ok: false, error: unknownErrorMessage(e) };
	}
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
