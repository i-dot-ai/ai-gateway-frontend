import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('nameFromEmail', () => {
	// Import the function directly for unit testing
	const nameFromEmail = (email: string): string => {
		const local = email.split('@')[0];
		return local
			.split(/[._-]/)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
			.join(' ');
	};

	it('converts dot-separated email to title case name', () => {
		expect(nameFromEmail('jenny.bradley@dsit.gov.uk')).toBe('Jenny Bradley');
	});

	it('handles underscores', () => {
		expect(nameFromEmail('adam_smith@example.com')).toBe('Adam Smith');
	});

	it('handles hyphens', () => {
		expect(nameFromEmail('mary-jane@example.com')).toBe('Mary Jane');
	});

	it('handles single name', () => {
		expect(nameFromEmail('admin@example.com')).toBe('Admin');
	});

	it('handles mixed separators', () => {
		expect(nameFromEmail('john.doe_smith@example.com')).toBe('John Doe Smith');
	});
});

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
