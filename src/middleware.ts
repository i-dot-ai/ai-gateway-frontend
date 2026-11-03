import 'dotenv/config';
import { AuthReasons, type UserAuthorisationResult } from '@i-dot-ai-npm/utilities-auth';
import { logger } from './lib/logging';

import { parseAuthToken } from './lib/auth';
import { matchUnmatchedWithLlm, refreshArena } from './lib/arena';
import { getAllModels, startCostsWarmer } from './lib/litellm';
import { refreshStaleModelDetails } from './lib/modelDetails';
import { prefetchExampleAnswers } from './lib/modelSearch';
import { trendPresetsFetchRange } from './lib/trends';
import { todayUtc } from './lib/usage';

// Loaded on the first request (the ALB health check, right after boot), so the
// trends data is cached before anyone opens the page. Skipped in dev.
if (import.meta.env.PROD) {
  startCostsWarmer(() => trendPresetsFetchRange(todayUtc()));
}

interface RedirectContext {
  redirect: (path: string) => Response;
}

interface Session {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): void;
  destroy(): void;
}

interface RequestContext {
  request: Request;
  session: Session;
  redirect: (path: string) => Response;
}

// Define paths that should be public (no authorisation required)
const PUBLIC_PATHS = [
  '/favicon.svg',
  '/fonts/',
  '/unauthorised',
  '/api/health',
  '/generic-error',
  '/sign-out',
];

export async function onRequest(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
  // Start the background model-details refresh once per server process, on its
  // first request rather than at import, so builds and scripts never start it.
  // Idempotent and non-blocking: the request never waits on it.
  const g = globalThis as { __modelDetailsRefresh?: ReturnType<typeof setInterval> };
  if (!g.__modelDetailsRefresh && !process.env.VITEST) {
    if (import.meta.env.PROD || process.env.MODEL_SEARCH_REFRESH) {
      const run = async () => {
        const all = await getAllModels();
        if (all.error === undefined) {
          const [stats, arena] = await Promise.all([refreshStaleModelDetails(all.models), refreshArena()]);
          await matchUnmatchedWithLlm(all.models);
          logger.info({ ...stats, arena_updated: arena.updated }, 'Model details refresh complete');
          await prefetchExampleAnswers();
        }
      };
      g.__modelDetailsRefresh = setInterval(run, 60 * 60 * 1000);
      g.__modelDetailsRefresh.unref?.();
      run().catch((err) => logger.error({ err }, 'Model details refresh failed'));
    }
  }

  const pathname: string = new URL(context.request.url).pathname;
  const method: string = context.request.method;
  const logContext: Record<string, unknown> = { pathname, method };

  // Check if the requested path is public
  if (PUBLIC_PATHS.some((path: string) => pathname.startsWith(path))) {
    // Log public page access without user info
    logger.info(logContext, 'Page accessed (public)');
    return next();
  }

  try {
    let authResult: UserAuthorisationResult | null = null;

    if(process.env.ENVIRONMENT !== 'local') {
      const token = context.request.headers.get('x-amzn-oidc-data');

      if (!token) {
        logger.error(logContext, 'No auth token found in headers');
        return redirectToUnauthorised(context);
      }

      authResult = await parseAuthToken(token);
    } else {
      authResult = {
        email: process.env.LOCAL_USER_EMAIL || "test@i.ai.gov.uk",
        isAuthorised: true,
        // Our stricter auth package types authReason as a real enum, with
        // no "local testing" member, unlike the AuthReason: string looseness
        // of @i-dot-ai-npm/utilities' bundled types. Never actually checked
        // when isAuthorised is true, other than the TOKEN_EXPIRED check
        // below, which this isn't.
        authReason: AuthReasons.JWT_CLAIM_MATCHES_APP
      }
    }

    // Add email to log context when available
    if (authResult?.email) {
      logContext.email = authResult.email;
    }

    if (authResult?.isAuthorised !== true) {
      if (authResult?.authReason === 'TOKEN_EXPIRED') {
        return redirectToSignOut(context);
      }
      logger.error({ ...logContext, authReason: authResult?.authReason }, 'User is not authorised to access path');
      return redirectToUnauthorised(context);
    }

    const { email } = authResult;

    // If the current user doesn't match the user for the session, destroy existing session data - it may be a shared device
    const storedUserEmail: string | undefined = await context.session.get('user-email');
    if (storedUserEmail !== email) {
      context.session.destroy();
      context.session.set('user-email', email);
    }

    // Log successful page access with user info
    logger.info({ ...logContext, isAuthorised: authResult.isAuthorised }, 'Page accessed');

    return next();
  } catch(error: unknown) {
    logger.error({ ...logContext, err: error }, 'Error authorising token');
    return redirectToGenericError(context);
  }
}

function redirectToUnauthorised(context: RedirectContext): Response {
  return context.redirect('/unauthorised');
}

function redirectToSignOut(context: RedirectContext): Response {
  return context.redirect('/sign-out');
}

function redirectToGenericError(context: RedirectContext): Response {
  return context.redirect('/generic-error');
}
