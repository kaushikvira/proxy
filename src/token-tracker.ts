/**
 * Auth Token Tracker
 *
 * Monitors OAuth/API key rotation. Tracks the current token,
 * records when it changes, and measures time between rotations.
 * All in-memory — nothing written to disk.
 */

interface TokenRotation {
  token: string;
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

class TokenTracker {
  private current: TokenRotation | null = null;
  private history: TokenRotation[] = [];   // completed rotations

  /** Call on every proxied request with the auth token */
  observe(token: string): void {
    if (!token) return;

    const now = Date.now();

    if (!this.current) {
      // First token ever seen
      this.current = { token, firstSeen: now, lastSeen: now, requestCount: 1 };
      console.log(`[TOKEN] First token observed: ${mask(token)}`);
      return;
    }

    if (this.current.token === token) {
      // Same token, update stats
      this.current.lastSeen = now;
      this.current.requestCount++;
      return;
    }

    // Token changed — rotation detected
    const oldDuration = this.current.lastSeen - this.current.firstSeen;
    console.log(`[TOKEN] Rotation detected! ${mask(this.current.token)} → ${mask(token)} (old token lived ${formatDuration(oldDuration)}, ${this.current.requestCount} requests)`);

    this.history.push({ ...this.current });
    this.current = { token, firstSeen: now, lastSeen: now, requestCount: 1 };
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
