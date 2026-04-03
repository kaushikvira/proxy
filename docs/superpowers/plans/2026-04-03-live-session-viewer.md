# Live Session Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real-time browser dashboard that shows Claude Code's thinking process organized as a session/subagent tree with live streaming.

**Architecture:** SSE event bus taps into the proxy's existing streaming pipeline. As chunks flow from Anthropic to Claude Code, we copy them sideways to connected browsers. Session tree built from `X-Claude-Code-Session-Id` + `x-parent-trace-id` headers. All new code in focused files, minimal changes to standalone-proxy.ts.

**Tech Stack:** Node.js HTTP SSE, SQLite (better-sqlite3), vanilla HTML/JS/CSS (no framework, no build step)

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `src/live-events.ts` | SSE event bus — manages browser connections, broadcasts events | New |
| `src/session-tree.ts` | In-memory session tree — groups requests by session, builds parent/child relationships | New |
| `src/capture.ts` | Async capture — assembles full request records, writes to SQLite | New |
| `src/dashboard-live.ts` | HTML/JS/CSS for `/sessions` page — tree view with live streaming | New |
| `__tests__/live-events.test.ts` | Tests for SSE event bus | New |
| `__tests__/session-tree.test.ts` | Tests for session tree builder | New |
| `__tests__/capture.test.ts` | Tests for capture layer | New |
| `src/standalone-proxy.ts` | Hook stream tapping + new endpoints | Modify |
| `src/session-tracker.ts` | Add parent trace ID extraction | Modify |

---

### Task 1: SSE Event Bus (`src/live-events.ts`)

The foundation — everything else emits through this.

**Files:**
- Create: `src/live-events.ts`
- Test: `__tests__/live-events.test.ts`

- [ ] **Step 1: Write the failing test for event bus creation and subscription**

```typescript
// __tests__/live-events.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LiveEventBus } from '../src/live-events.js';

describe('LiveEventBus', () => {
  let bus: LiveEventBus;

  beforeEach(() => {
    bus = new LiveEventBus();
  });

  it('reports zero clients when none connected', () => {
    expect(bus.clientCount()).toBe(0);
  });

  it('broadcasts event to subscribed listener', () => {
    const received: string[] = [];
    const unsub = bus.subscribe((event, data) => {
      received.push(`${event}:${JSON.stringify(data)}`);
    });

    bus.emit('stream.thinking', { traceId: 't1', text: 'hello' });

    expect(received).toHaveLength(1);
    expect(received[0]).toContain('stream.thinking');
    expect(received[0]).toContain('hello');

    unsub();
    expect(bus.clientCount()).toBe(0);
  });

  it('does not throw when emitting with no subscribers', () => {
    expect(() => bus.emit('heartbeat', {})).not.toThrow();
  });

  it('removes subscriber on unsub call', () => {
    const unsub = bus.subscribe(() => {});
    expect(bus.clientCount()).toBe(1);
    unsub();
    expect(bus.clientCount()).toBe(0);
  });

  it('handles multiple subscribers', () => {
    const counts = [0, 0];
    const unsub1 = bus.subscribe(() => { counts[0]++; });
    const unsub2 = bus.subscribe(() => { counts[1]++; });

    bus.emit('heartbeat', {});

    expect(counts).toEqual([1, 1]);
    unsub1();
    unsub2();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/live-events.test.ts`
Expected: FAIL with "Cannot find module '../src/live-events.js'"

- [ ] **Step 3: Implement LiveEventBus**

```typescript
// src/live-events.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/live-events.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/live-events.ts __tests__/live-events.test.ts
git commit -m "feat: add SSE event bus for live dashboard streaming"
```

---

### Task 2: Session Tree Builder (`src/session-tree.ts`)

In-memory tree that organizes requests by session and parent/child relationships.

**Files:**
- Create: `src/session-tree.ts`
- Test: `__tests__/session-tree.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/session-tree.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTree, type CapturedRequest } from '../src/session-tree.js';

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    parentTraceId: null,
    agentFingerprint: 'abc123',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    routedModel: 'claude-sonnet-4-6',
    systemPromptPreview: 'You are a helpful assistant',
    userMessage: 'Hello',
    tools: [],
    thinkingContent: 'Let me think about this...',
    responseText: 'Hi there!',
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    thinkingTokens: 20,
    costUsd: 0.001,
    latencyMs: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    success: true,
    finishReason: 'end_turn',
    error: null,
    ...overrides,
  };
}

describe('SessionTree', () => {
  let tree: SessionTree;

  beforeEach(() => {
    tree = new SessionTree();
  });

  it('creates a session on first request', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    const sessions = tree.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-1');
  });

  it('groups requests under same session', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1', id: 'r1' }));
    tree.addRequest(makeRequest({ sessionId: 'sess-1', id: 'r2' }));
    const session = tree.getSession('sess-1');
    expect(session?.requests).toHaveLength(2);
  });

  it('builds subagent as child node when parentTraceId is set', () => {
    tree.addRequest(makeRequest({
      sessionId: 'sess-1',
      id: 'main-1',
      parentTraceId: null,
      agentFingerprint: 'main-fp',
    }));
    tree.addRequest(makeRequest({
      sessionId: 'sess-1',
      id: 'sub-1',
      parentTraceId: 'main-1',
      agentFingerprint: 'sub-fp',
    }));

    const session = tree.getSession('sess-1');
    expect(session?.children).toHaveLength(1);
    expect(session?.children[0].agentFingerprint).toBe('sub-fp');
    expect(session?.children[0].requests).toHaveLength(1);
  });

  it('tracks session as active within timeout', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    const sessions = tree.getSessions();
    expect(sessions[0].isActive).toBe(true);
  });

  it('aggregates cost across session', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1', costUsd: 0.01 }));
    tree.addRequest(makeRequest({ sessionId: 'sess-1', costUsd: 0.02 }));
    const session = tree.getSession('sess-1');
    expect(session?.totalCost).toBeCloseTo(0.03);
    expect(session?.totalRequests).toBe(2);
  });

  it('handles multiple sessions independently', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    tree.addRequest(makeRequest({ sessionId: 'sess-2' }));
    expect(tree.getSessions()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/session-tree.test.ts`
