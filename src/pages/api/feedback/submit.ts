/**
 * API endpoint for submitting detailed page feedback.
 * 
 * POST /api/feedback/submit
 * Processes form submission from /feedback page
 */
import type { APIRoute } from 'astro';
import { captureFeedbackForm, flushPosthog } from '../../../lib/posthog';
import { logger } from '../../../lib/logging';
import { safePath } from '../../../lib/safePath';

export const POST: APIRoute = async ({ request, session, redirect }) => {
  try {
    const formData = await request.formData();
    const response = formData.get('response') as string;
    const pageUrl = formData.get('pageUrl') as string;
    const liked = formData.get('liked') as string;
    const improve = formData.get('improve') as string;
    const contactEmail = formData.get('contactEmail') as string;

    // Get user email from session
    const userEmail = await session?.get('user-email');
    const pagePath = safePath(pageUrl);

    // Track in PostHog
    if (userEmail) {
      captureFeedbackForm(userEmail, response as 'yes' | 'no' | '', pagePath, liked, improve, contactEmail);
      await flushPosthog();
    }

    // Log the feedback
    logger.info({ 
      email: userEmail || 'anonymous',
      response: response || 'not specified', 
      pagePath,
      hasLiked: !!liked,
      hasImprove: !!improve,
      hasContactEmail: !!contactEmail,
    }, 'Detailed feedback submitted');

    // Set success flash and redirect back to feedback page to show confirmation
    session?.set('feedback-success', 'true');
    const redirectUrl = pagePath === '/' ? '/feedback' : `/feedback?url=${encodeURIComponent(pagePath)}`;
    return redirect(redirectUrl, 303);
  } catch (error) {
    logger.error({ err: error }, 'Error processing feedback submission');
    session?.set('feedback-error', 'Something went wrong. Please try again.');
    return redirect('/feedback', 303);
  }
};
