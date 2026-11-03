/**
 * Server-side PostHog tracking for custom events. Page views are tracked
 * client-side by posthog-js to capture referrer and UTM data.
 *
 * distinctId is a salted hash of the email rather than the email itself,
 * so PostHog never sees the raw address but can still correlate a user's
 * journey. email_domain is sent separately for org-level breakdowns.
 */
import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { logger } from './logging';

const apiKey = process.env.POSTHOG_API_KEY;
// Terraform provisions a literal "placeholder" until a real key is set.
const isConfigured = !!apiKey && apiKey !== 'placeholder';  // pragma: allowlist secret
const host = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';
const distinctIdSalt = process.env.POSTHOG_DISTINCT_ID_SALT || 'core-llm-gateway-frontend';

const client = isConfigured ? new PostHog(apiKey as string, { host }) : undefined;

client?.on('error', (error) => {
  logger.warn({ err: error }, 'PostHog client error');
});

function pseudonymise(email: string): string {
  return createHash('sha256').update(`${distinctIdSalt}:${email.toLowerCase()}`).digest('hex').slice(0, 32);
}

function emailDomain(email: string): string | undefined {
  return email.split('@')[1]?.toLowerCase();
}

export function captureFeedback(
  email: string,
  response: 'yes' | 'no',
  pagePath: string,
): void {
  if (!client) {
    return;
  }

  client.capture({
    distinctId: pseudonymise(email),
    event: 'page_feedback',
    properties: {
      response,
      page_path: pagePath,
      email_domain: emailDomain(email),
    },
  });
}

export function captureFeedbackForm(
  email: string,
  response: 'yes' | 'no' | '',
  pagePath: string,
  liked?: string,
  improve?: string,
  contactEmail?: string
): void {
  if (!client) {
    return;
  }

  client.capture({
    distinctId: pseudonymise(email),
    event: 'page_feedback_form',
    properties: {
      response: response || 'not specified',
      page_path: pagePath,
      email_domain: emailDomain(email),
      ...(liked && { liked }),
      ...(improve && { improve }),
      ...(contactEmail && { contact_email: contactEmail }),
    },
  });
}

/**
 * A /models search: what was asked, how it was routed and what came back,
 * so we can see whether the feature is used and whether answers land.
 */
export function captureModelSearch(
  email: string,
  search: { query: string; kind: 'lookup' | 'question'; filters?: string; results: number; suggested?: string[]; error?: string },
): void {
  if (!client) {
    return;
  }

  client.capture({
    distinctId: pseudonymise(email),
    event: 'model_search',
    properties: {
      query: search.query,
      kind: search.kind,
      filters: search.filters || 'none',
      results: search.results,
      ...(search.suggested && { suggested: search.suggested }),
      ...(search.error && { error: search.error }),
      email_domain: emailDomain(email),
    },
  });
}

export async function flushPosthog(): Promise<void> {
  await client?.flush();
}

export async function shutdownPosthog(): Promise<void> {
  await client?.shutdown();
}