Expected: FAIL with "Cannot find module '../src/session-tree.js'"

- [ ] **Step 3: Implement SessionTree**

```typescript
// src/session-tree.ts
/**
 * In-memory session tree. Groups requests by session ID and builds
 * parent/child relationships for subagent visualization.
 */

export interface ToolCallRecord {
  name: string;
  inputPreview: string;
  outputPreview: string;
}

export interface CapturedRequest {
  id: string;
  sessionId: string;
  parentTraceId: string | null;
  agentFingerprint: string;
  timestamp: string;
  model: string;
  routedModel: string;
  systemPromptPreview: string;
  userMessage: string;
  tools: string[];
  thinkingContent: string;
  responseText: string;
  toolCalls: ToolCallRecord[];
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  success: boolean;
  finishReason: string;
  error: string | null;
}

export interface SessionNode {
  sessionId: string;
  agentFingerprint: string;
  agentLabel: string;
  parentTraceId: string | null;
  children: SessionNode[];
  requests: CapturedRequest[];
  isActive: boolean;
  totalCost: number;
  totalRequests: number;
  lastSeenAt: number;
}

const ACTIVE_TIMEOUT_MS = 60_000;
const MAX_SESSIONS = 100;

export class SessionTree {
  private sessions = new Map<string, SessionNode>();

  addRequest(req: CapturedRequest): void {
    let root = this.sessions.get(req.sessionId);
    if (!root) {
      root = this.createNode(req.sessionId, req.agentFingerprint, null, 'Main Agent');
      this.sessions.set(req.sessionId, root);
      this.evictOldSessions();
    }

    // Find or create the correct node for this request
    if (req.parentTraceId) {
      // This is a subagent request — find or create child node
      let child = root.children.find(c => c.agentFingerprint === req.agentFingerprint);
      if (!child) {
        child = this.createNode(
          req.sessionId,
          req.agentFingerprint,
          req.parentTraceId,
          `Subagent ${root.children.length + 1}`,
        );
        root.children.push(child);
      }
      child.requests.push(req);
      child.totalCost += req.costUsd;
      child.totalRequests++;
      child.lastSeenAt = Date.now();
    } else {
      // Main agent request
      root.requests.push(req);
    }

    root.totalCost += req.costUsd;
    root.totalRequests++;
    root.lastSeenAt = Date.now();
  }

  getSession(sessionId: string): SessionNode | null {
    const node = this.sessions.get(sessionId) ?? null;
    if (node) {
      node.isActive = Date.now() - node.lastSeenAt < ACTIVE_TIMEOUT_MS;
      for (const child of node.children) {
        child.isActive = Date.now() - child.lastSeenAt < ACTIVE_TIMEOUT_MS;
      }
    }
    return node;
  }

  getSessions(): SessionNode[] {
    const now = Date.now();
    const result: SessionNode[] = [];
    for (const node of this.sessions.values()) {
      node.isActive = now - node.lastSeenAt < ACTIVE_TIMEOUT_MS;
      result.push(node);
    }
    // Active sessions first, then by last seen
    result.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastSeenAt - a.lastSeenAt;
    });
    return result;
  }

  private createNode(
    sessionId: string,
    agentFingerprint: string,
    parentTraceId: string | null,
    agentLabel: string,
  ): SessionNode {
    return {
      sessionId,
      agentFingerprint,
      agentLabel,
      parentTraceId,
      children: [],
      requests: [],
      isActive: true,
      totalCost: 0,
      totalRequests: 0,
      lastSeenAt: Date.now(),
    };
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    // Remove oldest inactive session
    let oldest: { key: string; time: number } | null = null;
    for (const [key, node] of this.sessions) {
      if (!node.isActive && (!oldest || node.lastSeenAt < oldest.time)) {
        oldest = { key, time: node.lastSeenAt };
      }
    }
    if (oldest) this.sessions.delete(oldest.key);
  }
}

/** Singleton */
let _tree: SessionTree | null = null;

export function getSessionTree(): SessionTree {
  if (!_tree) _tree = new SessionTree();
  return _tree;
}

export function resetSessionTree(): void {
  _tree = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/session-tree.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session-tree.ts __tests__/session-tree.test.ts
git commit -m "feat: add session tree builder for subagent hierarchy"
```

---

### Task 3: Capture Layer (`src/capture.ts`)

Assembles stream events into complete CapturedRequest records. Taps into streaming chunks.

