/**
 * RelayPlane Signup Nudge
 *
 * After the 100th cumulative proxied request, prints a one-time CLI nudge
 * to stderr encouraging the user to connect a free cloud account.
 *
 * Guarantees:
 *  - Fires exactly once per install (flag written to ~/.relayplane/nudge-shown.json)
 *  - Prints to stderr — never pollutes proxy response stdout
 *  - Zero added latency — call checkAndShowNudge() *after* forwarding the response
 *  - Never throws — all errors are silently swallowed
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './config.js';

/** Path to the telemetry event log */
function getTelemetryFile(): string {
  return path.join(getConfigDir(), 'telemetry.jsonl');
}

/** Path to the nudge-shown flag file */
function getNudgeFlagFile(): string {
  return path.join(getConfigDir(), 'nudge-shown.json');
}

/** Whether the nudge has already been shown (checked once at startup) */
let nudgeAlreadyShown = false;

/**
 * Call this once at proxy startup.
 * Reads the flag file and caches the result so we never re-read it per-request.
 */
export function initNudge(): void {
  try {
    const flagPath = getNudgeFlagFile();
    if (fs.existsSync(flagPath)) {
      nudgeAlreadyShown = true;
    }
  } catch {
    // Silently ignore — nudge is non-critical
  }
}

/**
 * Count cumulative requests from the telemetry.jsonl file.
 * Returns 0 on any read/parse error.
 */
export function countTelemetryRequests(): number {
  try {
    const file = getTelemetryFile();
    if (!fs.existsSync(file)) return 0;
    const content = fs.readFileSync(file, 'utf-8');
    // Each non-empty line is one request event
    return content.split('\n').filter(l => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Write the nudge-shown flag so it never fires again.
 */
function markNudgeShown(): void {
  try {
    const flagPath = getNudgeFlagFile();
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(flagPath, JSON.stringify({ shown: true, timestamp: new Date().toISOString() }), 'utf-8');
    nudgeAlreadyShown = true;
  } catch {
    // Silently ignore
  }
}

/**
 * Print the signup nudge to stderr.
 */
function printNudge(count: number): void {
  process.stderr.write(
    `\n💡 You've made ${count} requests through RelayPlane. Connect a free cloud account to sync savings history → relayplane.com/signup\n\n`
  );
}

/**
 * Check whether the nudge should fire and, if so, show it.
 *
 * Call this AFTER the proxy response has been forwarded so there is
 * zero added latency on the request path.  This function is intentionally
 * synchronous so it can be fire-and-forgotten without creating a dangling
 * promise.
 *
 * @param requestCount  Optional: pass the current cumulative count if you
 *                      already have it (avoids re-reading the file).  When
 *                      omitted the file is read on every call until the nudge
 *                      fires — fine because reads are O(lines) and infrequent.
 */
export function checkAndShowNudge(requestCount?: number): void {
  // Fast path — already shown, skip all I/O
  if (nudgeAlreadyShown) return;

  try {
    const count = requestCount ?? countTelemetryRequests();
    if (count >= 100) {
      printNudge(count);
      markNudgeShown();
    }
  } catch {
    // Nudge must never break the proxy
  }
}

// ── Test-seam exports (not part of public API) ────────────────────────────────

/** Reset in-memory flag (used in tests only) */
export function _resetNudgeState(): void {
  nudgeAlreadyShown = false;
}

/** Expose the flag path for tests */
export { getNudgeFlagFile, getTelemetryFile };
