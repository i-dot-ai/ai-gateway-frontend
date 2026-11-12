import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, init: { status?: number } = {}) {
	const status = init.status ?? 200;
	return new Response(JSON.stringify(body), { status });
}

/** The calls a fetch mock made to the daily-activity endpoint. */
function activityCalls(fetchMock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
	return fetchMock.mock.calls.filter(([url]) => String(url).includes('/user/daily/activity'));
}

describe('litellm', () => {
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

	describe('checkLitellmHealth', () => {
		it('returns healthy with db status when the proxy responds 200', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ db: 'connected' }));
			vi.stubGlobal('fetch', fetchMock);
			const { checkLitellmHealth } = await import('./litellm');

			const result = await checkLitellmHealth();

			expect(result).toEqual({ healthy: true, db: 'connected', error: undefined });
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/health/readiness');
		});

		it('returns unhealthy with the status code when the proxy responds non-200', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ db: 'disconnected' }, { status: 503 }));
			vi.stubGlobal('fetch', fetchMock);
			const { checkLitellmHealth } = await import('./litellm');

			const result = await checkLitellmHealth();

			expect(result).toEqual({
				healthy: false,
				db: 'disconnected',
				error: 'LiteLLM returned 503',
			});
		});
	});

	function modelInfoResponse(overrides: Partial<Record<string, unknown>> = {}) {
		return {
			model_info: {
				id: 'model-1',
				litellm_provider: 'openai',
				mode: 'chat',
				supports_vision: false,
				supports_function_calling: true,
				supports_audio_input: false,
				supports_reasoning: false,
				max_input_tokens: 1000,
				max_output_tokens: 500,
				input_cost_per_token: 0.001,
				output_cost_per_token: 0.002,
				tpm: 100,
				rpm: 10,
				...overrides,
			},
			model_name: 'gpt-test',
		};
	}

	describe('getAllModels', () => {

		it('fetches and maps a single page of models', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					data: [modelInfoResponse()],
					current_page: 1,
					total_pages: 1,
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getAllModels } = await import('./litellm');

			const result = await getAllModels();

			expect(result.error).toBeUndefined();
			expect(result.models).toHaveLength(1);
			expect(result.models[0]).toMatchObject({
				id: 'model-1',
				name: 'gpt-test',
				provider: 'openai',
				mode: 'chat',
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, options] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/v2/model/info?page=1');
			expect(options.headers.Authorization).toBe('Bearer test-key');
		});

		it('filters models by capability', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					data: [
						modelInfoResponse({ id: 'vision-model', supports_vision: true }),
						modelInfoResponse({ id: 'text-model', supports_vision: false }),
					],
					current_page: 1,
					total_pages: 1,
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getAllModels } = await import('./litellm');

			const result = await getAllModels({ supports_vision: true });

			expect(result.models.map((m) => m.id)).toEqual(['vision-model']);
		});

		it('casts a sparsely populated model to safe defaults', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					data: [
						{
							model_info: {
								id: 'sparse-model',
								litellm_provider: 'openai',
								mode: 'chat',
								// All capability/numeric fields omitted, as LiteLLM
								// does for some models (e.g. no pricing configured).
							},
							model_name: 'sparse-test',
						},
					],
					current_page: 1,
					total_pages: 1,
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getAllModels } = await import('./litellm');

			const result = await getAllModels();

			expect(result.models).toHaveLength(1);
			expect(result.models[0]).toMatchObject({
				id: 'sparse-model',
				supports_vision: false,
				supports_function_calling: false,
				supports_audio_input: false,
				supports_reasoning: false,
				max_input_tokens: undefined,
				max_output_tokens: undefined,
				input_cost_per_token: undefined,
				output_cost_per_token: undefined,
				tpm: undefined,
				rpm: undefined,
			});
		});
	});

	describe('getModel', () => {
		it('returns the matching model by id', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					data: [modelInfoResponse({ id: 'model-1' }), modelInfoResponse({ id: 'model-2' })],
					current_page: 1,
					total_pages: 1,
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getModel } = await import('./litellm');

			const result = await getModel('model-2');

			expect(result.error).toBeUndefined();
			expect(result.model?.id).toBe('model-2');
		});

		it('returns an error when the model is not found', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					data: [modelInfoResponse({ id: 'model-1' })],
					current_page: 1,
					total_pages: 1,
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getModel } = await import('./litellm');

			const result = await getModel('missing');

			expect(result).toEqual({ error: 'Model not found' });
		});

		it('returns a pass-through model without needing /v2/model/info', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getModel } = await import('./litellm');

			const result = await getModel('jev');

			expect(result.error).toBeUndefined();
			expect(result.model?.name).toBe('jev-latest');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('returns a pass-through tool with its endpoints', async () => {
			vi.stubGlobal('fetch', vi.fn());
			const { getModel } = await import('./litellm');
			const { isPassThrough } = await import('./passThroughModels');

			const { model } = await getModel('tavily');

			expect(model && isPassThrough(model) && model.passThrough.endpoints).toContain('/tavily/search');
		});
	});

	describe('getCosts', () => {
		function fetchMockFor(
			activityResponse: Response,
			teamsResponse: Response = jsonResponse({ teams: [] }),
			keysResponse: Response = jsonResponse({ keys: [], total_pages: 1 })
		) {
			return vi.fn((url: string | URL, _options: RequestInit) => {
				const path = new URL(url).pathname;
				if (path === '/v2/team/list') {
					return Promise.resolve(teamsResponse.clone());
				}
				if (path === '/key/list') {
					return Promise.resolve(keysResponse.clone());
				}
				return Promise.resolve(activityResponse.clone());
			});
		}

		it('flattens the nested breakdown into one row per model/api-key, enriched with the team name', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {
									'gpt-4': {
										api_key_breakdown: {
											'key-hash-1': {
												metrics: { spend: 1.5, total_tokens: 100, prompt_tokens: 70, completion_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, api_requests: 5, failed_requests: 1 },
												metadata: { key_alias: 'my-key', team_id: 'team-a' },
											},
										},
									},
								},
							},
						},
					],
				}),
				jsonResponse({ teams: [{ team_id: 'team-a', team_alias: 'Team Alpha' }] })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result.error).toBeUndefined();
			expect(result.costs).toEqual([
				{
					date: '2024-06-01',
					model_name: 'gpt-4',
					spend: 1.5,
					total_tokens: 100,
					prompt_tokens: 70,
					completion_tokens: 30,
					cache_read_input_tokens: 40,
					cache_creation_input_tokens: 10,
					api_requests: 5,
					failed_requests: 1,
					key_alias: 'my-key',
					key_token: 'key-hash-1',
					user_id: null,
					team_id: 'team-a',
					team_name: 'Team Alpha',
				},
			]);
			const activityCall = activityCalls(fetchMock)[0];
			expect(String(activityCall![0])).toBe(
				'https://litellm.example.com/user/daily/activity/aggregated?start_date=2024-05-27&end_date=2024-06-02'
			);
			expect((activityCall![1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
				'Bearer test-key'
			);
		});

		it('joins each key to its owning user_id from /key/list, leaving unlisted keys null', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {
									'gpt-4': {
										api_key_breakdown: {
											'key-hash-owned': { metrics: { spend: 1, total_tokens: 10 }, metadata: { key_alias: 'a', team_id: '' } },
											'key-hash-orphan': { metrics: { spend: 2, total_tokens: 20 }, metadata: { key_alias: 'b', team_id: '' } },
										},
									},
								},
							},
						},
					],
				}),
				jsonResponse({ teams: [] }),
				jsonResponse({ keys: [{ token: 'key-hash-owned', user_id: 'user-1' }], total_pages: 1 })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			const byToken = Object.fromEntries(result.costs.map((c) => [c.key_token, c.user_id]));
			expect(byToken).toEqual({ 'key-hash-owned': 'user-1', 'key-hash-orphan': null });
			expect(result.usersUnavailable).toBe(false);
		});

		it('flags usersUnavailable (but still returns costs) when the key-owner lookup fails', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {
									'gpt-4': {
										api_key_breakdown: {
											'key-hash-1': { metrics: { spend: 1, total_tokens: 10 }, metadata: { key_alias: 'a', team_id: '' } },
										},
									},
								},
							},
						},
					],
				}),
				jsonResponse({ teams: [] }),
				jsonResponse({}, { status: 500 })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			// The costs are sound, so the lookup still succeeds - only the user join is
			// lost, so every user_id is null and the flag tells the page to say so.
			expect(result.error).toBeUndefined();
			expect(result.usersUnavailable).toBe(true);
			expect(result.costs[0].user_id).toBeNull();
			expect(result.costs[0].spend).toBe(1);
		});

		it('flattens the providers breakdown into one row per provider/api-key', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {},
								providers: {
									vertex_ai: {
										api_key_breakdown: {
											'key-hash-1': {
												metrics: { spend: 2, total_tokens: 200, api_requests: 8, failed_requests: 2 },
												metadata: { key_alias: 'my-key', team_id: 'team-a' },
											},
										},
									},
								},
							},
						},
					],
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result.error).toBeUndefined();
			expect(result.providerCosts).toEqual([
				{ date: '2024-06-01', provider: 'vertex_ai', spend: 2, total_tokens: 200, api_requests: 8, failed_requests: 2, key_alias: 'my-key' },
			]);
		});

		it('treats a missing providers breakdown as no provider rows', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [{ date: '2024-06-01', breakdown: { models: {} } }],
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result.providerCosts).toEqual([]);
		});

		it('falls back to the team_id when the team has no alias or is unknown', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {
									'gpt-4': {
										api_key_breakdown: {
											'key-hash-1': {
												metrics: { spend: 1, total_tokens: 10 },
												metadata: { key_alias: 'my-key', team_id: 'team-unknown' },
											},
										},
									},
								},
							},
						},
					],
				}),
				jsonResponse({ teams: [{ team_id: 'team-a', team_alias: 'Team Alpha' }] })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result.costs[0].team_name).toBe('team-unknown');
		});

		it('does not fail the whole lookup if /team/list errors, falling back to team_id', async () => {
			const fetchMock = fetchMockFor(
				jsonResponse({
					results: [
						{
							date: '2024-06-01',
							breakdown: {
								models: {
									'gpt-4': {
										api_key_breakdown: {
											'key-hash-1': {
												metrics: { spend: 1, total_tokens: 10 },
												metadata: { key_alias: 'my-key', team_id: 'team-a' },
											},
										},
									},
								},
							},
						},
					],
				}),
				jsonResponse({}, { status: 500 })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result.error).toBeUndefined();
			expect(result.costs[0].team_name).toBe('team-a');
			// The proxy omitted api_requests and failed_requests from this row's metrics.
			expect(result.costs[0].api_requests).toBe(0);
			expect(result.costs[0].failed_requests).toBe(0);
		});

		it('returns an error when the proxy responds non-200', async () => {
			const fetchMock = fetchMockFor(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-27', '2024-06-02');

			expect(result).toEqual({ costs: [], providerCosts: [], error: 'LiteLLM returned 500' });
		});

		it('serves a repeat call for the same date range from cache without hitting LiteLLM again', async () => {
			const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			await getCosts('2024-05-27', '2024-06-02');
			await getCosts('2024-05-27', '2024-06-02');

			expect(activityCalls(fetchMock)).toHaveLength(1);
		});

		it('treats a different date range as a separate cache entry', async () => {
			const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			await getCosts('2024-05-27', '2024-06-02');
			await getCosts('2024-06-03', '2024-06-09');

			expect(activityCalls(fetchMock)).toHaveLength(2);
		});

		it('does not cache a failed response, so the next call retries', async () => {
			let call = 0;
			const fetchMock = vi.fn((url: string | URL) => {
				const path = new URL(url).pathname;
				if (path === '/v2/team/list') {
					return Promise.resolve(jsonResponse({ teams: [] }));
				}
				if (path === '/key/list') {
					return Promise.resolve(jsonResponse({ keys: [], total_pages: 1 }));
				}
				call += 1;
				return Promise.resolve(call === 1 ? jsonResponse({}, { status: 500 }) : jsonResponse({ results: [] }));
			});
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const first = await getCosts('2024-05-27', '2024-06-02');
			const second = await getCosts('2024-05-27', '2024-06-02');

			expect(first.error).toBe('LiteLLM returned 500');
			expect(second.error).toBeUndefined();
			expect(call).toBe(2);
		});

		it('keeps a settled platform-wide week for good, and a user-scoped one for a day', async () => {
			vi.useFakeTimers();
			try {
				const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
				vi.stubGlobal('fetch', fetchMock);
				const { getCosts } = await import('./litellm');

				await getCosts('2024-05-27', '2024-06-02');
				await getCosts('2024-05-27', '2024-06-02', 'user-1');
				vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
				await getCosts('2024-05-27', '2024-06-02');
				await getCosts('2024-05-27', '2024-06-02', 'user-1');

				expect(activityCalls(fetchMock)).toHaveLength(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it('stops starting new weeks once one fails', async () => {
			const fetchMock = fetchMockFor(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			// Ten weeks, three at a time: the first batch fails, so no more are started.
			const result = await getCosts('2024-04-01', '2024-06-09');

			expect(result.error).toBe('LiteLLM returned 500');
			expect(activityCalls(fetchMock)).toHaveLength(3);
		});

		it('gives up on a slow range at the deadline without starting more weeks', async () => {
			vi.useFakeTimers();
			try {
				const fetchMock = vi.fn((url: string | URL) => {
					const path = new URL(url).pathname;
					if (path === '/v2/team/list') return Promise.resolve(jsonResponse({ teams: [] }));
					if (path === '/key/list') return Promise.resolve(jsonResponse({ keys: [], total_pages: 1 }));
					return new Promise<Response>(() => {});
				});
				vi.stubGlobal('fetch', fetchMock);
				const { getCosts } = await import('./litellm');

				const pending = getCosts('2024-04-01', '2024-06-09');
				await vi.advanceTimersByTimeAsync(90 * 1000);

				expect((await pending).error).toBe('Usage for this range is still loading. Try again in a minute.');
				expect(activityCalls(fetchMock)).toHaveLength(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it('refreshes the current week every 30 min platform-wide and every 5 min for one user', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2024-06-05T12:00:00Z'));
			try {
				const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
				vi.stubGlobal('fetch', fetchMock);
				const { getCosts } = await import('./litellm');

				await getCosts('2024-06-03', '2024-06-05');
				await getCosts('2024-06-03', '2024-06-05', 'user-1');
				vi.advanceTimersByTime(5 * 60 * 1000 + 1);
				await getCosts('2024-06-03', '2024-06-05');
				await getCosts('2024-06-03', '2024-06-05', 'user-1');
				expect(activityCalls(fetchMock)).toHaveLength(3);

				vi.advanceTimersByTime(25 * 60 * 1000);
				await getCosts('2024-06-03', '2024-06-05');
				expect(activityCalls(fetchMock)).toHaveLength(4);
			} finally {
				vi.useRealTimers();
			}
		});

		it('warms the weekly blocks newest first, refreshing the current week each run', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2024-06-05T12:00:00Z'));
			try {
				const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
				vi.stubGlobal('fetch', fetchMock);
				const { startCostsWarmer } = await import('./litellm');
				const starts = () => activityCalls(fetchMock).map(([url]) => new URL(String(url)).searchParams.get('start_date'));

				const stop = startCostsWarmer(() => ({ startDate: '2024-05-27', endDate: '2024-06-05' }));
				await vi.advanceTimersByTimeAsync(0);
				expect(starts()).toEqual(['2024-06-03', '2024-05-27']);
				// Only the weekly blocks: no team or key-owner lookups.
				expect(fetchMock).toHaveBeenCalledTimes(2);

				// The current week is refetched while still fresh; the settled one stays cached.
				await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
				expect(starts()).toEqual(['2024-06-03', '2024-05-27', '2024-06-03']);

				stop();
				await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
				expect(starts()).toHaveLength(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it('fetches a range as Monday-to-Sunday weeks and trims the rows back to the range', async () => {
			const breakdown = { api_key_breakdown: { k: { metrics: { spend: 1, total_tokens: 1 }, metadata: { key_alias: 'a' } } } };
			const day = (date: string) => ({ date, breakdown: { models: { 'gpt-4': breakdown }, providers: { bedrock: breakdown } } });
			const fetchMock = vi.fn((url: string | URL) => {
				const path = new URL(url).pathname;
				if (path === '/v2/team/list') return Promise.resolve(jsonResponse({ teams: [] }));
				if (path === '/key/list') return Promise.resolve(jsonResponse({ keys: [], total_pages: 1 }));
				const start = new URL(url).searchParams.get('start_date')!;
				// Each week returns its first and last day.
				return Promise.resolve(jsonResponse({ results: start === '2024-05-27' ? [day('2024-05-27'), day('2024-06-02')] : [day('2024-06-03'), day('2024-06-09')] }));
			});
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			const result = await getCosts('2024-05-29', '2024-06-04');

			const windows = activityCalls(fetchMock).map(([url]) => {
				const params = new URL(String(url)).searchParams;
				return `${params.get('start_date')}..${params.get('end_date')}`;
			});
			expect(windows).toEqual(['2024-05-27..2024-06-02', '2024-06-03..2024-06-09']);
			expect(result.costs.map((c) => c.date)).toEqual(['2024-06-02', '2024-06-03']);
			expect(result.providerCosts.map((c) => c.date)).toEqual(['2024-06-02', '2024-06-03']);
		});

		it('collapses concurrent calls for the same range into a single upstream fetch', async () => {
			// A slow response, so both callers overlap while the fetch is in flight.
			let resolveActivity: (r: Response) => void = () => {};
			const activity = new Promise<Response>((resolve) => {
				resolveActivity = resolve;
			});
			const fetchMock = vi.fn(async (url: string | URL) => {
				const path = new URL(url).pathname;
				if (path === '/v2/team/list') return jsonResponse({ teams: [] });
				if (path === '/key/list') return jsonResponse({ keys: [], total_pages: 1 });
				return activity.then((r) => r.clone());
			});
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			// Fire both before the fetch resolves, then let it complete.
			const both = Promise.all([getCosts('2024-05-27', '2024-06-02'), getCosts('2024-05-27', '2024-06-02')]);
			resolveActivity(jsonResponse({ results: [] }));
			await both;

			expect(activityCalls(fetchMock)).toHaveLength(1);
		});

		it('scopes the aggregation to a user_id when one is given', async () => {
			const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			await getCosts('2024-05-27', '2024-06-02', 'user-123');

			const activityCall = fetchMock.mock.calls.find(([url]) => !String(url).includes('/team/list'));
			expect(String(activityCall![0])).toBe(
				'https://litellm.example.com/user/daily/activity/aggregated?start_date=2024-05-27&end_date=2024-06-02&user_id=user-123'
			);
		});

		it('caches user-scoped and platform-wide lookups of the same range separately', async () => {
			const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			await getCosts('2024-05-27', '2024-06-02');
			await getCosts('2024-05-27', '2024-06-02', 'user-123');

			expect(activityCalls(fetchMock)).toHaveLength(2);
		});

		it('coalesces concurrent cold calls for the same range into a single fetch', async () => {
			const fetchMock = fetchMockFor(jsonResponse({ results: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const { getCosts } = await import('./litellm');

			await Promise.all([getCosts('2024-05-27', '2024-06-02'), getCosts('2024-05-27', '2024-06-02')]);

			expect(activityCalls(fetchMock)).toHaveLength(1);
		});
	});

	describe('getModelCosts for a pass-through model', () => {
		it("matches Jev's typesafe/jev-* model groups by prefix, joined to team names", async () => {
			const fetchMock = vi.fn((url: string | URL) => {
				const path = new URL(url).pathname;
				if (path === '/v2/team/list') {
					return Promise.resolve(jsonResponse({ teams: [{ team_id: 'team-a', team_alias: 'Team Alpha' }] }));
				}
				return Promise.resolve(
					jsonResponse({
						results: [
							{
								date: '2024-06-01',
								breakdown: {
									model_groups: {
										'gpt-4': {
											api_key_breakdown: {
												k1: { metrics: { spend: 5, total_tokens: 50 }, metadata: { key_alias: 'a', team_id: 'team-a' } },
											},
										},
										// The versioned name TypeSafe reports, plus the bare alias.
										'typesafe/jev-1.13.0': {
											api_key_breakdown: {
												k2: { metrics: { spend: 2, total_tokens: 20 }, metadata: { key_alias: 'b', team_id: 'team-a' } },
											},
										},
										'typesafe/jev-latest': {
											api_key_breakdown: {
												k3: { metrics: { spend: 1, total_tokens: 10 }, metadata: { key_alias: 'c', team_id: '' } },
											},
										},
										// Another TypeSafe model is not Jev.
										'typesafe/other-1.0.0': {
											api_key_breakdown: {
												k4: { metrics: { spend: 9, total_tokens: 90 }, metadata: { key_alias: 'd', team_id: '' } },
											},
										},
									},
								},
							},
						],
					})
				);
			});
			vi.stubGlobal('fetch', fetchMock);
			const { getModelCosts } = await import('./litellm');

			const result = await getModelCosts('jev-latest', '2024-05-27', '2024-06-02', 'typesafe/jev-');

			expect(result.error).toBeUndefined();
			expect(result.costs.map((c) => c.model_name).sort()).toEqual(['typesafe/jev-1.13.0', 'typesafe/jev-latest']);
			expect(result.costs.map((c) => c.spend).reduce((a, b) => a + b, 0)).toBe(3);
			const byToken = Object.fromEntries(result.costs.map((c) => [c.key_token, c.team_name]));
			expect(byToken).toEqual({ k2: 'Team Alpha', k3: '' });

			// Without a prefix it's an exact-name lookup, cached separately.
			const exact = await getModelCosts('typesafe/jev-latest', '2024-05-27', '2024-06-02');
			expect(exact.costs.map((c) => c.key_token)).toEqual(['k3']);
		});

		it('returns an error when the proxy responds non-200', async () => {
			const fetchMock = vi.fn((url: string | URL) =>
				Promise.resolve(new URL(url).pathname === '/v2/team/list' ? jsonResponse({ teams: [] }) : jsonResponse({}, { status: 500 }))
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getModelCosts } = await import('./litellm');

			const result = await getModelCosts('jev-latest', '2024-05-27', '2024-06-02', 'typesafe/jev-');

			expect(result).toEqual({ costs: [], error: 'LiteLLM returned 500' });
		});
	});

	describe('getTeams', () => {
		it('maps team_id/team_alias, falling back to team_id when there is no alias', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({
					teams: [
						{ team_id: 'team-a', team_alias: 'Team Alpha' },
						{ team_id: 'team-b', team_alias: null },
					],
				})
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getTeams } = await import('./litellm');

			const result = await getTeams();

			expect(result.error).toBeUndefined();
			expect(result.teams).toEqual([
				{ id: 'team-a', name: 'Team Alpha' },
				{ id: 'team-b', name: 'team-b' },
			]);
			const [url, options] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/v2/team/list?page_size=100');
			expect(options.headers.Authorization).toBe('Bearer test-key');
		});

		it('returns an error when the proxy responds non-200', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
			vi.stubGlobal('fetch', fetchMock);
			const { getTeams } = await import('./litellm');

			const result = await getTeams();

			expect(result).toEqual({ teams: [], error: 'LiteLLM returned 500' });
		});

		it('caches teams across calls within the TTL', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				jsonResponse({ teams: [{ team_id: 'team-a', team_alias: 'Team Alpha' }] })
			);
			vi.stubGlobal('fetch', fetchMock);
			const { getTeams } = await import('./litellm');

			await getTeams();
			await getTeams();

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('litellmFetch', () => {
		it('sends the bearer key and params, and returns the parsed body', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
			vi.stubGlobal('fetch', fetchMock);
			const { litellmFetch } = await import('./litellm');

			const result = await litellmFetch('/thing', { params: { a: 'b' } });

			expect(result).toEqual({ status: 200, body: { ok: 1 } });
			const [url, options] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://litellm.example.com/thing?a=b');
			expect(options.headers.Authorization).toBe('Bearer test-key');
			expect(options.method).toBeUndefined();
		});

		it('POSTs a JSON body', async () => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
			vi.stubGlobal('fetch', fetchMock);
			const { litellmFetch } = await import('./litellm');

			await litellmFetch('/thing', { json: { x: 1 } });

			const [, options] = fetchMock.mock.calls[0];
			expect(options.method).toBe('POST');
			expect(options.headers['Content-Type']).toBe('application/json');
			expect(JSON.parse(options.body)).toEqual({ x: 1 });
		});

		it('reports a non-2xx status, a body that fails expect, a network error and missing config as errors', async () => {
			const { litellmFetch } = await import('./litellm');

			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })));
			expect((await litellmFetch('/t')).error).toBe('LiteLLM returned 500');

			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
			expect((await litellmFetch('/t', { expect: (b) => Boolean(b.data) })).error).toBe(
				'LiteLLM returned an unexpected response'
			);

			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
			expect(await litellmFetch('/t')).toEqual({ status: 0, body: null, error: 'boom' });

			delete process.env.LITELLM_URL;
			expect((await litellmFetch('/t')).error).toBe('LITELLM_URL is not configured');
		});

		it('does not treat a tolerated status as an error', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })));
			const { litellmFetch } = await import('./litellm');

			expect(await litellmFetch('/t', { tolerate: 404 })).toEqual({ status: 404, body: {} });
		});
	});
});
