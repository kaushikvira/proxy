/**
 * Auth Token Tracker
 *
 * Monitors OAuth/API key rotation. Tracks the current token,
 * records when it changes, and measures time between rotations.
 * Rotation history is persisted to ~/.kv-local-proxy/token-rotations.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

interface TokenRotation {
  token: string;
  tokenHash?: string;     // SHA-256 prefix for cross-restart matching
  firstSeen: number;     // timestamp ms
  lastSeen: number;      // timestamp ms
  requestCount: number;
}

interface TokenStats {
  currentToken: string;
  currentTokenAge: string;       // human-readable
  currentTokenRequests: number;
  totalRotations: number;
  rotationHistory: {
    token: string;
    duration: string;            // human-readable
    durationMs: number;
    requests: number;
    firstSeen: string;           // ISO timestamp
    lastSeen: string;
  }[];
  averageRotationMs: number | null;
  averageRotation: string | null; // human-readable
}

function getRotationFilePath(): string {
  const base = process.env['LLM_PROXY_HOME'] ?? os.homedir();
  return path.join(base, '.kv-local-proxy', 'token-rotations.json');
}

class TokenTracker {
  private current: TokenRotation | null = null;
  private history: TokenRotation[] = [];

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const filePath = getRotationFilePath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(data.history)) {
          this.history = data.history;
          console.log(`[TOKEN] Loaded ${this.history.length} rotation(s) from disk`);
        }
        // Restore current token state so age survives restarts
        if (data.current) {
          this.current = data.current;
          const age = formatDuration(Date.now() - data.current.firstSeen);
          console.log(`[TOKEN] Restored current token (age: ${age}, ${data.current.requestCount} reqs)`);
        }
      }
    } catch {
      // Start fresh
    }
  }

  private saveToDisk(): void {
    try {
      const filePath = getRotationFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Save masked tokens in history — never persist full keys
      const safeHistory = this.history.map(h => ({
        ...h,
        token: mask(h.token),
      }));
      // Save current token: masked key + hash for matching, real timestamps
      const safeCurrent = this.current ? {
        token: mask(this.current.token),
        tokenHash: hashToken(this.current.token),
        firstSeen: this.current.firstSeen,
        lastSeen: this.current.lastSeen,
        requestCount: this.current.requestCount,
      } : null;
      fs.writeFileSync(filePath, JSON.stringify({ history: safeHistory, current: safeCurrent }, null, 2), { mode: 0o600 });
    } catch {
      // Best effort
    }
  }

  /** Call on every proxied request with the auth token */
  observe(token: string): void {
    if (!token) return;

    const now = Date.now();

    if (!this.current) {
      // First token ever seen
      this.current = { token, tokenHash: hashToken(token), firstSeen: now, lastSeen: now, requestCount: 1 };
      console.log(`[TOKEN] First token observed: ${mask(token)}`);
      this.saveToDisk();
      return;
    }

    // Compare tokens using hash — works even after restart when current.token is masked
    const incomingHash = hashToken(token);
    const isSameToken = this.current.token === token || this.current.tokenHash === incomingHash;
    if (isSameToken) {
      // Same token — update stats, upgrade to full key + hash
      this.current.token = token;
      this.current.tokenHash = incomingHash;
      this.current.lastSeen = now;
      this.current.requestCount++;
      // Persist periodically (every 10 requests)
      if (this.current.requestCount % 10 === 0) this.saveToDisk();
      return;
    }

    // Token changed — rotation detected
    const oldDuration = this.current.lastSeen - this.current.firstSeen;
    const rotationMsg = `${mask(this.current.token)} → ${mask(token)} (old token lived ${formatDuration(oldDuration)}, ${this.current.requestCount} requests)`;
    console.log(`[TOKEN] Rotation detected! ${rotationMsg}`);

    // Emit SSE event for live dashboard
    try {
      const { getLiveEventBus } = require('./live-events.js');
      getLiveEventBus().emit('token.rotated', {
        oldToken: mask(this.current.token),
        newToken: mask(token),
        oldDuration: formatDuration(oldDuration),
        oldDurationMs: oldDuration,
        oldRequests: this.current.requestCount,
        totalRotations: this.history.length + 1,
        timestamp: new Date().toISOString(),
      });
    } catch {}


    this.history.push({ ...this.current });
    this.current = { token, firstSeen: now, lastSeen: now, requestCount: 1 };
    this.saveToDisk();
  }

  getStats(): TokenStats {
    const now = Date.now();
    const currentAge = this.current ? now - this.current.firstSeen : 0;

    const rotationDurations = this.history.map(h => h.lastSeen - h.firstSeen);
    const avgMs = rotationDurations.length > 0
      ? rotationDurations.reduce((a, b) => a + b, 0) / rotationDurations.length
      : null;

    return {
      currentToken: this.current?.token ?? '',
      currentTokenAge: formatDuration(currentAge),
      currentTokenRequests: this.current?.requestCount ?? 0,
      totalRotations: this.history.length,
      rotationHistory: this.history.map(h => ({
        token: mask(h.token),
        duration: formatDuration(h.lastSeen - h.firstSeen),
        durationMs: h.lastSeen - h.firstSeen,
        requests: h.requestCount,
        firstSeen: new Date(h.firstSeen).toISOString(),
        lastSeen: new Date(h.lastSeen).toISOString(),
      })),
      averageRotationMs: avgMs,
      averageRotation: avgMs ? formatDuration(avgMs) : null,
    };
  }
}

function mask(key: string): string {
  if (key.length <= 16) return '****';
  return key.slice(0, 12) + '****...' + key.slice(-4);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/** Singleton */
let _tracker: TokenTracker | null = null;

export function getTokenTracker(): TokenTracker {
  if (!_tracker) _tracker = new TokenTracker();
  return _tracker;
}

export function resetTokenTracker(): void {
  _tracker = null;
}

export type { TokenStats };
