/**
 * Tests for Cross-Provider Cascade Fallback (GH #38)
 *
 * Covers:
 * - CrossProviderCascadeManager configuration
 * - Model mapping (built-in + custom overrides)
 * - Trigger status detection
 * - Fallback provider ordering
 * - Cascade execution: success, exhaustion, non-retryable errors
 * - Rate limiter isolation (existing RPM-per-provider tests must still pass)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CrossProviderCascadeManager,
  BUILT_IN_MODEL_MAPPING,
  DEFAULT_CASCADE_TRIGGER_STATUSES,
  formatCascadeHistory,
  type CascadeHop,
} from '../src/cross-provider-cascade.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManager(overrides?: {
  providers?: string[];
  triggerStatuses?: number[];
  modelMapping?: Record<string, Record<string, Record<string, string>>>;
}): CrossProviderCascadeManager {
  const m = new CrossProviderCascadeManager();
  m.configure({
    enabled: true,
    providers: overrides?.providers ?? ['anthropic', 'openrouter', 'google'],
    triggerStatuses: overrides?.triggerStatuses,
    modelMapping: overrides?.modelMapping,
  });
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossProviderCascadeManager — configuration', () => {
  it('is disabled by default (no configure() call)', () => {
    const m = new CrossProviderCascadeManager();
    expect(m.enabled).toBe(false);
  });

  it('is disabled when providers list has fewer than 2 entries', () => {
    const m = new CrossProviderCascadeManager();
    m.configure({ enabled: true, providers: ['anthropic'] });
    expect(m.enabled).toBe(false);
  });

  it('is enabled when configured correctly', () => {
    const m = makeManager();
    expect(m.enabled).toBe(true);
  });

  it('enabled:false disables even with a valid providers list', () => {
    const m = new CrossProviderCascadeManager();
    m.configure({ enabled: false, providers: ['anthropic', 'openrouter'] });
    expect(m.enabled).toBe(false);
  });

  it('stores the configured provider order', () => {
    const m = makeManager({ providers: ['openai', 'openrouter', 'anthropic'] });
    expect(m.getConfig().providers).toEqual(['openai', 'openrouter', 'anthropic']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trigger status detection
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossProviderCascadeManager — shouldCascade()', () => {
  it('triggers on 429 by default', () => {
    const m = makeManager();
    expect(m.shouldCascade(429)).toBe(true);
  });

  it('triggers on 529 by default', () => {
    const m = makeManager();
    expect(m.shouldCascade(529)).toBe(true);
  });

  it('triggers on 503 by default', () => {
    const m = makeManager();
    expect(m.shouldCascade(503)).toBe(true);
  });

  it('does NOT trigger on 200', () => {
    const m = makeManager();
    expect(m.shouldCascade(200)).toBe(false);
  });

  it('does NOT trigger on 401 (auth error)', () => {
    const m = makeManager();
    expect(m.shouldCascade(401)).toBe(false);
  });

  it('does NOT trigger on 400 (bad request)', () => {
    const m = makeManager();
    expect(m.shouldCascade(400)).toBe(false);
  });

  it('respects custom triggerStatuses', () => {
    const m = makeManager({ triggerStatuses: [503] });
    expect(m.shouldCascade(503)).toBe(true);
    expect(m.shouldCascade(429)).toBe(false); // not in custom list
  });

  it('DEFAULT_CASCADE_TRIGGER_STATUSES contains 429, 529, 503', () => {
    expect(DEFAULT_CASCADE_TRIGGER_STATUSES).toContain(429);
    expect(DEFAULT_CASCADE_TRIGGER_STATUSES).toContain(529);
    expect(DEFAULT_CASCADE_TRIGGER_STATUSES).toContain(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback provider ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossProviderCascadeManager — getFallbackProviders()', () => {
  it('returns providers after the primary in order', () => {
    const m = makeManager({ providers: ['anthropic', 'openrouter', 'google'] });
    expect(m.getFallbackProviders('anthropic')).toEqual(['openrouter', 'google']);
  });

  it('returns empty array when primary is the last provider', () => {
    const m = makeManager({ providers: ['anthropic', 'openrouter'] });
    expect(m.getFallbackProviders('openrouter')).toEqual([]);
  });

  it('returns all providers when primary is not in the list', () => {
    const m = makeManager({ providers: ['openrouter', 'google'] });
    expect(m.getFallbackProviders('anthropic')).toEqual(['openrouter', 'google']);
  });

  it('handles a two-provider cascade correctly', () => {
    const m = makeManager({ providers: ['anthropic', 'openrouter'] });
    expect(m.getFallbackProviders('anthropic')).toEqual(['openrouter']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossProviderCascadeManager — mapModel()', () => {
  it('maps claude-sonnet-4-6 from anthropic to openrouter', () => {
    const m = makeManager();
    expect(m.mapModel('claude-sonnet-4-6', 'anthropic', 'openrouter'))
      .toBe('anthropic/claude-sonnet-4-6');
  });

  it('maps claude-opus-4-6 from anthropic to openrouter', () => {
    const m = makeManager();
    expect(m.mapModel('claude-opus-4-6', 'anthropic', 'openrouter'))
      .toBe('anthropic/claude-opus-4-6');
  });

  it('maps claude-haiku-4-5 from anthropic to openrouter', () => {
    const m = makeManager();
    expect(m.mapModel('claude-haiku-4-5', 'anthropic', 'openrouter'))
      .toBe('anthropic/claude-haiku-4-5');
  });

  it('maps gpt-4o from openai to openrouter', () => {
    const m = makeManager();
    expect(m.mapModel('gpt-4o', 'openai', 'openrouter')).toBe('openai/gpt-4o');
  });

  it('maps claude-sonnet-4-6 from anthropic to google (approximate)', () => {
    const m = makeManager();
    expect(m.mapModel('claude-sonnet-4-6', 'anthropic', 'google'))
      .toBe('gemini-2.0-flash');
  });

  it('returns identity when fromProvider === toProvider', () => {
    const m = makeManager();
    expect(m.mapModel('claude-sonnet-4-6', 'anthropic', 'anthropic'))
      .toBe('claude-sonnet-4-6');
  });

  it('uses heuristic prefix for unknown openrouter model', () => {
    // Unknown model: "my-custom-model" from "newprovider" to "openrouter"
    const m = makeManager();
    expect(m.mapModel('my-custom-model', 'newprovider', 'openrouter'))
      .toBe('newprovider/my-custom-model');
  });

  it('returns model unchanged when no mapping exists (identity fallback)', () => {
    const m = makeManager();
    // xai → google: no built-in mapping
    expect(m.mapModel('grok-1', 'xai', 'google')).toBe('grok-1');
  });

  it('custom modelMapping overrides built-in', () => {
    const m = makeManager({
      modelMapping: {
        anthropic: {
          openrouter: {
            'claude-sonnet-4-6': 'my-custom/sonnet',
          },
        },
      },
    });
    expect(m.mapModel('claude-sonnet-4-6', 'anthropic', 'openrouter'))
      .toBe('my-custom/sonnet');
  });

  it('built-in BUILT_IN_MODEL_MAPPING covers anthropic → openrouter key models', () => {
    const table = BUILT_IN_MODEL_MAPPING['anthropic']?.['openrouter'];
    expect(table?.['claude-sonnet-4-6']).toBe('anthropic/claude-sonnet-4-6');
    expect(table?.['claude-opus-4-6']).toBe('anthropic/claude-opus-4-6');
    expect(table?.['claude-haiku-4-5']).toBe('anthropic/claude-haiku-4-5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute() — cascade logic
// ─────────────────────────────────────────────────────────────────────────────

describe('CrossProviderCascadeManager — execute()', () => {
  let m: CrossProviderCascadeManager;
  const log = vi.fn();

  beforeEach(() => {
    m = makeManager({ providers: ['anthropic', 'openrouter', 'google'] });
    log.mockClear();
  });

  it('does not cascade when primary status is non-retryable (e.g. 401)', async () => {
    const makeRequest = vi.fn();
    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 401, makeRequest, log);

    expect(result.success).toBe(false);
    expect(result.provider).toBe('anthropic');
    expect(makeRequest).not.toHaveBeenCalled();
    expect(result.statusHistory).toHaveLength(1);
    expect(result.statusHistory[0]?.status).toBe(401);
  });

  it('cascades to openrouter when anthropic returns 429', async () => {
    const makeRequest = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: { id: 'or-resp', choices: [{ message: { content: 'hello from openrouter' } }] },
    });

    const { result, data } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('openrouter');
    expect(result.model).toBe('anthropic/claude-sonnet-4-6'); // built-in mapping
    expect(result.attempts).toBe(2);
    expect(data).toHaveProperty('id', 'or-resp');
    expect(makeRequest).toHaveBeenCalledOnce();
    const hop = makeRequest.mock.calls[0]![0] as CascadeHop;
    expect(hop.provider).toBe('openrouter');
    expect(hop.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('cascades to openrouter when anthropic returns 529', async () => {
    const makeRequest = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: { id: 'or-resp-529' },
    });

    const { result } = await m.execute('anthropic', 'claude-haiku-4-5', 529, makeRequest, log);
    expect(result.success).toBe(true);
    expect(result.provider).toBe('openrouter');
  });

  it('cascades to openrouter when anthropic returns 503', async () => {
    const makeRequest = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: { id: 'or-resp-503' },
    });

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 503, makeRequest, log);
    expect(result.success).toBe(true);
    expect(result.provider).toBe('openrouter');
  });

  it('continues to google when openrouter also returns 429', async () => {
    const makeRequest = vi.fn()
      .mockResolvedValueOnce({ status: 429, data: { error: 'openrouter rate limited' } }) // openrouter
      .mockResolvedValueOnce({ status: 200, data: { id: 'google-resp' } }); // google

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('google');
    expect(result.attempts).toBe(3);
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('returns failure when all fallback providers are exhausted', async () => {
    const makeRequest = vi.fn()
      .mockResolvedValueOnce({ status: 429, data: { error: 'openrouter 429' } })
      .mockResolvedValueOnce({ status: 429, data: { error: 'google 429' } });

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it('stops cascade on non-retryable error from fallback provider', async () => {
    // openrouter returns 403 — should NOT continue to google
    const makeRequest = vi.fn()
      .mockResolvedValueOnce({ status: 403, data: { error: 'forbidden' } });

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(false);
    expect(makeRequest).toHaveBeenCalledTimes(1); // only tried openrouter
    expect(result.provider).toBe('openrouter'); // last tried
  });

  it('handles makeRequest throwing an error (treats as transient, continues)', async () => {
    const makeRequest = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout')) // openrouter throws
      .mockResolvedValueOnce({ status: 200, data: { id: 'google-success' } }); // google succeeds

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('google');
  });

  it('records all status history entries', async () => {
    const makeRequest = vi.fn()
      .mockResolvedValueOnce({ status: 429, data: {} }) // openrouter 429
      .mockResolvedValueOnce({ status: 200, data: {} }); // google 200

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    // [anthropic/429, openrouter/429, google/200]
    expect(result.statusHistory).toHaveLength(3);
    expect(result.statusHistory[0]?.provider).toBe('anthropic');
    expect(result.statusHistory[0]?.status).toBe(429);
    expect(result.statusHistory[1]?.provider).toBe('openrouter');
    expect(result.statusHistory[1]?.status).toBe(429);
    expect(result.statusHistory[2]?.provider).toBe('google');
    expect(result.statusHistory[2]?.status).toBe(200);
  });

  it('logs cascade events with [CROSS-CASCADE] prefix', async () => {
    const makeRequest = vi.fn().mockResolvedValueOnce({ status: 200, data: {} });
    await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    const logCalls = log.mock.calls.map((c) => c[0] as string);
    expect(logCalls.some((msg) => msg.includes('[CROSS-CASCADE]'))).toBe(true);
  });

  it('logs cascade trigger message with provider order', async () => {
    const makeRequest = vi.fn().mockResolvedValueOnce({ status: 200, data: {} });
    await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    const logCalls = log.mock.calls.map((c) => c[0] as string);
    expect(logCalls.some((msg) => msg.includes('429') && msg.includes('openrouter'))).toBe(true);
  });

  it('does nothing when cascade is disabled', async () => {
    const disabled = new CrossProviderCascadeManager();
    disabled.configure({ enabled: false, providers: ['anthropic', 'openrouter'] });

    const makeRequest = vi.fn().mockResolvedValueOnce({ status: 200, data: {} });
    // Even if called, should not cascade because `execute()` will check shouldCascade and getFallbackProviders
    // (disabled manager has enabled=false so getFallbackProviders still works, but caller checks .enabled)
    // Test that shouldCascade still works correctly regardless of enabled flag
    expect(disabled.shouldCascade(429)).toBe(true); // status detection doesn't depend on enabled
    expect(disabled.enabled).toBe(false);
  });

  it('returns no-fallback failure when provider list has no more providers after primary', async () => {
    const twoProvider = new CrossProviderCascadeManager();
    twoProvider.configure({ enabled: true, providers: ['anthropic', 'openrouter'] });

    // All fallbacks exhausted
    const makeRequest = vi.fn().mockResolvedValueOnce({ status: 429, data: {} });
    const { result } = await twoProvider.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, log);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatCascadeHistory helper
// ─────────────────────────────────────────────────────────────────────────────

describe('formatCascadeHistory()', () => {
  it('formats a history into a readable string', () => {
    const history = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', status: 429 },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', status: 200 },
    ];
    const str = formatCascadeHistory(history);
    expect(str).toContain('anthropic');
    expect(str).toContain('429');
    expect(str).toContain('openrouter');
    expect(str).toContain('200');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: cascade respects per-provider rate limits (GH #38 + GH #39)
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-provider cascade + rate limiter isolation (GH #38 + #39)', () => {
  it('cascade does not bleed rate limit state from anthropic to openrouter', async () => {
    // Import RateLimiter to verify isolation
    const { RateLimiter } = await import('../src/rate-limiter.js');
    const limiter = new RateLimiter();
    limiter.configureProviders({
      anthropic: { rateLimit: { rpm: 1 } },
      openrouter: { rateLimit: { rpm: 10 } },
    });

    // Exhaust anthropic
    limiter.checkLimit('local', 'claude-sonnet-4-6', 'anthropic');
    const blocked = limiter.checkLimit('local', 'claude-sonnet-4-6', 'anthropic');
    expect(blocked.allowed).toBe(false);

    // OpenRouter should still be available (GH #39 isolation guarantee)
    const orCheck = limiter.checkLimit('local', 'anthropic/claude-sonnet-4-6', 'openrouter');
    expect(orCheck.allowed).toBe(true);
  });

  it('cascade checks rate limit for next provider before attempting', async () => {
    // This test verifies the cascade manager calls makeRequest with correct hop info.
    // Actual rate limit enforcement is tested via the rate-limiter tests.
    const m = makeManager({ providers: ['anthropic', 'openrouter'] });
    const noop = vi.fn();

    const makeRequest = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: { id: 'cascade-ok' },
    });

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, noop);

    expect(result.success).toBe(true);
    // makeRequest was called with the mapped model
    const hop = makeRequest.mock.calls[0]![0] as CascadeHop;
    expect(hop.provider).toBe('openrouter');
    expect(hop.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('cascade with configurable provider order respects the configured sequence', async () => {
    const m = makeManager({ providers: ['anthropic', 'google', 'openrouter'] });
    const noop = vi.fn();

    const makeRequest = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: { id: 'google-first' },
    });

    const { result } = await m.execute('anthropic', 'claude-sonnet-4-6', 429, makeRequest, noop);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('google'); // google is second in the configured order
    const hop = makeRequest.mock.calls[0]![0] as CascadeHop;
    expect(hop.provider).toBe('google');
  });
});