**Files:**
- Create: `src/capture.ts`
- Test: `__tests__/capture.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/capture.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamAccumulator } from '../src/capture.js';

describe('StreamAccumulator', () => {
  let acc: StreamAccumulator;

  beforeEach(() => {
    acc = new StreamAccumulator('trace-1', 'sess-1', null);
  });

  it('accumulates thinking deltas', () => {
    acc.onThinkingDelta('Hello ');
    acc.onThinkingDelta('world');
    expect(acc.getThinkingContent()).toBe('Hello world');
  });

  it('accumulates text deltas', () => {
    acc.onTextDelta('foo ');
    acc.onTextDelta('bar');
    expect(acc.getResponseText()).toBe('foo bar');
  });

  it('records tool calls', () => {
    acc.onToolCall('read_file', '{"path": "/tmp/foo"}');
    const calls = acc.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('finalizes into a CapturedRequest', () => {
    acc.onThinkingDelta('thinking...');
    acc.onTextDelta('response text');
    acc.setRequestMetadata({
      model: 'claude-sonnet-4-6',
      routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: 'You are helpful',
      userMessage: 'Hello',
      tools: [],
      agentFingerprint: 'abc',
    });
    acc.setResponseMetadata({
      tokensIn: 100,
      tokensOut: 50,
      thinkingTokens: 20,
      costUsd: 0.001,
      latencyMs: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      success: true,
      finishReason: 'end_turn',
    });

    const captured = acc.finalize();
    expect(captured.thinkingContent).toBe('thinking...');
    expect(captured.responseText).toBe('response text');
    expect(captured.sessionId).toBe('sess-1');
    expect(captured.tokensIn).toBe(100);
  });

  it('handles empty thinking gracefully', () => {
    acc.onTextDelta('just text');
    acc.setRequestMetadata({
      model: 'm', routedModel: 'm', systemPromptPreview: '',
      userMessage: '', tools: [], agentFingerprint: '',
    });
    acc.setResponseMetadata({
      tokensIn: 0, tokensOut: 0, thinkingTokens: 0, costUsd: 0,
      latencyMs: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      success: true, finishReason: 'end_turn',
    });
    const captured = acc.finalize();
    expect(captured.thinkingContent).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/capture.test.ts`
Expected: FAIL with "Cannot find module '../src/capture.js'"

- [ ] **Step 3: Implement capture layer**

```typescript
// src/capture.ts
/**
 * Stream capture layer. Accumulates streaming chunks into complete
 * CapturedRequest records and emits real-time events to the live bus.
 */

import { getLiveEventBus } from './live-events.js';
import { getSessionTree, type CapturedRequest, type ToolCallRecord } from './session-tree.js';

interface RequestMetadata {
  model: string;
  routedModel: string;
  systemPromptPreview: string;
  userMessage: string;
  tools: string[];
  agentFingerprint: string;
}

interface ResponseMetadata {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  success: boolean;
  finishReason: string;
}

/**
 * Accumulates streaming deltas for a single request.
 * Created at stream start, finalized at stream end.
 */
export class StreamAccumulator {
  private thinkingChunks: string[] = [];
  private textChunks: string[] = [];
  private toolCallList: ToolCallRecord[] = [];
  private reqMeta: RequestMetadata | null = null;
  private resMeta: ResponseMetadata | null = null;

  constructor(
    public readonly traceId: string,
    public readonly sessionId: string,
    public readonly parentTraceId: string | null,
  ) {}

  onThinkingDelta(text: string): void {
    this.thinkingChunks.push(text);
    // Emit to live bus — fire and forget
    getLiveEventBus().emit('stream.thinking', { traceId: this.traceId, text });
  }

  onTextDelta(text: string): void {
    this.textChunks.push(text);
    getLiveEventBus().emit('stream.text', { traceId: this.traceId, text });
  }

  onToolCall(name: string, inputJson: string): void {
    const record: ToolCallRecord = {
      name,
      inputPreview: inputJson.slice(0, 200),
      outputPreview: '',
    };
    this.toolCallList.push(record);
    getLiveEventBus().emit('stream.tool_call', {
      traceId: this.traceId,
      name,
      inputPreview: record.inputPreview,
    });
  }

  setRequestMetadata(meta: RequestMetadata): void {
    this.reqMeta = meta;
  }

  setResponseMetadata(meta: ResponseMetadata): void {
    this.resMeta = meta;
  }

  getThinkingContent(): string {
    return this.thinkingChunks.join('');
  }

  getResponseText(): string {
    return this.textChunks.join('');
  }

  getToolCalls(): ToolCallRecord[] {
    return this.toolCallList;
  }

  finalize(): CapturedRequest {
    const req: CapturedRequest = {
      id: this.traceId,
      sessionId: this.sessionId,
      parentTraceId: this.parentTraceId,
      agentFingerprint: this.reqMeta?.agentFingerprint ?? '',
      timestamp: new Date().toISOString(),
      model: this.reqMeta?.model ?? '',
      routedModel: this.reqMeta?.routedModel ?? '',
      systemPromptPreview: this.reqMeta?.systemPromptPreview ?? '',
      userMessage: this.reqMeta?.userMessage ?? '',
      tools: this.reqMeta?.tools ?? [],
      thinkingContent: this.getThinkingContent(),
      responseText: this.getResponseText(),
      toolCalls: this.toolCallList,
      tokensIn: this.resMeta?.tokensIn ?? 0,
      tokensOut: this.resMeta?.tokensOut ?? 0,
      thinkingTokens: this.resMeta?.thinkingTokens ?? 0,
      costUsd: this.resMeta?.costUsd ?? 0,
      latencyMs: this.resMeta?.latencyMs ?? 0,
      cacheReadTokens: this.resMeta?.cacheReadTokens ?? 0,
      cacheCreationTokens: this.resMeta?.cacheCreationTokens ?? 0,
      success: this.resMeta?.success ?? false,
      finishReason: this.resMeta?.finishReason ?? '',
      error: null,
    };

    // Add to session tree
    getSessionTree().addRequest(req);

    // Emit completed request event
    getLiveEventBus().emit('request.captured', req);
    getLiveEventBus().emit('session.updated', {
      sessionId: req.sessionId,
      tree: getSessionTree().getSession(req.sessionId),
    });

    return req;
  }
}

/** Active accumulators by trace ID */
const activeStreams = new Map<string, StreamAccumulator>();

export function startStream(traceId: string, sessionId: string, parentTraceId: string | null, model: string): StreamAccumulator {
  const acc = new StreamAccumulator(traceId, sessionId, parentTraceId);
  activeStreams.set(traceId, acc);

  getLiveEventBus().emit('stream.start', {
    traceId,
    sessionId,
    parentTraceId,
    model,
    timestamp: new Date().toISOString(),
  });

  return acc;
}

export function getStream(traceId: string): StreamAccumulator | undefined {
  return activeStreams.get(traceId);
}

export function endStream(traceId: string): CapturedRequest | undefined {
  const acc = activeStreams.get(traceId);
  if (!acc) return undefined;
  activeStreams.delete(traceId);

  const captured = acc.finalize();

  getLiveEventBus().emit('stream.end', {
    traceId,
    tokensIn: captured.tokensIn,
    tokensOut: captured.tokensOut,
    thinkingTokens: captured.thinkingTokens,
    costUsd: captured.costUsd,
    finishReason: captured.finishReason,
  });

  return captured;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/capture.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts __tests__/capture.test.ts
git commit -m "feat: add stream capture layer with thinking block accumulation"
```

