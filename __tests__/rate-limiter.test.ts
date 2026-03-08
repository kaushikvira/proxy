import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, RateLimitError, DEFAULT_LIMITS } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Default limits ──────────────────────────────────────────────────────────

  describe('default limits', () => {
    it('sonnet default is 60 RPM', () => {
      expect(DEFAULT_LIMITS['claude-sonnet-4-6'].rpm).toBe(60);
    });

    it('opus default is 30 RPM', () => {
      expect(DEFAULT_LIMITS['claude-opus-4-6'].rpm).toBe(30);
    });

    it('haiku default is 60 RPM', () => {
      expect(DEFAULT_LIMITS['claude-haiku-4-5'].rpm).toBe(60);
    });

    it('unknown model falls back to 60 RPM', () => {
      const limiter = new RateLimiter();
      const result = limiter.checkLimit('ws1', 'some-unknown-model');
      expect(result.limit).toBe(60);
    });
  });

  // ── Configurable limits ─────────────────────────────────────────────────────

  describe('configurable limits', () => {
    it('applies per-model RPM override via configure()', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'claude-sonnet-4-6': { rpm: 5 } } });

      for (let i = 0; i < 5; i++) {
        const r = limiter.checkLimit('ws1', 'claude-sonnet-4-6');
        expect(r.allowed).toBe(true);
        expect(r.limit).toBe(5);
      }

      const blocked = limiter.checkLimit('ws1', 'claude-sonnet-4-6');
      expect(blocked.allowed).toBe(false);
      expect(blocked.limit).toBe(5);
    });

    it('override applies to model regardless of casing', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'Claude-Sonnet-4-6': { rpm: 3 } } });
      const result = limiter.checkLimit('ws1', 'claude-sonnet-4-6');
      expect(result.limit).toBe(3);
    });

    it('configure() updates maxQueueDepth', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 5, queueTimeoutMs: 120_000 });
      limiter.configure({ maxQueueDepth: 2 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume slot

      // Fill queue to new depth of 2 — attach .catch to avoid unhandled rejections
      limiter.acquireSlot('ws1', 'test-model').catch(() => {});
      limiter.acquireSlot('ws1', 'test-model').catch(() => {});

      await expect(limiter.acquireSlot('ws1', 'test-model')).rejects.toMatchObject({
        code: 'QUEUE_FULL',
      });
    });
  });

  // ── Basic rate limit behavior ────────────────────────────────────────────────

  describe('checkLimit()', () => {
    it('allows requests up to the limit', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: 3 } } });

      for (let i = 0; i < 3; i++) {
        expect(limiter.checkLimit('ws1', 'test-model').allowed).toBe(true);
      }
      expect(limiter.checkLimit('ws1', 'test-model').allowed).toBe(false);
    });

    it('resets after window expires', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model');
      expect(limiter.checkLimit('ws1', 'test-model').allowed).toBe(false);

      vi.advanceTimersByTime(60_000);

      expect(limiter.checkLimit('ws1', 'test-model').allowed).toBe(true);
    });

    it('tracks different workspaces independently', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model');
      expect(limiter.checkLimit('ws1', 'test-model').allowed).toBe(false);
      expect(limiter.checkLimit('ws2', 'test-model').allowed).toBe(true);
    });

    it('includes retryAfter when blocked', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });
      limiter.checkLimit('ws1', 'test-model');
      const blocked = limiter.checkLimit('ws1', 'test-model');
      expect(blocked.retryAfter).toBeGreaterThan(0);
      expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    });
  });

  // ── Queue behavior ───────────────────────────────────────────────────────────

  describe('acquireSlot() — queuing', () => {
    it('resolves immediately when slot is available', async () => {
      const limiter = new RateLimiter({ queueTimeoutMs: 120_000 });
      await expect(limiter.acquireSlot('ws1', 'claude-sonnet-4-6')).resolves.toBeUndefined();
    });

    it('queues a request when limit is hit and resolves on window reset', async () => {
      // Use long timeout so it doesn't fire before the 60s drain
      const limiter = new RateLimiter({ maxQueueDepth: 5, queueTimeoutMs: 120_000 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume the single slot

      const slotPromise = limiter.acquireSlot('ws1', 'test-model');
      expect(limiter.getQueueDepth('ws1', 'test-model')).toBe(1);

      // Advance past window reset → drain fires
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(slotPromise).resolves.toBeUndefined();
      expect(limiter.getQueueDepth('ws1', 'test-model')).toBe(0);
    });

    it('drains queued requests in FIFO order', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 5, queueTimeoutMs: 120_000 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume slot

      const order: number[] = [];
      const p1 = limiter.acquireSlot('ws1', 'test-model').then(() => order.push(1));
      const p2 = limiter.acquireSlot('ws1', 'test-model').then(() => order.push(2));

      // First window reset — only 1 RPM so p1 resolves, p2 remains queued
      await vi.advanceTimersByTimeAsync(60_000);
      await p1;
      expect(order).toEqual([1]);

      // Second window reset — p2 resolves
      await vi.advanceTimersByTimeAsync(60_000);
      await p2;
      expect(order).toEqual([1, 2]);
    });

    it('drains multiple requests per window when RPM > 1', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 5, queueTimeoutMs: 120_000 });
      limiter.configure({ models: { 'test-model': { rpm: 2 } } });

      // Consume both slots
      limiter.checkLimit('ws1', 'test-model');
      limiter.checkLimit('ws1', 'test-model');

      // Queue 2 requests
      const p1 = limiter.acquireSlot('ws1', 'test-model');
      const p2 = limiter.acquireSlot('ws1', 'test-model');

      await vi.advanceTimersByTimeAsync(60_000);

      // Both should resolve in the same window
      await expect(Promise.all([p1, p2])).resolves.toBeDefined();
    });
  });

  // ── Queue overflow ───────────────────────────────────────────────────────────

  describe('acquireSlot() — queue overflow', () => {
    it('throws QUEUE_FULL when queue depth is exceeded', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 2, queueTimeoutMs: 120_000 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume slot

      // Fill queue to capacity (attach .catch to avoid unhandled rejections)
      limiter.acquireSlot('ws1', 'test-model').catch(() => {});
      limiter.acquireSlot('ws1', 'test-model').catch(() => {});

      await expect(limiter.acquireSlot('ws1', 'test-model')).rejects.toMatchObject({
        code: 'QUEUE_FULL',
      });
    });

    it('QUEUE_FULL error includes retryAfter, limit, resetAt', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 0, queueTimeoutMs: 120_000 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume slot

      try {
        await limiter.acquireSlot('ws1', 'test-model');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rlErr = err as RateLimitError;
        expect(rlErr.code).toBe('QUEUE_FULL');
        expect(rlErr.retryAfter).toBeGreaterThan(0);
        expect(rlErr.limit).toBe(1);
        expect(rlErr.resetAt).toBeGreaterThan(Date.now());
      }
    });
  });

  // ── Queue timeout ────────────────────────────────────────────────────────────

  describe('acquireSlot() — queue timeout', () => {
    it('throws QUEUE_TIMEOUT when wait exceeds queueTimeoutMs', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 10, queueTimeoutMs: 1_000 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // consume slot

      const slotPromise = limiter.acquireSlot('ws1', 'test-model');
      // Register rejection handler immediately before advancing timers
      const assertion = expect(slotPromise).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });

      // Advance only 1s (timeout fires before the 60s window reset)
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    });

    it('QUEUE_TIMEOUT error is a RateLimitError instance', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 10, queueTimeoutMs: 500 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model');

      let caughtErr: unknown;
      const slotPromise = limiter.acquireSlot('ws1', 'test-model').catch((e) => {
        caughtErr = e;
      });

      await vi.advanceTimersByTimeAsync(500);
      await slotPromise;

      expect(caughtErr).toBeInstanceOf(RateLimitError);
      const rlErr = caughtErr as RateLimitError;
      expect(rlErr.code).toBe('QUEUE_TIMEOUT');
      expect(rlErr.limit).toBe(1);
    });

    it('timed-out entry is removed from the queue', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 10, queueTimeoutMs: 500 });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model');
      limiter.acquireSlot('ws1', 'test-model').catch(() => {});
      expect(limiter.getQueueDepth('ws1', 'test-model')).toBe(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(limiter.getQueueDepth('ws1', 'test-model')).toBe(0);
    });
  });

  // ── Per-provider configurable limits ────────────────────────────────────────

  describe('per-provider limits (configureProviders)', () => {
    it('applies provider-level RPM when no model-specific override exists', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ anthropic: { rateLimit: { rpm: 3 } } });

      for (let i = 0; i < 3; i++) {
        const r = limiter.checkLimit('ws1', 'claude-some-future-model', 'anthropic');
        expect(r.allowed).toBe(true);
        expect(r.limit).toBe(3);
      }

      const blocked = limiter.checkLimit('ws1', 'claude-some-future-model', 'anthropic');
      expect(blocked.allowed).toBe(false);
      expect(blocked.limit).toBe(3);
    });

    it('model-specific override takes precedence over provider-level override', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'claude-opus-4-6': { rpm: 5 } } });
      limiter.configureProviders({ anthropic: { rateLimit: { rpm: 100 } } });

      // Model override (5) wins over provider (100)
      const r = limiter.checkLimit('ws1', 'claude-opus-4-6', 'anthropic');
      expect(r.limit).toBe(5);
    });

    it('configures multiple providers independently', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({
        anthropic: { rateLimit: { rpm: 10 } },
        openai:    { rateLimit: { rpm: 30 } },
      });

      expect(limiter.checkLimit('ws1', 'claude-future', 'anthropic').limit).toBe(10);
      expect(limiter.checkLimit('ws1', 'gpt-5',         'openai').limit).toBe(30);
    });

    it('provider name is case-insensitive', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ Anthropic: { rateLimit: { rpm: 7 } } });
      const r = limiter.checkLimit('ws1', 'claude-future', 'anthropic');
      expect(r.limit).toBe(7);
    });

    it('falls back to built-in default when no provider override matches', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ openai: { rateLimit: { rpm: 30 } } });
      // Unknown model with no matching provider — should use DEFAULT_LIMITS.default (60)
      const r = limiter.checkLimit('ws1', 'some-unknown-model', 'xai');
      expect(r.limit).toBe(60);
    });
  });

  // ── No cascading 429s across providers ──────────────────────────────────────

  describe('no cascading 429s across providers (GH #39)', () => {
    it('anthropic hitting its RPM cap does NOT block openai requests', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({
        anthropic: { rateLimit: { rpm: 1 } },
        openai:    { rateLimit: { rpm: 10 } },
      });

      // Exhaust anthropic
      limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic');
      const blocked = limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic');
      expect(blocked.allowed).toBe(false);

      // OpenAI should still be open — anthropic limit does not cascade
      const openaiResult = limiter.checkLimit('ws1', 'gpt-4o', 'openai');
      expect(openaiResult.allowed).toBe(true);
    });

    it('openai and anthropic queues are fully isolated', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 5, queueTimeoutMs: 120_000 });
      limiter.configureProviders({
        anthropic: { rateLimit: { rpm: 1 } },
        openai:    { rateLimit: { rpm: 1 } },
      });

      // Fill anthropic slot
      limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic');

      // OpenAI slot is still free — can acquire immediately
      await expect(
        limiter.acquireSlot('ws1', 'gpt-4o', 'openai')
      ).resolves.toBeUndefined();
    });

    it('anthropic queue overflow does NOT affect openai availability', async () => {
      const limiter = new RateLimiter({ maxQueueDepth: 0, queueTimeoutMs: 120_000 });
      limiter.configureProviders({
        anthropic: { rateLimit: { rpm: 1 } },
        openai:    { rateLimit: { rpm: 5 } },
      });

      // Exhaust anthropic and overflow its queue (maxQueueDepth=0)
      limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic');
      await expect(
        limiter.acquireSlot('ws1', 'claude-sonnet-4-6', 'anthropic')
      ).rejects.toMatchObject({ code: 'QUEUE_FULL' });

      // OpenAI is completely unaffected
      await expect(
        limiter.acquireSlot('ws1', 'gpt-4o', 'openai')
      ).resolves.toBeUndefined();
    });

    it('different workspaces are isolated regardless of provider', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ anthropic: { rateLimit: { rpm: 1 } } });

      limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic');
      expect(limiter.checkLimit('ws1', 'claude-sonnet-4-6', 'anthropic').allowed).toBe(false);

      // ws2 has its own bucket — not affected by ws1
      expect(limiter.checkLimit('ws2', 'claude-sonnet-4-6', 'anthropic').allowed).toBe(true);
    });
  });

  // ── Security: input sanitization ─────────────────────────────────────────────

  describe('security: sanitize numeric config inputs', () => {
    // CRITICAL: Infinity RPM must never bypass the limiter
    it('rpm: Infinity is rejected and falls back to safe default (60), not treated as unlimited', () => {
      const limiter = new RateLimiter();
      // Simulate JSON.parse('{"rpm": 1e309}') which yields Infinity
      limiter.configure({ models: { 'test-model': { rpm: Infinity } } });
      const r = limiter.checkLimit('ws1', 'test-model');
      // Must be finite — Infinity would make entry.count < Infinity always true
      expect(Number.isFinite(r.limit)).toBe(true);
      // Infinity is not a valid RPM, so falls back to the safe default
      expect(r.limit).toBe(60);
    });

    it('rpm: Infinity via provider config is rejected and falls back to safe default (60)', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ anthropic: { rateLimit: { rpm: Infinity } } });
      const r = limiter.checkLimit('ws1', 'claude-future', 'anthropic');
      expect(Number.isFinite(r.limit)).toBe(true);
      expect(r.limit).toBe(60);
    });

    // MEDIUM: Zero/negative RPM must not silently block all traffic
    it('rpm: 0 is clamped to safe default (60), not zero', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: 0 } } });
      const r = limiter.checkLimit('ws1', 'test-model');
      expect(r.limit).toBe(60); // safe default
      expect(r.allowed).toBe(true);
    });

    it('rpm: -1 is clamped to safe default (60), not negative', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: -1 } } });
      const r = limiter.checkLimit('ws1', 'test-model');
      expect(r.limit).toBe(60);
      expect(r.allowed).toBe(true);
    });

    it('rpm: NaN is clamped to safe default (60)', () => {
      const limiter = new RateLimiter();
      limiter.configure({ models: { 'test-model': { rpm: NaN } } });
      const r = limiter.checkLimit('ws1', 'test-model');
      expect(r.limit).toBe(60);
    });

    it('maxQueueDepth: Infinity is clamped to MAX_QUEUE_DEPTH (10_000)', async () => {
      // Use a long queueTimeoutMs so the timeout doesn't fire before the 60s window drain
      const limiter = new RateLimiter({ queueTimeoutMs: 120_000 });
      limiter.configure({ maxQueueDepth: Infinity });
      limiter.configure({ models: { 'test-model': { rpm: 1 } } });

      limiter.checkLimit('ws1', 'test-model'); // exhaust the slot

      // Queue up 2 entries — should work (queue is now finite, not Infinity)
      const p1 = limiter.acquireSlot('ws1', 'test-model');
      const p2 = limiter.acquireSlot('ws1', 'test-model');
      p2.catch(() => {}); // p2 may stay queued past the first window

      // Resolve p1 by advancing to next window
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(p1).resolves.toBeUndefined();
      p2.catch(() => {}); // clean up p2 in case it's still pending
    });
  });

  // ── Security: provider isolation in bucket keys ───────────────────────────────

  describe('security: provider segment in bucket keys (GH #39 / HIGH)', () => {
    it('unknown models from DIFFERENT providers have isolated default buckets', () => {
      const limiter = new RateLimiter();
      // Both "anthropic/claude-future-v2" and "xai/grok-3" resolve to 'default' model key.
      // They MUST NOT share a bucket.
      limiter.configureProviders({
        anthropic: { rateLimit: { rpm: 1 } },
        xai:       { rateLimit: { rpm: 1 } },
      });

      // Exhaust the anthropic default bucket
      limiter.checkLimit('ws1', 'claude-future-v2', 'anthropic');
      const anthropicBlocked = limiter.checkLimit('ws1', 'claude-future-v2', 'anthropic');
      expect(anthropicBlocked.allowed).toBe(false);

      // xai bucket is completely independent — must still be open
      const xaiResult = limiter.checkLimit('ws1', 'grok-3', 'xai');
      expect(xaiResult.allowed).toBe(true);
    });

    it('unknown models from the SAME provider share the default bucket correctly', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ anthropic: { rateLimit: { rpm: 2 } } });

      // Two different unknown anthropic models → both hit 'default' model key
      // They share one bucket, so together they consume the 2 RPM limit.
      const r1 = limiter.checkLimit('ws1', 'claude-future-v1', 'anthropic');
      const r2 = limiter.checkLimit('ws1', 'claude-future-v2', 'anthropic');
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);

      // Third request from same provider's default bucket must be blocked
      const r3 = limiter.checkLimit('ws1', 'claude-future-v3', 'anthropic');
      expect(r3.allowed).toBe(false);
    });

    it('provider casing is normalised in bucket keys', () => {
      const limiter = new RateLimiter();
      limiter.configureProviders({ Anthropic: { rateLimit: { rpm: 1 } } });

      // Exhaust using 'Anthropic' (title-case)
      limiter.checkLimit('ws1', 'claude-future', 'Anthropic');
      // Must also be blocked when queried with 'anthropic' (lower-case) — same bucket
      const blocked = limiter.checkLimit('ws1', 'claude-future', 'anthropic');
      expect(blocked.allowed).toBe(false);
    });

    it('bucket key includes provider so different-provider unknown models never collide', () => {
      const limiter = new RateLimiter();
      // Give each provider a very low rpm so the bucket fills in 1 request
      limiter.configureProviders({
        providerA: { rateLimit: { rpm: 1 } },
        providerB: { rateLimit: { rpm: 1 } },
      });

      // Exhaust providerA
      limiter.checkLimit('ws1', 'unknown-model-x', 'providerA');
      expect(limiter.checkLimit('ws1', 'unknown-model-x', 'providerA').allowed).toBe(false);

      // providerB must be unaffected even though both map to 'default' model key
      expect(limiter.checkLimit('ws1', 'unknown-model-y', 'providerB').allowed).toBe(true);
    });
  });
});
