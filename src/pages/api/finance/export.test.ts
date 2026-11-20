import { describe, it, expect } from 'vitest';

describe('deriveProvider', () => {
	const deriveProvider = (modelName: string): string => {
		const lower = modelName.toLowerCase();
		// Platform prefixes first - these indicate where the model is hosted
		if (lower.startsWith('bedrock') || lower.includes('/bedrock')) return 'AWS Bedrock';
		if (lower.startsWith('vertex') || lower.includes('/vertex')) return 'Google Cloud';
		// Then model family names
		if (lower.includes('claude') || lower.includes('anthropic')) return 'Anthropic';
		if (lower.includes('gpt') || lower.includes('openai')) return 'OpenAI';
		if (lower.includes('gemini') || lower.includes('google')) return 'Google';
		if (lower.includes('mistral')) return 'Mistral';
		if (lower.includes('llama')) return 'Meta';
		return 'Other';
	};

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