---

### Task 4: Live Session Dashboard HTML (`src/dashboard-live.ts`)

The browser UI — served as an embedded HTML string at `/sessions`.

**Files:**
- Create: `src/dashboard-live.ts`

- [ ] **Step 1: Create the dashboard HTML module**

```typescript
// src/dashboard-live.ts
/**
 * Live Session Viewer — embedded HTML/JS/CSS.
 * Served at GET /sessions.
 */

export function getLiveSessionHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Sessions</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; }

  .header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header .status { font-size: 12px; color: #8b949e; }
  .header .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .header .status .dot.connected { background: #3fb950; }
  .header .status .dot.disconnected { background: #f85149; }

  .tabs { display: flex; gap: 2px; padding: 8px 20px; background: #161b22; border-bottom: 1px solid #30363d; overflow-x: auto; }
  .tab { padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; white-space: nowrap; background: transparent; border: 1px solid transparent; color: #8b949e; }
  .tab:hover { background: #21262d; color: #c9d1d9; }
  .tab.active { background: #0d1117; border-color: #30363d; color: #f0f6fc; }
  .tab .pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #3fb950; margin-right: 6px; animation: pulse 2s infinite; }
  .tab .inactive-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #484f58; margin-right: 6px; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .session-view { padding: 16px 20px; max-width: 1200px; overflow-y: auto; height: calc(100vh - 100px); }

  .request-node { margin: 8px 0; border-left: 2px solid #30363d; padding-left: 16px; }
  .request-node.subagent-group { margin-left: 24px; border-left-color: #1f6feb; }

  .request-header { display: flex; align-items: center; gap: 10px; padding: 6px 0; cursor: pointer; font-size: 13px; }
  .request-header:hover { color: #f0f6fc; }
  .request-header .time { color: #8b949e; font-size: 12px; min-width: 70px; }
  .request-header .model { color: #58a6ff; font-size: 12px; }
  .request-header .cost { color: #3fb950; font-size: 12px; margin-left: auto; }
  .request-header .tokens { color: #8b949e; font-size: 11px; }

  .subagent-header { padding: 8px 0 4px 0; font-size: 13px; font-weight: 600; color: #58a6ff; cursor: pointer; }
  .subagent-header .toggle { font-size: 11px; margin-right: 6px; }

  .thinking-block { background: #1c1c2e; border: 1px solid #2d2d44; border-radius: 6px; padding: 12px; margin: 6px 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #b392f0; max-height: 400px; overflow-y: auto; }
  .thinking-block.streaming { border-color: #8957e5; }
  .thinking-label { font-size: 11px; color: #8957e5; font-weight: 600; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

  .response-block { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin: 6px 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }

  .tool-call { background: #1a1e24; border: 1px solid #30363d; border-radius: 4px; padding: 8px 12px; margin: 4px 0; font-size: 12px; }
  .tool-call .tool-name { color: #ffa657; font-weight: 600; }

  .empty-state { text-align: center; color: #484f58; padding: 80px 20px; font-size: 14px; }

  .session-stats { font-size: 12px; color: #8b949e; padding: 4px 0 12px 0; border-bottom: 1px solid #21262d; margin-bottom: 12px; }
  .session-stats span { margin-right: 16px; }
</style>
</head>
<body>

<div class="header">
  <h1>Live Sessions</h1>
  <div class="status"><span class="dot disconnected" id="statusDot"></span><span id="statusText">Connecting...</span></div>
</div>

<div class="tabs" id="tabs"></div>

<div class="session-view" id="sessionView">
  <div class="empty-state">Waiting for requests...<br><br>Point your agent at http://localhost:4100</div>
</div>

<script>
const state = {
  sessions: {},
  activeSessionId: null,
  autoScroll: true,
  expandedRequests: new Set(),
  collapsedSubagents: new Set(),
  streamingContent: {},  // traceId -> { thinking: '', text: '' }
};

// SSE Connection
let evtSource = null;

function connect() {
  evtSource = new EventSource('/api/live/events');

  evtSource.addEventListener('connected', () => {
    document.getElementById('statusDot').className = 'dot connected';
    document.getElementById('statusText').textContent = 'Connected';
  });

  evtSource.addEventListener('stream.start', (e) => {
    const d = JSON.parse(e.data);
    state.streamingContent[d.traceId] = { thinking: '', text: '', model: d.model, sessionId: d.sessionId, parentTraceId: d.parentTraceId, startTime: Date.now() };
    ensureSession(d.sessionId);
    render();
  });

  evtSource.addEventListener('stream.thinking', (e) => {
    const d = JSON.parse(e.data);
    if (state.streamingContent[d.traceId]) {
      state.streamingContent[d.traceId].thinking += d.text;
      renderStreaming(d.traceId);
    }
  });

  evtSource.addEventListener('stream.text', (e) => {
    const d = JSON.parse(e.data);
    if (state.streamingContent[d.traceId]) {
      state.streamingContent[d.traceId].text += d.text;
      renderStreaming(d.traceId);
    }
  });

  evtSource.addEventListener('stream.tool_call', (e) => {
    const d = JSON.parse(e.data);
    if (state.streamingContent[d.traceId]) {
      if (!state.streamingContent[d.traceId].toolCalls) state.streamingContent[d.traceId].toolCalls = [];
      state.streamingContent[d.traceId].toolCalls.push(d);
      renderStreaming(d.traceId);
    }
  });

  evtSource.addEventListener('stream.end', (e) => {
    const d = JSON.parse(e.data);
    delete state.streamingContent[d.traceId];
  });

  evtSource.addEventListener('request.captured', (e) => {
    const req = JSON.parse(e.data);
    ensureSession(req.sessionId);
    addRequestToState(req);
    render();
    maybeAutoScroll();
  });

  evtSource.addEventListener('session.updated', (e) => {
    const d = JSON.parse(e.data);
    if (d.tree) state.sessions[d.sessionId] = d.tree;
    render();
  });

  evtSource.addEventListener('heartbeat', () => {});

  evtSource.onerror = () => {
    document.getElementById('statusDot').className = 'dot disconnected';
    document.getElementById('statusText').textContent = 'Reconnecting...';
  };
}

function ensureSession(sessionId) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = { sessionId, agentLabel: 'Main Agent', requests: [], children: [], isActive: true, totalCost: 0, totalRequests: 0 };
  }
  if (!state.activeSessionId) {
    state.activeSessionId = sessionId;
  }
}

function addRequestToState(req) {
  const session = state.sessions[req.sessionId];
  if (!session) return;
  // Avoid duplicates
  if (session.requests.find(r => r.id === req.id)) return;
  if (req.parentTraceId) {
    let child = session.children?.find(c => c.agentFingerprint === req.agentFingerprint);
    if (!child) {
      child = { sessionId: req.sessionId, agentFingerprint: req.agentFingerprint, agentLabel: 'Subagent ' + ((session.children?.length || 0) + 1), parentTraceId: req.parentTraceId, children: [], requests: [], isActive: true, totalCost: 0, totalRequests: 0 };
      if (!session.children) session.children = [];
      session.children.push(child);
    }
    child.requests.push(req);
    child.totalCost += req.costUsd;
    child.totalRequests++;
  } else {
    session.requests.push(req);
  }
  session.totalCost += req.costUsd;
  session.totalRequests++;
  session.isActive = true;
}

function render() {
  renderTabs();
  renderSession();
}

function renderTabs() {
  const el = document.getElementById('tabs');
  const ids = Object.keys(state.sessions);
  if (ids.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = ids.map(id => {
    const s = state.sessions[id];
    const dot = s.isActive ? '<span class="pulse"></span>' : '<span class="inactive-dot"></span>';
    const active = id === state.activeSessionId ? ' active' : '';
    const cost = s.totalCost > 0 ? ' $' + s.totalCost.toFixed(4) : '';
    const label = id.length > 12 ? id.slice(0, 12) + '...' : id;
    return '<div class="tab' + active + '" onclick="selectSession(\\'' + id + '\\')">' + dot + label + cost + '</div>';
  }).join('');
}

function selectSession(id) {
  state.activeSessionId = id;
  render();
}

function renderSession() {
  const view = document.getElementById('sessionView');
  if (!state.activeSessionId || !state.sessions[state.activeSessionId]) {
    view.innerHTML = '<div class="empty-state">Waiting for requests...<br><br>Point your agent at http://localhost:4100</div>';
    return;
  }

  const session = state.sessions[state.activeSessionId];
  let html = '<div class="session-stats">';
  html += '<span>Requests: ' + session.totalRequests + '</span>';
  html += '<span>Cost: $' + (session.totalCost || 0).toFixed(4) + '</span>';
  html += '</div>';

  // Interleave main requests and subagent groups by timestamp
  const items = [];
  for (const req of (session.requests || [])) {
    items.push({ type: 'request', data: req, time: new Date(req.timestamp).getTime() });
  }
  for (const child of (session.children || [])) {
    if (child.requests.length > 0) {
      items.push({ type: 'subagent', data: child, time: new Date(child.requests[0].timestamp).getTime() });
    }
  }
  items.sort((a, b) => a.time - b.time);

  // Render streaming requests at the bottom
  for (const [traceId, stream] of Object.entries(state.streamingContent)) {
    if (stream.sessionId === state.activeSessionId) {
      items.push({ type: 'streaming', data: { traceId, ...stream }, time: stream.startTime || Date.now() });
    }
  }

  for (const item of items) {
    if (item.type === 'request') {
      html += renderRequest(item.data);
    } else if (item.type === 'subagent') {
      html += renderSubagent(item.data);
    } else if (item.type === 'streaming') {
      html += renderStreamingRequest(item.data);
    }
  }

  view.innerHTML = html;
}

function renderStreamingRequest(stream) {
  let html = '<div class="request-node">';
  html += '<div class="request-header"><span class="time">streaming...</span><span class="model">' + esc(stream.model || '') + '</span></div>';
  if (stream.thinking) {
    html += '<div class="thinking-label">Thinking</div>';
    html += '<div class="thinking-block streaming" id="thinking-' + stream.traceId + '">' + esc(stream.thinking) + '</div>';
  }
  if (stream.text) {
    html += '<div class="response-block">' + esc(stream.text) + '</div>';
  }
  if (stream.toolCalls) {
    for (const tc of stream.toolCalls) {
      html += '<div class="tool-call"><span class="tool-name">' + esc(tc.name) + '</span> ' + esc(tc.inputPreview || '') + '</div>';
    }
  }
  html += '</div>';
  return html;
}

function renderRequest(req) {
  const expanded = state.expandedRequests.has(req.id);
  const time = new Date(req.timestamp).toLocaleTimeString();
  const cost = req.costUsd > 0 ? '$' + req.costUsd.toFixed(4) : '';
  const tokens = req.tokensIn + req.tokensOut > 0 ? (req.tokensIn + '+' + req.tokensOut + ' tok') : '';

  let html = '<div class="request-node">';
  html += '<div class="request-header" onclick="toggleRequest(\\'' + req.id + '\\')">';
  html += '<span class="time">' + time + '</span>';
  html += '<span class="model">' + esc(req.routedModel || req.model) + '</span>';
  if (req.userMessage) html += '<span style="color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px">' + esc(req.userMessage.slice(0, 80)) + '</span>';
  html += '<span class="cost">' + cost + '</span>';
  html += '<span class="tokens">' + tokens + '</span>';
  html += '</div>';

  if (expanded || req.thinkingContent) {
    // Always show thinking if present
    if (req.thinkingContent) {
      html += '<div class="thinking-label">Thinking' + (req.thinkingTokens > 0 ? ' (' + req.thinkingTokens + ' tokens)' : '') + '</div>';
      html += '<div class="thinking-block">' + esc(req.thinkingContent) + '</div>';
    }
  }

  if (expanded) {
    if (req.responseText) {
      html += '<div class="response-block">' + esc(req.responseText) + '</div>';
    }
    for (const tc of (req.toolCalls || [])) {
      html += '<div class="tool-call"><span class="tool-name">' + esc(tc.name) + '</span> ' + esc(tc.inputPreview) + '</div>';
    }
  }

  html += '</div>';
  return html;
}

function renderSubagent(child) {
  const collapsed = state.collapsedSubagents.has(child.agentFingerprint);
  const arrow = collapsed ? '&#9654;' : '&#9660;';
  const cost = child.totalCost > 0 ? ' ($' + child.totalCost.toFixed(4) + ')' : '';

  let html = '<div class="subagent-header" onclick="toggleSubagent(\\'' + child.agentFingerprint + '\\')">';
  html += '<span class="toggle">' + arrow + '</span>';
  html += esc(child.agentLabel) + ' (' + child.totalRequests + ' reqs)' + cost;
  html += '</div>';

  if (!collapsed) {
    html += '<div class="request-node subagent-group">';
    for (const req of child.requests) {
      html += renderRequest(req);
    }
    html += '</div>';
  }

  return html;
}

function toggleRequest(id) {
  if (state.expandedRequests.has(id)) state.expandedRequests.delete(id);
  else state.expandedRequests.add(id);
  renderSession();
}

function toggleSubagent(fp) {
  if (state.collapsedSubagents.has(fp)) state.collapsedSubagents.delete(fp);
  else state.collapsedSubagents.add(fp);
  renderSession();
}

function renderStreaming(traceId) {
  const el = document.getElementById('thinking-' + traceId);
  if (el && state.streamingContent[traceId]) {
    el.textContent = state.streamingContent[traceId].thinking;
    maybeAutoScroll();
    return;
  }
  // Full re-render for text/tool updates
  renderSession();
  maybeAutoScroll();
}

function maybeAutoScroll() {
  if (!state.autoScroll) return;
  const view = document.getElementById('sessionView');
  view.scrollTop = view.scrollHeight;
}

// Detect manual scroll = disable auto-scroll; scroll to bottom = re-enable
document.getElementById('sessionView').addEventListener('scroll', function() {
  const el = this;
  state.autoScroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
});

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Load existing sessions on page load, then connect SSE
fetch('/api/sessions').then(r => r.json()).then(data => {
  if (data.sessions) {
    for (const s of data.sessions) {
      state.sessions[s.sessionId] = s;
      if (!state.activeSessionId && s.isActive) state.activeSessionId = s.sessionId;
    }
    if (!state.activeSessionId && data.sessions.length > 0) state.activeSessionId = data.sessions[0].sessionId;
    render();
  }
}).catch(() => {}).finally(() => connect());
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify module compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/dashboard-live.ts
git commit -m "feat: add live session viewer HTML dashboard"
```

