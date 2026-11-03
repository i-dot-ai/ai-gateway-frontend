/**
 * API endpoint for tracking page feedback in PostHog.
 * 
 * POST /api/feedback
 * Body: { response: 'yes' | 'no', pageUrl: string, pagePath: string }
 */
import type { APIRoute } from 'astro';
import { captureFeedback, flushPosthog } from '../../lib/posthog';
import { logger } from '../../lib/logging';

export const POST: APIRoute = async ({ request, session }) => {
  try {
    const body = await request.json();
    const { response, pageUrl, pagePath } = body;

    // Validate input
    if (!response || !['yes', 'no'].includes(response)) {
      return new Response(JSON.stringify({ error: 'Invalid response value' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get user email from session (set by middleware)
    const userEmail = await session?.get('user-email');
    
    if (userEmail) {
      captureFeedback(userEmail, response, pagePath || pageUrl);
      await flushPosthog();
      logger.info({ 
        email: userEmail, 
        response, 
        pagePath 
      }, 'Page feedback submitted');
    } else {
      // Anonymous feedback - still log it but can't track in PostHog
      logger.info({ 
        response, 
        pagePath 
      }, 'Anonymous page feedback submitted');
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error processing feedback');
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
