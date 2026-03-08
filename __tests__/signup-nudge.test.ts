/**
 * Tests for the signup nudge feature
 *
 * Covers:
 *  1. nudge fires at exactly 100 requests
 *  2. nudge does NOT fire before 100 requests
 *  3. nudge does NOT fire twice (idempotent)
 *  4. no latency impact (synchronous, fast)
 *  5. initNudge() reads the flag from disk and short-circuits
 *  6. nudge goes to stderr, not stdout
 *  7. nudge message format (contains count + URL)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── temp dir per test ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-nudge-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── mock config.ts so getConfigDir() points to our tmpDir ─────────────────────

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    // getConfigDir is overridden per-test via the helper below
    getConfigDir: () => (global as any).__TEST_CONFIG_DIR__ || actual.getConfigDir(),
    isTelemetryEnabled: () => true,
    getDeviceId: () => 'test-device-id',
  };
});

function setConfigDir(dir: string) {
  (global as any).__TEST_CONFIG_DIR__ = dir;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTelemetryLines(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      model: 'claude-sonnet-4-6',
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.001,
      timestamp: new Date(i).toISOString(),
    })
  ).join('\n') + (n > 0 ? '\n' : '');
}

function writeTelemetry(dir: string, lines: number) {
  fs.writeFileSync(path.join(dir, 'telemetry.jsonl'), makeTelemetryLines(lines), 'utf-8');
}

function writeNudgeFlag(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'nudge-shown.json'),
    JSON.stringify({ shown: true, timestamp: new Date().toISOString() }),
    'utf-8'
  );
}

// ── countTelemetryRequests ────────────────────────────────────────────────────

describe('signup-nudge: countTelemetryRequests', () => {
  it('returns 0 when telemetry file does not exist', async () => {
    setConfigDir(tmpDir);
    const { countTelemetryRequests } = await import('../src/signup-nudge.js');
    expect(countTelemetryRequests()).toBe(0);
  });

  it('returns 0 for empty file', async () => {
    setConfigDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'telemetry.jsonl'), '', 'utf-8');
    const { countTelemetryRequests } = await import('../src/signup-nudge.js');
    expect(countTelemetryRequests()).toBe(0);
  });

  it('counts 1 line correctly', async () => {
    setConfigDir(tmpDir);
    writeTelemetry(tmpDir, 1);
    const { countTelemetryRequests } = await import('../src/signup-nudge.js');
    expect(countTelemetryRequests()).toBe(1);
  });

  it('counts 99 lines correctly', async () => {
    setConfigDir(tmpDir);
    writeTelemetry(tmpDir, 99);
    const { countTelemetryRequests } = await import('../src/signup-nudge.js');
    expect(countTelemetryRequests()).toBe(99);
  });

  it('counts 100 lines correctly', async () => {
    setConfigDir(tmpDir);
    writeTelemetry(tmpDir, 100);
    const { countTelemetryRequests } = await import('../src/signup-nudge.js');
    expect(countTelemetryRequests()).toBe(100);
  });
});

// ── checkAndShowNudge: threshold behaviour ────────────────────────────────────

describe('signup-nudge: checkAndShowNudge fires at 100, not before', () => {
  it('does NOT print nudge when count is 0', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT print nudge when count is 50', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(50);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT print nudge when count is 99', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(99);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('DOES print nudge when count is exactly 100', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(100);
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('DOES print nudge when count is above 100 (e.g. 250)', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(250);
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0] as string).toContain('250');
  });
});

// ── checkAndShowNudge: idempotency ────────────────────────────────────────────

describe('signup-nudge: idempotency (fires exactly once)', () => {
  it('does NOT fire twice when called back-to-back', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mod.checkAndShowNudge(100); // first — should fire
    mod.checkAndShowNudge(200); // second — should NOT fire
    mod.checkAndShowNudge(300); // third — should NOT fire

    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('writes nudge-shown.json after first fire so future runs are suppressed', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mod.checkAndShowNudge(100);

    // Flag file must exist on disk
    const flagPath = path.join(tmpDir, 'nudge-shown.json');
    expect(fs.existsSync(flagPath)).toBe(true);
    const flag = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
    expect(flag.shown).toBe(true);
  });

  it('does NOT write flag file when count < 100', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    mod.checkAndShowNudge(50);

    const flagPath = path.join(tmpDir, 'nudge-shown.json');
    expect(fs.existsSync(flagPath)).toBe(false);
  });
});

// ── initNudge: reads flag from disk ──────────────────────────────────────────

describe('signup-nudge: initNudge reads flag from disk', () => {
  it('suppresses nudge when flag file exists on disk at startup', async () => {
    setConfigDir(tmpDir);
    writeNudgeFlag(tmpDir); // pre-existing flag

    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();
    mod.initNudge(); // should read the file and set internal flag

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(1000); // should NOT print

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT suppress nudge when flag file does not exist', async () => {
    setConfigDir(tmpDir);
    // No flag file written

    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();
    mod.initNudge();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(100);

    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});

// ── nudge output format ───────────────────────────────────────────────────────

describe('signup-nudge: output format', () => {
  it('nudge contains the 💡 emoji, the request count, and the signup URL', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mod.checkAndShowNudge(100);

    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('💡');
    expect(output).toContain('100');
    expect(output).toContain('relayplane.com/signup');
  });

  it('nudge goes to STDERR, not stdout (never pollutes proxy responses)', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    mod.checkAndShowNudge(100);

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ── no latency impact ─────────────────────────────────────────────────────────

describe('signup-nudge: no latency impact', () => {
  it('checkAndShowNudge completes synchronously in <50ms for 100 calls', async () => {
    setConfigDir(tmpDir);
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const start = Date.now();
    for (let i = 0; i <= 110; i++) {
      mod.checkAndShowNudge(i);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('never throws — even if config dir is inaccessible', async () => {
    // Point to a non-writable directory to force fs errors
    setConfigDir('/root/no-access-hopefully-9999');
    const mod = await import('../src/signup-nudge.js');
    mod._resetNudgeState();

    // Should not throw, regardless of fs errors
    expect(() => mod.checkAndShowNudge(100)).not.toThrow();
  });
});
