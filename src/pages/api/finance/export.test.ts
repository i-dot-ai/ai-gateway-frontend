import { describe, it, expect } from 'vitest';
import { deriveProvider } from './export';

describe('deriveProvider', () => {
	it('identifies Anthropic models', () => {
		expect(deriveProvider('claude-sonnet-4-20250514')).toBe('Anthropic');
		expect(deriveProvider('anthropic-claude-opus')).toBe('Anthropic');
	});

	it('identifies OpenAI models', () => {
		expect(deriveProvider('gpt-4o')).toBe('OpenAI');
		expect(deriveProvider('openai-gpt-4')).toBe('OpenAI');
	});

	it('identifies Google models', () => {
		expect(deriveProvider('gemini-pro')).toBe('Google');
	});

	it('identifies Bedrock-hosted models by prefix', () => {
		expect(deriveProvider('bedrock-claude-haiku')).toBe('AWS Bedrock');
		expect(deriveProvider('bedrock/anthropic.claude-v2')).toBe('AWS Bedrock');
	});

	it('returns Other for unknown models', () => {
		expect(deriveProvider('some-random-model')).toBe('Other');
	});
});
