import type { AstroSession } from 'astro';

/** Reads a one-shot session value and clears it, so it shows once. Undefined when unset or empty. */
export async function readAndClearFlash(session: AstroSession | undefined, key: string): Promise<string | undefined> {
	const value = await session?.get(key);
	if (value !== undefined) session?.delete(key);
	return value || undefined;
}
