# Live Session Viewer — Design Spec

## Goal

A real-time, browser-based dashboard that lets you watch Claude Code think — organized as a tree of sessions and subagents, with full thinking block visibility. Personal dev tool, loopback only.

## Core User Story

> I have 2-3 Claude Code terminals running. I open localhost:4100/sessions in my browser. I see each active session. I click into one and see a live tree: the main agent's reasoning, any subagents it spawned, and most importantly — the thinking blocks that show me *why* Claude is doing what it's doing. New content appears as it streams in. I can focus on a subagent to see just its thinking, or zoom back out to the full tree.

## Architecture

### What Already Exists (we build on this)

- **Session detection**: `session-tracker.ts` extracts `X-Claude-Code-Session-Id` from Claude Code headers. Falls back to synthetic ID.
- **Agent fingerprinting**: `agent-tracker.ts` identifies agents by system prompt hash.
- **Request history**: In-memory array in `standalone-proxy.ts` with basic content capture (system prompt preview, user message, response preview).
- **Trace writer**: `trace-writer.ts` writes JSONL trace files per session with event types.
- **Dashboard**: Embedded HTML at `/dashboard` with 5s polling.

### What's Missing

1. **Thinking block capture** — the proxy currently filters for `type === 'text'` only. Extended thinking (`type === 'thinking'`) content blocks are dropped.
2. **Subagent/parent relationship tracking** — Claude Code sends `x-parent-trace-id` but the proxy doesn't build a tree from it.
3. **Real-time push** — current dashboard polls every 5s. We need SSE for live streaming.
4. **Tree visualization** — no tree UI exists.

### Design Decisions

1. **SSE, not WebSocket** — the proxy already handles SSE for LLM streaming. Reuse the same pattern for the dashboard. Simpler, no new dependencies.
2. **Capture is async, fire-and-forget** — all content capture happens AFTER the response is forwarded to Claude Code. If capture fails, the proxy doesn't notice.
3. **SQLite for storage** — session data and request content stored in SQLite (same pattern as existing `sessions.db`, `response-cache.db`). In-memory buffer for the live view.
4. **Embedded HTML** — same pattern as existing dashboard. No build step, no React, no npm frontend dependencies. Plain HTML + vanilla JS + CSS. Served as a string from the proxy.
5. **Thinking blocks stored as-is** — we capture the raw thinking text from Claude's response. No summarization, no truncation. These are the most valuable data.

## Data Model

### Request Capture Record

```typescript
interface CapturedRequest {
  id: string;                          // trace ID
  sessionId: string;                   // from X-Claude-Code-Session-Id
  parentTraceId: string | null;        // from x-parent-trace-id (null = main agent)
  agentFingerprint: string;            // SHA-256 of system prompt
  timestamp: string;                   // ISO 8601

  // Request
  model: string;                       // requested model
  routedModel: string;                 // actual model used
  systemPromptPreview: string;         // first 200 chars
  userMessage: string;                 // last user message
  tools: string[];                     // tool names requested

  // Response
  thinkingContent: string;             // full thinking block text
  responseText: string;                // full text response
  toolCalls: ToolCallRecord[];         // tool calls made

  // Metrics
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;             // tokens used for thinking
  costUsd: number;
  latencyMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  // Status
  success: boolean;
  finishReason: string;
  error: string | null;
}

interface ToolCallRecord {
  name: string;
  inputPreview: string;               // first 200 chars of input JSON
  outputPreview: string;              // first 200 chars of output
}
```

### Session Tree Node

```typescript
interface SessionNode {
  sessionId: string;
  agentLabel: string;                  // "Main Agent", "Subagent: explore codebase", etc.
  parentTraceId: string | null;
  children: SessionNode[];             // subagents
  requests: CapturedRequest[];
  isActive: boolean;                   // had a request in last 60s
  totalCost: number;
  totalRequests: number;
}
```

## Components

### 1. Capture Layer (`src/capture.ts`)

**Real-time stream tapping.** As SSE chunks flow from Anthropic through the proxy to Claude Code, we tap the stream — copying each chunk sideways to the SSE event bus for browser viewers. Claude Code sees zero difference; we're just reading the same bytes as they pass through.

**How it works:**
- The proxy already parses SSE chunks to extract tokens/usage (in the streaming handler). We hook into that same parsing loop.
- For each chunk, AFTER forwarding to Claude Code: emit a lightweight event to the live event bus.
- For thinking blocks: `content_block_start` with `type: 'thinking'` starts accumulation, `thinking_delta` events stream the thinking text, `content_block_stop` ends it.
- For text blocks: same pattern with `text_delta`.
- For tool calls: `tool_use` content blocks with `input_json_delta`.

**Responsibilities:**
- Tap streaming chunks as they pass through (thinking, text, tool calls)
- Emit real-time stream events to SSE event bus → browser sees tokens live
- After response completes: assemble full captured record, write to SQLite
- Extract tool calls with input/output previews
- Never block, never throw into the proxy request path

