import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

// posthog-node has no vi.mock precedent in this repo, but stubbing global
// fetch would couple the tests to the client's gzipped batch wire format.
// Mocking the class lets us assert directly on the capture() payloads our
// code builds, which is the behaviour worth protecting.
const { captureMock, shutdownMock, PostHogMock } = vi.hoisted(() => {
	const captureMock = vi.fn();
	const shutdownMock = vi.fn().mockResolvedValue(undefined);
	const PostHogMock = vi.fn(function () {
		return {
			capture: captureMock,
			on: vi.fn(),
			shutdown: shutdownMock,
		};
	});
	return { captureMock, shutdownMock, PostHogMock };
});

vi.mock('posthog-node', () => ({ PostHog: PostHogMock }));

const SALT = 'test-salt';

function expectedDistinctId(email: string): string {
	return createHash('sha256').update(`${SALT}:${email.toLowerCase()}`).digest('hex').slice(0, 32);
}

describe('posthog', () => {
	beforeEach(() => {
		process.env.POSTHOG_API_KEY = 'phc_test'; // pragma: allowlist secret
		process.env.POSTHOG_HOST = 'https://posthog.example.com';
		process.env.POSTHOG_DISTINCT_ID_SALT = SALT;
		vi.resetModules();
		captureMock.mockClear();
		shutdownMock.mockClear();
		PostHogMock.mockClear();
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	describe('when configured', () => {
		it('captures page_feedback with a pseudonymised id and email domain', async () => {
			const { captureFeedback } = await import('./posthog');

			captureFeedback('Alice@Example.com', 'yes', '/usage');

			expect(captureMock).toHaveBeenCalledTimes(1);
			const payload = captureMock.mock.calls[0][0];
			expect(payload).toEqual({
				distinctId: expectedDistinctId('Alice@Example.com'),
				event: 'page_feedback',
				properties: {
					response: 'yes',
					page_path: '/usage',
					email_domain: 'example.com',
				},
			});
			// The raw email must never be sent as the distinct id.
			expect(payload.distinctId).not.toContain('Alice');
			expect(payload.distinctId).toMatch(/^[a-f0-9]{32}$/);
		});

		it('captures page_feedback_form with optional free-text fields when provided', async () => {
			const { captureFeedbackForm } = await import('./posthog');

			captureFeedbackForm('bob@example.com', 'no', '/keys', 'the speed', 'more docs', 'bob@follow.up');

			expect(captureMock).toHaveBeenCalledTimes(1);
			expect(captureMock.mock.calls[0][0]).toEqual({
				distinctId: expectedDistinctId('bob@example.com'),
				event: 'page_feedback_form',
				properties: {
					response: 'no',
					page_path: '/keys',
					email_domain: 'example.com',
					liked: 'the speed',
					improve: 'more docs',
					contact_email: 'bob@follow.up',
				},
			});
		});

		it('omits optional fields and reports "not specified" when the form has no response', async () => {
			const { captureFeedbackForm } = await import('./posthog');

			captureFeedbackForm('bob@example.com', '', '/keys');

			const properties = captureMock.mock.calls[0][0].properties;
			expect(properties.response).toBe('not specified');
			expect(properties).not.toHaveProperty('liked');
			expect(properties).not.toHaveProperty('improve');
			expect(properties).not.toHaveProperty('contact_email');
		});
	});

	describe('when not configured', () => {
		it('is a no-op when no API key is set', async () => {
			delete process.env.POSTHOG_API_KEY;
			const { captureFeedback } = await import('./posthog');

			captureFeedback('bob@example.com', 'yes', '/usage');

			expect(PostHogMock).not.toHaveBeenCalled();
			expect(captureMock).not.toHaveBeenCalled();
		});

		it('treats the terraform "placeholder" key as unconfigured', async () => {
			process.env.POSTHOG_API_KEY = 'placeholder'; // pragma: allowlist secret
			const { captureFeedbackForm } = await import('./posthog');

			captureFeedbackForm('bob@example.com', 'no', '/keys');

			expect(PostHogMock).not.toHaveBeenCalled();
			expect(captureMock).not.toHaveBeenCalled();
		});
	});
});
