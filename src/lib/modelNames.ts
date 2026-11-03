/**
 * The config.yml alias convention in one place: an optional gateway prefix,
 * the model, then a hosting suffix, e.g. "bedrock-claude-opus-5-5-eu".
 */

const GATEWAY_PREFIX = /^(bedrock|doubleword|locai|vertex|azure)-/;
// Also covers odd forms like gpt-5.2-uk+sweden and gpt-4.1-sweden-2025-03.
const HOSTING_SUFFIX = /-(uk|eu|sweden|global|us|us-east|us-east2)([+-].*)?$/;

/** "gpt-5.4-sweden" -> "gpt-5.4". */
export function withoutHosting(name: string): string {
	return name.replace(HOSTING_SUFFIX, '');
}

/** "bedrock-claude-opus-5-5-eu" -> "claude-opus-5-5", for matching against other naming schemes. */
export function modelBase(name: string): string {
	return withoutHosting(name.toLowerCase()).replace(GATEWAY_PREFIX, '').replace(/[._]+/g, '-');
}
