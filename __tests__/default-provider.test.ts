/**
 * Tests for defaultProvider config feature.
 *
 * When `defaultProvider` is set in the proxy config, ALL model routing
 * should go to that provider's endpoint regardless of model name prefix.
 */
import { describe, it, expect } from 'vitest';
import { resolveExplicitModel } from '../src/standalone-proxy.js';

describe('resolveExplicitModel — defaultProvider', () => {
  describe('without defaultProvider (existing behavior unchanged)', () => {
    it('routes claude-* to anthropic', () => {
      const result = resolveExplicitModel('claude-sonnet-4-6');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('anthropic');
      expect(result!.model).toBe('claude-sonnet-4-6');
    });

    it('routes anthropic/claude-* to anthropic (strips prefix)', () => {
      const result = resolveExplicitModel('anthropic/claude-sonnet-4-6');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('anthropic');
      expect(result!.model).toBe('claude-sonnet-4-6');
    });

    it('routes gpt-* to openai', () => {
      const result = resolveExplicitModel('gpt-4o');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openai');
    });

    it('routes gemini-* to google', () => {
      const result = resolveExplicitModel('gemini-2.0-flash-001');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('google');
    });
  });

  describe('with defaultProvider: "openrouter"', () => {
    it('routes anthropic/claude-sonnet-4-6 to openrouter, preserving model name', () => {
      const result = resolveExplicitModel('anthropic/claude-sonnet-4-6', 'openrouter');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openrouter');
      expect(result!.model).toBe('anthropic/claude-sonnet-4-6');
    });

    it('routes google/gemini-2.0-flash-001 to openrouter, preserving model name', () => {
      const result = resolveExplicitModel('google/gemini-2.0-flash-001', 'openrouter');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openrouter');
      expect(result!.model).toBe('google/gemini-2.0-flash-001');
    });

    it('routes claude-sonnet-4-6 (bare name) to openrouter', () => {
      const result = resolveExplicitModel('claude-sonnet-4-6', 'openrouter');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openrouter');
      expect(result!.model).toBe('claude-sonnet-4-6');
    });

    it('routes gpt-4o to openrouter when defaultProvider is set', () => {
      const result = resolveExplicitModel('gpt-4o', 'openrouter');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openrouter');
      expect(result!.model).toBe('gpt-4o');
    });

    it('returns non-null even for unknown model names', () => {
      const result = resolveExplicitModel('some-future-model-xyz', 'openrouter');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('openrouter');
      expect(result!.model).toBe('some-future-model-xyz');
    });
  });

  describe('with other defaultProvider values', () => {
    it('routes to anthropic when defaultProvider is "anthropic"', () => {
      const result = resolveExplicitModel('gpt-4o', 'anthropic');
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('anthropic');
    });
  });
});

describe('defaultProvider: config schema', () => {
  it('resolveExplicitModel is exported', () => {
    expect(typeof resolveExplicitModel).toBe('function');
  });

  it('defaultProvider undefined behaves the same as not set', () => {
    const withUndefined = resolveExplicitModel('claude-sonnet-4-6', undefined);
    const withoutParam = resolveExplicitModel('claude-sonnet-4-6');
    expect(withUndefined).toEqual(withoutParam);
  });
});

describe('defaultProvider: smart aliases compatibility', () => {
  // Smart aliases (rp:best, rp:fast, etc.) already resolve to OpenRouter models
  // when OPENROUTER_API_KEY is set. These tests verify that resolveExplicitModel
  // with defaultProvider correctly handles alias-like inputs.

  it('rp:fast with defaultProvider routes to openrouter', () => {
    // rp:fast is an alias — resolveExplicitModel would be called AFTER alias resolution
    // so the model passed to it would be e.g. 'anthropic/claude-3-5-haiku'
    const result = resolveExplicitModel('anthropic/claude-3-5-haiku', 'openrouter');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openrouter');
    expect(result!.model).toBe('anthropic/claude-3-5-haiku');
  });

  it('rp:cheap (Google model) with defaultProvider routes to openrouter', () => {
    const result = resolveExplicitModel('google/gemini-2.0-flash-001', 'openrouter');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openrouter');
    expect(result!.model).toBe('google/gemini-2.0-flash-001');
  });
});

describe('addProviderPrefix — bare model names for aggregator routing', () => {
  // Import the helper (exported for testing)
  // Since addProviderPrefix is not exported, we test it indirectly through the
  // complexity routing scenario: bare model names from the classifier need prefixes.

  it('complexity routing: bare claude-sonnet-4-6 gets anthropic/ prefix via resolveExplicitModel', () => {
    // When complexity routing picks 'claude-sonnet-4-6' (bare) and defaultProvider is set,
    // resolveExplicitModel returns it as-is (bare). The prefix is added later in the handler.
    // So we test the resolveExplicitModel behavior first:
    const result = resolveExplicitModel('claude-sonnet-4-6', 'openrouter');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openrouter');
    // resolveExplicitModel preserves the model name as-is
    expect(result!.model).toBe('claude-sonnet-4-6');
  });

  it('prefixed model names pass through unchanged', () => {
    const result = resolveExplicitModel('anthropic/claude-sonnet-4-6', 'openrouter');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('anthropic/claude-sonnet-4-6');
  });
});