---

### Task 5: Wire Everything into `standalone-proxy.ts`

Hook the capture layer into the streaming pipeline and add the new endpoints.

**Files:**
- Modify: `src/standalone-proxy.ts`
- Modify: `src/session-tracker.ts`

- [ ] **Step 1: Add parent trace ID extraction to session-tracker.ts**

In `src/session-tracker.ts`, update the `getSessionId` function to also return `parentTraceId`:

```typescript
// Add to the return type and extraction logic in getSessionId():
// After line that reads X-Claude-Code-Session-Id, add:
const parentTraceId = (req.headers['x-parent-trace-id'] as string) || null;
// Return parentTraceId alongside sessionId and sessionSource
```

Update the function signature to return `{ sessionId, sessionSource, parentTraceId }`.

- [ ] **Step 2: Add imports and new endpoints to standalone-proxy.ts**

At the top of `standalone-proxy.ts`, add imports:

```typescript
import { getLiveEventBus } from './live-events.js';
import { getSessionTree } from './session-tree.js';
import { startStream, endStream, getStream } from './capture.js';
import { getLiveSessionHTML } from './dashboard-live.js';
```

- [ ] **Step 3: Add HTTP endpoints for the live dashboard**

In the request handler (where other endpoints like `/dashboard` are handled), add:

