import type { APIRoute } from 'astro';
import { logger } from '../../../../lib/logging';
import {
	buildKeyAlias,
	deleteKey,
	ensureUserLimits,
	generateKey,
	getOrCreateUserId,
	getUserKeys,
} from '../../../../lib/litellmKeys';

// Screen 2 of the create-key flow, mirrors slack-app/app.py's
// generate_key_callback. Everything side-effecting happens here, after the
// user has reviewed the draft on keys/generate/confirm.astro.
export const POST: APIRoute = async ({ session, redirect }) => {
	const email = await session?.get('user-email');
	const keyName = await session?.get('pending-key-name');
	if (!email || !keyName) {
		logger.error({ hasEmail: !!email, hasKeyName: !!keyName }, 'Missing required session data for key generation');
		return redirect('/', 303);
	}

	const logContext = { email, keyName };
	const teamId = (await session?.get('pending-key-team-id')) || undefined;
	const teamName = (await session?.get('pending-key-team-name')) || undefined;

	const alias = buildKeyAlias(email, keyName, teamName);

	const { userId, error: userError } = await getOrCreateUserId(email);
	if (userError || !userId) {
		logger.error({ ...logContext, error: userError }, 'Failed to resolve user account');
		session?.set('flash-error', userError ?? 'Could not resolve your llm-gateway account.');
		return redirect('/keys/generate/confirm', 303);
	}

	const { error: limitsError } = await ensureUserLimits(userId);
	if (limitsError) {
		logger.error({ ...logContext, userId, error: limitsError }, 'Failed to ensure user limits');
		session?.set('flash-error', limitsError);
		return redirect('/keys/generate/confirm', 303);
	}

	// Replace, don't reject, matching the Slack app's regenerate behaviour.
	// The user was warned about this on the confirm screen.
	const { keys: existingKeys, error: keysError } = await getUserKeys(userId);
	if (keysError) {
		logger.error({ ...logContext, userId, error: keysError }, 'Failed to get user keys');
		session?.set('flash-error', keysError);
		return redirect('/keys/generate/confirm', 303);
	}
	const existing = existingKeys.find((k) => k.alias === alias);
	const isReplacement = !!existing;
	let replacedKeyDeleted = false;
	if (existing) {
		const deleted = await deleteKey(existing.token);
		replacedKeyDeleted = deleted.ok;
		if (!deleted.ok) {
			logger.error({ ...logContext, userId, alias, error: deleted.error }, 'Failed to delete replaced key; it may still be valid');
		}
	}

	const { key, error: generateError } = await generateKey({ userId, alias, teamId });
	if (generateError || !key) {
		logger.error({ ...logContext, userId, alias, error: generateError }, 'Failed to generate key');
		session?.set('flash-error', generateError ?? 'Failed to generate a key.');
		return redirect('/keys/generate/confirm', 303);
	}

	session?.delete('pending-key-name');
	session?.delete('pending-key-team-id');
	session?.delete('pending-key-team-name');

	session?.set('flash-generated-key', key);
	session?.set('flash-generated-key-replaced', isReplacement && replacedKeyDeleted ? 'true' : '');
	session?.set('flash-generated-key-undeleted', isReplacement && !replacedKeyDeleted ? 'true' : '');
	logger.info({ ...logContext, userId, alias, isReplacement }, 'Successfully generated key');
	return redirect('/keys/generate/show', 303);
};
