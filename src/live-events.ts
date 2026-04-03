/**
 * SSE Event Bus for live dashboard streaming.
 * Manages browser SSE connections and broadcasts proxy events.
 */

import type { ServerResponse } from 'node:http';

type EventListener = (event: string, data: unknown) => void;

export class LiveEventBus {
  private listeners = new Set<EventListener>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** Subscribe to all events. Returns unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Broadcast an event to all subscribers. Fire-and-forget. */
  emit(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch {
        // Never let a bad listener crash the proxy
      }
    }
  }

  /** Number of connected clients */
  clientCount(): number {
    return this.listeners.size;
  }

  /**
   * Attach an HTTP response as an SSE client.
   * Sets correct headers, sends heartbeats, cleans up on disconnect.
   */
  attachSSEClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendSSE = (event: string, data: unknown) => {
      if (res.destroyed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Connection gone
      }
    };

    const unsub = this.subscribe(sendSSE);

    // Clean up on client disconnect
    res.on('close', () => {
      unsub();
    });

    // Send initial connected event
    sendSSE('connected', { clientCount: this.clientCount() });
  }

  /** Start heartbeat timer (call once at proxy startup) */
  startHeartbeat(intervalMs = 15000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.emit('heartbeat', { time: Date.now(), clients: this.clientCount() });
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  /** Stop heartbeat and clean up */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.listeners.clear();
  }
}

/** Singleton instance */
let _bus: LiveEventBus | null = null;

export function getLiveEventBus(): LiveEventBus {
  if (!_bus) {
    _bus = new LiveEventBus();
  }
  return _bus;
}

export function resetLiveEventBus(): void {
  _bus?.stop();
  _bus = null;
}