```typescript
// Serve live session viewer
if (req.method === 'GET' && pathname === '/sessions') {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getLiveSessionHTML());
  return;
}

// SSE event stream
if (req.method === 'GET' && pathname === '/api/live/events') {
  getLiveEventBus().attachSSEClient(res);
  return;
}

// Session list API
if (req.method === 'GET' && pathname === '/api/sessions') {
  const sessions = getSessionTree().getSessions();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessions }));
  return;
}

// Single session API
if (req.method === 'GET' && pathname.startsWith('/api/sessions/') && pathname.split('/').length === 4) {
  const sessionId = decodeURIComponent(pathname.split('/')[3]);
  const session = getSessionTree().getSession(sessionId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ session }));
  return;
}
```

- [ ] **Step 4: Hook stream tapping into the Anthropic streaming handler**

In the Anthropic SSE streaming sections of `standalone-proxy.ts`, where `content_block_start`, `content_block_delta`, and `message_stop` events are parsed, add capture calls.

At stream start (where a new streaming request begins):
```typescript
const accumulator = startStream(traceId, sessionId, parentTraceId, targetModel);
accumulator.setRequestMetadata({
  model: requestedModel,
  routedModel: targetModel,
  systemPromptPreview: systemPromptPreview,
  userMessage: userMessage,
  tools: toolNames,
  agentFingerprint: agentFingerprint,
});
```

