/**
 * Returns a safe, same-site relative path for use in links and redirects.
 *
 * Only accepts values that begin with a single "/" (an absolute path on this
 * site). This rejects absolute URLs (e.g. "http://evil.com"), protocol-relative
 * URLs (e.g. "//evil.com") and other schemes (e.g. "javascript:...") that could
 * be used for open-redirect or XSS attacks. Anything else falls back to "/".
 */
export function safePath(value: string | null | undefined): string {
	return value && /^\/(?!\/)/.test(value) ? value : "/";
}
