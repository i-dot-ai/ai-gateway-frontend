import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, init: { status?: number } = {}) {
	const status = init.status ?? 200;
	return new Response(JSON.stringify(body), { status });
}

describe('litellmKeys', () => {
	beforeEach(() => {
		process.env.LITELLM_URL = 'https://litellm.example.com';
		process.env.LITELLM_MASTER_KEY = 'test-key';
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	describe('KEY_ALIAS_PATTERN', () => {
		it('accepts letters, hyphens and underscores after the first segment', async () => {
			const { KEY_ALIAS_PATTERN } = await import('./litellmKeys');

			expect(KEY_ALIAS_PATTERN.test('default')).toBe(true);
			expect(KEY_ALIAS_PATTERN.test('batch-eval')).toBe(true);
			expect(KEY_ALIAS_PATTERN.test('my_script_2')).toBe(true);
		});

		it('rejects names starting with a digit, or containing spaces or slashes', async () => {
			const { KEY_ALIAS_PATTERN } = await import('./litellmKeys');

			expect(KEY_ALIAS_PATTERN.test('2fast')).toBe(false);
			expect(KEY_ALIAS_PATTERN.test('has space')).toBe(false);
			expect(KEY_ALIAS_PATTERN.test('has/slash')).toBe(false);
			expect(KEY_ALIAS_PATTERN.test('')).toBe(false);
		});
	});

	describe('buildKeyAlias', () => {
		it('builds a personal alias when no team is given', async () => {
			const { buildKeyAlias } = await import('./litellmKeys');

			expect(buildKeyAlias('a@example.com', 'default')).toBe('personal/a@example.com/default');
		});

		it('builds a team alias when a team is given', async () => {
			const { buildKeyAlias } = await import('./litellmKeys');

			expect(buildKeyAlias('a@example.com', 'batch-eval', 'policy-team')).toBe('policy-team/a@example.com/batch-eval');
		});
	});

	describe('keyName', () => {
		it('extracts the description from a three-segment alias', async () => {
			const { keyName } = await import('./litellmKeys');

			expect(keyName('personal/a@example.com/default')).toBe('default');
			expect(keyName('policy-team/a@example.com/batch-eval')).toBe('batch-eval');
		});

		it('returns the raw alias when not three segments', async () => {
			const { keyName } = await import('./litellmKeys');

			expect(keyName('simple-alias')).toBe('simple-alias');
			expect(keyName('two/parts')).toBe('two/parts');
		});

		it('returns unknown for null or undefined', async () => {
			const { keyName } = await import('./litellmKeys');

			expect(keyName(null)).toBe('unknown');
			expect(keyName(undefined)).toBe('unknown');
		});
	});

	describe('getUserId', () => {
		it('returns the user id when a matching user exists', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ users: [{ user_id: 'user-1' }] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getUserId } = await import('./litellmKeys');

			const result = await getUserId('a@example.com');

			expect(result).toEqual({ userId: 'user-1' });
			const [url, options] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/user/list?user_email=a%40example.com');
			expect(options.headers.Authorization).toBe('Bearer test-key');
		});

		it('returns undefined when there is no such user', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ users: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getUserId } = await import('./litellmKeys');

			const result = await getUserId('a@example.com');

			expect(result).toEqual({ userId: undefined });
		});

		it('returns an error when LiteLLM responds non-2xx', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getUserId } = await import('./litellmKeys');

			const result = await getUserId('a@example.com');

			expect(result).toEqual({ error: 'LiteLLM returned 500' });
		});
	});

	describe('getOrCreateUserId', () => {
		it('returns the existing user id without creating one', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ users: [{ user_id: 'user-1' }] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getOrCreateUserId } = await import('./litellmKeys');

			const result = await getOrCreateUserId('a@example.com');

			expect(result).toEqual({ userId: 'user-1' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('creates a user when none exists yet', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ users: [] }))
				.mockResolvedValueOnce(jsonResponse({ user_id: 'new-user' }));
			vi.stubGlobal('fetch', fetchMock);
			const { getOrCreateUserId } = await import('./litellmKeys');

			const result = await getOrCreateUserId('a@example.com');

			expect(result).toEqual({ userId: 'new-user' });
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const [, createOptions] = fetchMock.mock.calls[1];
			expect(createOptions.method).toBe('POST');
			expect(JSON.parse(createOptions.body)).toEqual({
				user_email: 'a@example.com',
				username: 'a@example.com',
				user_role: 'internal_user',
				auto_create_key: false,
				tpm_limit: 10_000_000,
				rpm_limit: 5_000,
				max_budget: 4_000,
				budget_duration: '30d',
			});
		});

		it('does not attempt to create a user when the lookup itself failed', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getOrCreateUserId } = await import('./litellmKeys');

			const result = await getOrCreateUserId('a@example.com');

			expect(result).toEqual({ error: 'LiteLLM returned 500' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('ensureUserLimits', () => {
		it('sends the current defaults for this user', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
			vi.stubGlobal('fetch', fetchMock);
			const { ensureUserLimits } = await import('./litellmKeys');

			const result = await ensureUserLimits('user-1');

			expect(result).toEqual({ ok: true });
			const [url, options] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/user/update');
			expect(options.method).toBe('POST');
			expect(JSON.parse(options.body)).toEqual({
				user_id: 'user-1',
				tpm_limit: 10_000_000,
				rpm_limit: 5_000,
			});
		});

		it('returns an error when LiteLLM fails', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { ensureUserLimits } = await import('./litellmKeys');

			const result = await ensureUserLimits('user-1');

			expect(result).toEqual({ ok: false, error: 'LiteLLM returned 500' });
		});
	});

	describe('getUserKeys', () => {
		it('maps keys, defaulting a null expiry to undefined', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					keys: [
						{ token: 'tok-1', key_alias: 'personal/a@example.com/default', expires: '2027-01-01T00:00:00Z', team_id: null },
						{ token: 'tok-2', key_alias: null, expires: null },
					],
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getUserKeys } = await import('./litellmKeys');

			const result = await getUserKeys('user-1');

			expect(result.error).toBeUndefined();
			expect(result.keys).toEqual([
				{ token: 'tok-1', alias: 'personal/a@example.com/default', expires: '2027-01-01T00:00:00Z', teamId: undefined },
				{ token: 'tok-2', alias: 'unknown', expires: undefined, teamId: undefined },
			]);
			expect(result.budget).toBeUndefined();
		});

		it('parses the user-level budget and limits from user_info', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					keys: [],
					user_info: {
						spend: 1234.5,
						max_budget: 4000,
						budget_reset_at: '2026-10-01T00:00:00Z',
						tpm_limit: 10_000_000,
						rpm_limit: 5_000,
					},
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getUserKeys } = await import('./litellmKeys');

			const result = await getUserKeys('user-1');

			expect(result.budget).toEqual({
				spend: 1234.5,
				maxBudget: 4000,
				resetAt: '2026-10-01T00:00:00Z',
				tpmLimit: 10_000_000,
				rpmLimit: 5_000,
			});
		});

		it('defaults missing budget fields to null and spend to zero', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ keys: [], user_info: {} }));
			vi.stubGlobal('fetch', fetchMock);
			const { getUserKeys } = await import('./litellmKeys');

			const result = await getUserKeys('user-1');

			expect(result.budget).toEqual({ spend: 0, maxBudget: null, resetAt: null, tpmLimit: null, rpmLimit: null });
		});
	});

	describe('listTeams', () => {
		it('filters out excluded internal teams', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					teams: [
						{ team_id: 't-1', team_alias: 'policy-team' },
						{ team_id: 't-2', team_alias: 'platform' },
						{ team_id: 't-3', team_alias: 'infra-playground' },
						{ team_id: 'personal', team_alias: 'personal' },
					],
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { listTeams } = await import('./litellmKeys');

			const result = await listTeams();

			expect(result.teams).toEqual([{ id: 't-1', name: 'policy-team' }]);
			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/v2/team/list?page_size=100');
		});
	});

	describe('generateKey', () => {
		it('returns the raw secret on success, scoped to the personal team when no team is given', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ teams: [{ team_id: 'pt-1', team_alias: 'personal' }] }))
				.mockResolvedValueOnce(jsonResponse({ key: 'sk-secret' }));
			vi.stubGlobal('fetch', fetchMock);
			const { generateKey } = await import('./litellmKeys');

			const result = await generateKey({ userId: 'user-1', alias: 'personal/a@example.com/default' });

			expect(result).toEqual({ key: 'sk-secret', alias: 'personal/a@example.com/default' });
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const [, options] = fetchMock.mock.calls[1];
			expect(JSON.parse(options.body)).toEqual({
				models: ['all-team-models'],
				user_id: 'user-1',
				duration: '60d',
				key_alias: 'personal/a@example.com/default',
				team_id: 'pt-1',
			});
		});

		it('passes team_id through when a team is given, without looking up the personal team', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: 'sk-secret' }));
			vi.stubGlobal('fetch', fetchMock);
			const { generateKey } = await import('./litellmKeys');

			await generateKey({ userId: 'user-1', alias: 'policy-team/a@example.com/default', teamId: 't-1' });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [, options] = fetchMock.mock.calls[0];
			expect(JSON.parse(options.body).team_id).toBe('t-1');
		});

		it('returns an error, without calling /key/generate, when the personal team cannot be resolved', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ teams: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { generateKey } = await import('./litellmKeys');

			const result = await generateKey({ userId: 'user-1', alias: 'default' });

			expect(result).toEqual({ error: 'LiteLLM team "personal" not found' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('returns an error when LiteLLM fails to generate the key', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ teams: [{ team_id: 'pt-1', team_alias: 'personal' }] }))
				.mockResolvedValueOnce(jsonResponse({}, { status: 400 }));
			vi.stubGlobal('fetch', fetchMock);
			const { generateKey } = await import('./litellmKeys');

			const result = await generateKey({ userId: 'user-1', alias: 'default' });

			expect(result).toEqual({ error: 'LiteLLM returned 400' });
		});
	});

	describe('deleteKey', () => {
		it('returns ok on success', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
			vi.stubGlobal('fetch', fetchMock);
			const { deleteKey } = await import('./litellmKeys');

			const result = await deleteKey('tok-1');

			expect(result).toEqual({ ok: true });
			const [, options] = fetchMock.mock.calls[0];
			expect(JSON.parse(options.body)).toEqual({ keys: ['tok-1'] });
		});

		it('treats an already-deleted key as success', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 }));
			vi.stubGlobal('fetch', fetchMock);
			const { deleteKey } = await import('./litellmKeys');

			const result = await deleteKey('tok-1');

			expect(result).toEqual({ ok: true });
		});

		it('returns an error for other failures', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { deleteKey } = await import('./litellmKeys');

			const result = await deleteKey('tok-1');

			expect(result).toEqual({ ok: false, error: 'LiteLLM returned 500' });
		});
	});

	describe('missing configuration', () => {
		it('returns an error without calling fetch when LITELLM_URL is unset', async () => {
			delete process.env.LITELLM_URL;
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			const { getUserId } = await import('./litellmKeys');

			const result = await getUserId('a@example.com');

			expect(result).toEqual({ error: 'LITELLM_URL is not configured' });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns an error without calling fetch when LITELLM_MASTER_KEY is unset', async () => {
			delete process.env.LITELLM_MASTER_KEY;
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			const { getUserId } = await import('./litellmKeys');

			const result = await getUserId('a@example.com');

			expect(result).toEqual({ error: 'LITELLM_MASTER_KEY is not configured' });
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