In the SSE chunk parser, when processing `content_block_delta`:
```typescript
// For thinking_delta:
if (delta.type === 'thinking_delta' && delta.thinking) {
  const stream = getStream(traceId);
  if (stream) stream.onThinkingDelta(delta.thinking);
}
// For text_delta:
if (delta.type === 'text_delta' && delta.text) {
  const stream = getStream(traceId);
  if (stream) stream.onTextDelta(delta.text);
}
// For tool_use content blocks:
if (contentBlock.type === 'tool_use') {
  const stream = getStream(traceId);
  if (stream) stream.onToolCall(contentBlock.name, JSON.stringify(contentBlock.input || {}));
}
```

At stream end (after response completes and token counts are available):
```typescript
const stream = getStream(traceId);
if (stream) {
  stream.setResponseMetadata({
    tokensIn, tokensOut, thinkingTokens: 0,
    costUsd, latencyMs: durationMs,
    cacheReadTokens, cacheCreationTokens,
    success: true, finishReason,
  });
  endStream(traceId);
}
```

- [ ] **Step 5: Start the event bus heartbeat at proxy startup**

In the `startProxy` function, add:
```typescript
getLiveEventBus().startHeartbeat();
```

And in the shutdown handler, add:
```typescript
getLiveEventBus().stop();
```

- [ ] **Step 6: Build and verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/standalone-proxy.ts src/session-tracker.ts
git commit -m "feat: wire live session viewer into proxy streaming pipeline"
```

---

### Task 6: Integration Test — End-to-End Verify

**Files:**
- Test: `__tests__/live-session.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// __tests__/live-session.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LiveEventBus } from '../src/live-events.js';
import { SessionTree } from '../src/session-tree.js';
import { StreamAccumulator } from '../src/capture.js';