**Performance contract:**
- Stream tapping is a synchronous copy in the existing chunk-processing loop — zero added latency
- SSE emit is fire-and-forget: if no browser is connected, the emit is a no-op (just a counter check)
- SQLite writes are batched (write every 500ms, not per-request)
- If SQLite is unavailable, events are silently dropped (in-memory ring buffer only)
- Ring buffer of last 1000 completed requests for history view

### 2. Session Tree Builder (`src/session-tree.ts`)

Builds and maintains the tree structure from captured requests.

**Responsibilities:**
- Group requests by sessionId
- Build parent-child relationships from `x-parent-trace-id`
- Detect subagent spawning (new agent fingerprint within same session with parent trace)
- Label agents (main agent vs subagent, with agent fingerprint for naming)
- Track active/inactive status (60s idle = inactive)

### 3. SSE Event Bus (`src/live-events.ts`)

Push captured events to connected browser clients.

**Responsibilities:**
- Accept SSE connections from browser at `GET /api/live/events`
- Broadcast new captured requests as they happen
- Broadcast session tree updates (new session, new subagent, session went inactive)
- Handle client disconnect gracefully
- Heartbeat every 15s to keep connection alive

**Event types:**
```
# Real-time streaming events (as tokens flow through proxy)
event: stream.start
data: { traceId, sessionId, parentTraceId, model, timestamp }

event: stream.thinking
data: { traceId, text }            # thinking delta text chunk

event: stream.text
data: { traceId, text }            # response text delta chunk

event: stream.tool_call
data: { traceId, name, inputDelta } # tool call streaming

event: stream.end
data: { traceId, tokensIn, tokensOut, thinkingTokens, costUsd, finishReason }

# Completed request (full assembled record, for history)
event: request.captured
data: { ...CapturedRequest }

# Session structure changes
event: session.updated
data: { sessionId, tree: SessionNode }

event: session.inactive
data: { sessionId }

event: heartbeat
data: {}
```

### 4. Live Session Dashboard (`src/dashboard-live.ts`)

Browser UI served at `/sessions`.

**Layout:**
```
+------------------------------------------+
| Active Sessions                          |
| [Session abc123] [Session def456]  tabs  |
+------------------------------------------+
| Session abc123 — Main Agent              |
|                                          |
| > Request 1  12:03:01  claude-sonnet-4   |
|   Thinking: "I need to understand..."    |
|   Response: "Let me look at..."          |
|                                          |
| v Subagent: explore codebase  (3 reqs)   |
|   > Request 1  12:03:05  claude-haiku    |
|     Thinking: "Searching for auth..."    |
|   > Request 2  12:03:08                  |
|     Thinking: "Found it in src/auth..."  |
|   > Request 3  12:03:11  (result)        |
|                                          |
| > Request 2  12:03:15  (continues)       |
|   Thinking: "Based on the subagent..."   |
+------------------------------------------+
```

**Interactions:**
- Session tabs at top — click to switch. Active sessions pulse/highlight.
- Tree is collapsible — subagents start expanded, can be collapsed.
- Click any request to expand full content (thinking, response, tool calls).
- Thinking blocks are the primary content — shown by default, formatted for readability.
- Auto-scroll follows new content (can be paused by scrolling up).
- Cost and token counts shown per request and aggregated per session/subagent.

**Streaming behavior:**
- SSE connection on page load
- New requests animate into view
- Thinking tokens appear live as they stream through the proxy — same speed as Claude Code receives them
- Text response tokens stream live too
- Tool calls show name + input as they build up
- When response completes, the entry finalizes with cost/token/latency data

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/sessions` | GET | Serve the live session viewer HTML |
| `/api/sessions` | GET | List all sessions with tree structure |
| `/api/sessions/:id` | GET | Full tree + requests for one session |
| `/api/sessions/:id/requests` | GET | Paginated requests for a session |
| `/api/live/events` | GET | SSE stream of live events |

## What We Don't Build (YAGNI)

- No search/filtering in v1 — just live view and scroll
- No export/download
- No persisted UI state (which sessions were expanded)
- No authentication on the dashboard (loopback only)
- No syntax highlighting or markdown rendering in v1 (plain text with whitespace preserved)
- No multi-user support
- No custom themes or UI configuration

## Priority Order

1. **Session detection + tree building** — get the data model right first
2. **Live dashboard with SSE** — the UI to see it
3. **Polish** — formatting, auto-scroll, cost display, collapsible tree
4. **Capture layer** — thinking blocks, tool calls, async SQLite. This is last because the proxy already captures basic content. We enhance it.

## File Plan

| File | Purpose | New/Modify |
|------|---------|------------|
| `src/capture.ts` | Async content capture with thinking blocks | New |
| `src/session-tree.ts` | Tree builder from captured requests | New |
| `src/live-events.ts` | SSE event bus for browser push | New |
| `src/dashboard-live.ts` | HTML/JS/CSS for session viewer | New |
| `src/standalone-proxy.ts` | Hook capture into request handler, add endpoints | Modify |
| `src/session-tracker.ts` | Add parent trace ID extraction | Modify |
