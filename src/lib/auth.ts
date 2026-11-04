import 'dotenv/config';
import { AuthApiClient, createAuthUtils, type UserAuthorisationResult } from '@i-dot-ai-npm/utilities-auth';
import { logger } from './logging';

// Validate required environment variables
if (!process.env.AUTH_API_URL) {
  throw new Error('AUTH_API_URL is not defined in the environment variables.');
}

// Initialize AuthApiClient
const authClient = new AuthApiClient({
  appName: process.env.REPO || "unknown",
  authApiUrl: process.env.AUTH_API_URL,
  logger: logger,
  timeout: 5000,
});

// Create auth utilities
const { getUserInfo } = createAuthUtils(authClient, logger);

export async function parseAuthToken(token: string): Promise<UserAuthorisationResult | null> {
  if (!token) {
    logger.error('No auth token provided to parse');
    return null;
  }

  try {
    const userInfo = await getUserInfo(token);

    if (!userInfo) {
      logger.error('Failed to get user info from token');
      return null;
    }

    if (!userInfo.email) {
      logger.error('No email found in user info');
      return null;
    }

    return {
      email: userInfo.email,
      isAuthorised: userInfo.isAuthorised,
      authReason: userInfo.authReason,
    };
  } catch (error) {
    logger.error({ err: error, token: token.substring(0, 20) + '...' }, 'Error parsing auth token');
    return null;
  }
}