describe('Live Session Integration', () => {
  it('full flow: stream start -> thinking -> text -> end -> appears in tree', () => {
    const bus = new LiveEventBus();
    const tree = new SessionTree();
    const events: string[] = [];

    bus.subscribe((event) => { events.push(event); });

    // Simulate a stream
    const acc = new StreamAccumulator('trace-1', 'sess-1', null);
    acc.onThinkingDelta('Let me analyze ');
    acc.onThinkingDelta('the code...');
    acc.onTextDelta('Here is my analysis.');
    acc.onToolCall('read_file', '{"path":"/src/main.ts"}');

    acc.setRequestMetadata({
      model: 'claude-sonnet-4-6',
      routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: 'You are a coding assistant',
      userMessage: 'Review this code',
      tools: ['read_file'],
      agentFingerprint: 'fp-main',
    });
    acc.setResponseMetadata({
      tokensIn: 1000, tokensOut: 500, thinkingTokens: 200,
      costUsd: 0.005, latencyMs: 1500,
      cacheReadTokens: 100, cacheCreationTokens: 0,
      success: true, finishReason: 'end_turn',
    });

    const captured = acc.finalize();

    // Verify captured data
    expect(captured.thinkingContent).toBe('Let me analyze the code...');
    expect(captured.responseText).toBe('Here is my analysis.');
    expect(captured.toolCalls).toHaveLength(1);
    expect(captured.toolCalls[0].name).toBe('read_file');
    expect(captured.tokensIn).toBe(1000);

    // Manually add to tree (in real code, finalize() does this)
    tree.addRequest(captured);

    // Verify tree
    const session = tree.getSession('sess-1');
    expect(session).not.toBeNull();
    expect(session!.requests).toHaveLength(1);
    expect(session!.totalCost).toBeCloseTo(0.005);
  });

  it('subagent requests appear as children in tree', () => {
    const tree = new SessionTree();

    // Main agent request
    tree.addRequest({
      id: 'main-1', sessionId: 'sess-1', parentTraceId: null,
      agentFingerprint: 'fp-main', timestamp: new Date().toISOString(),
      model: 'claude-sonnet-4-6', routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: '', userMessage: 'Fix the bug', tools: [],
      thinkingContent: 'I need to investigate...', responseText: 'Let me check.',
      toolCalls: [], tokensIn: 100, tokensOut: 50, thinkingTokens: 30,
      costUsd: 0.001, latencyMs: 500, cacheReadTokens: 0,
      cacheCreationTokens: 0, success: true, finishReason: 'end_turn', error: null,
    });

    // Subagent request
    tree.addRequest({
      id: 'sub-1', sessionId: 'sess-1', parentTraceId: 'main-1',
      agentFingerprint: 'fp-sub', timestamp: new Date().toISOString(),
      model: 'claude-haiku-4-5', routedModel: 'claude-haiku-4-5',
      systemPromptPreview: '', userMessage: 'Search for auth code', tools: ['grep'],
      thinkingContent: 'Searching the codebase...', responseText: 'Found in src/auth.ts',
      toolCalls: [{ name: 'grep', inputPreview: '{"pattern":"auth"}', outputPreview: '' }],
      tokensIn: 50, tokensOut: 30, thinkingTokens: 10,
      costUsd: 0.0002, latencyMs: 200, cacheReadTokens: 0,
      cacheCreationTokens: 0, success: true, finishReason: 'end_turn', error: null,
    });

    const session = tree.getSession('sess-1');
    expect(session!.requests).toHaveLength(1); // main agent
    expect(session!.children).toHaveLength(1); // one subagent group
    expect(session!.children[0].requests).toHaveLength(1);
    expect(session!.children[0].agentFingerprint).toBe('fp-sub');
    expect(session!.totalCost).toBeCloseTo(0.0012);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run __tests__/live-session.test.ts`
Expected: PASS (all 2 tests)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (some existing tests may fail if they depend on deleted files — that's a known issue from the security hardening, not from this feature)

- [ ] **Step 4: Commit**

```bash
git add __tests__/live-session.test.ts
git commit -m "test: add integration tests for live session viewer"
```

---

### Task 7: Manual Testing Checklist

- [ ] **Step 1: Start the proxy**

```bash
npm run build && npm start
```

- [ ] **Step 2: Open the live dashboard**

Open http://localhost:4100/sessions in browser. Should see "Waiting for requests..." with "Connected" status.

- [ ] **Step 3: Send a test request through the proxy**

```bash
curl -X POST http://localhost:4100/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":200,"messages":[{"role":"user","content":"What is 2+2? Think step by step."}]}'
```

- [ ] **Step 4: Verify dashboard shows the request**

Expected:
- A session tab appears
- The request shows with thinking content (if extended thinking is enabled) and response text
- Cost and token counts are displayed

- [ ] **Step 5: Test streaming with Claude Code**

Set `ANTHROPIC_BASE_URL=http://localhost:4100` and use Claude Code normally. Watch the dashboard update in real-time.

- [ ] **Step 6: Verify subagent detection**

Use Claude Code with the Agent tool. The dashboard should show subagent groups nested under the main agent.
