# Live Session Viewer — Design Spec (Final)

## What Was Built

A real-time browser dashboard at `localhost:4100/sessions` that shows Claude Code's activity as it happens — organized by session with tool visualization, cost tracking, and a real-time instrument panel.

## Architecture

- **SSE event bus** (`src/live-events.ts`) — broadcasts proxy events to connected browsers
- **Session tree** (`src/session-tree.ts`) — groups requests by session ID, builds parent/child for subagents
- **Capture layer** (`src/capture.ts`) — taps streaming chunks as they flow through proxy, accumulates into complete records
- **Dashboard** (`assets/sessions.html`) — self-contained HTML/JS/CSS served from disk
- **Token tracker** (`src/token-tracker.ts`) — monitors auth token rotation, persists history
- **Tool call parser** (`src/tool-call-parser.ts`) — maps tool names + JSON input to human-readable display

## Features Implemented

### Instrument Panel (always visible)
- Context Window gauge — % of 1M context used (green/yellow/red)
- Cost velocity — $/min rolling rate + session total
- Cache hit rate — % cached + estimated savings
- Thinking tokens — last request + average
- Throughput — tok/s + avg latency

### Request Cards (chronological, newest at bottom)
- Two-line header: metadata row (time, model, badges, cost bar, cost, tokens) + user message row (large, bright, markdown rendered)
- Auto-expand last 2 completed requests, older ones collapsed
- ▶/▼ expand indicators
- Manual toggle overrides auto-expand
- Streaming request always at bottom, always expanded

### Tool Call Visualization
- Icons per tool type: 📖 Read, 🔍 Grep, ✏️ Edit, ⚡ Bash, 🤖 Agent, 🎯 Skill, etc.
- Full tool input displayed (commands, file paths, search queries)
- Accumulated from `input_json_delta` streaming chunks

### Request Type Badges
- Color-coded pills: Chat (grey), Cmd (orange), Edit (green), Search (blue), Read (blue), Agent (purple)
- Multiple badges per request

### Markdown Rendering
- Inline `code`, **bold**, *italic*, code blocks, headers, lists, tables, blockquotes, URLs, file paths
- Applied to response text, thinking blocks, and user message previews
- Throttled (300ms) during streaming to avoid jitter

### Session Context Panel (collapsible)
- Full system prompt (expandable, no truncation)
- Tool definitions with descriptions (89+ tools)
- Auth type + masked key with show/hide toggle + copy button
- Model config (thinking mode, max tokens)
- Token rotation tracking with history

### Token Rotation Tracking
- Monitors OAuth token changes in real-time
- Shows current token age, request count, total rotations, avg interval
- Rotation history persisted to `~/.kv-local-proxy/token-rotations.json`
- Visible in both `/sessions` context panel and `/dashboard` top section
- Copy Token button on main `/dashboard`

### Scroll Behavior
- Chronological order (oldest top, newest bottom) — like a terminal
- Auto-scroll keeps you at latest activity
- Scroll up to read — auto-scroll pauses, nothing shifts
- "↓ N new requests" sticky banner when scrolled up
- Expand/collapse state persists across re-renders

### Data Optimization
- System prompt, tool definitions, auth deduped at session level (not per request)
- ~98% memory reduction for duplicated context data

### User Message Cleaning
- Strips `<system-reminder>`, `<task-notification>`, `<command-*>` tags
- Removes task lists, IMPORTANT directives, other Claude Code metadata
- Shows only the human's actual input

## Data Flow

```
Claude Code → HTTP request → Proxy (localhost:4100)
  ↓
  Forward to Anthropic API (unchanged)
  ↓
  SSE response streams back through proxy
  ↓ (tap stream — zero added latency)
  Capture layer accumulates chunks:
    - thinking_delta → onThinkingDelta()
    - text_delta → onTextDelta()
    - input_json_delta → accumulate tool input
    - content_block_stop → finalize tool call
  ↓
  Emit SSE events to browser:
    stream.start → stream.thinking → stream.text → stream.tool_call → stream.end
  ↓
  stream.end → finalize() → add to session tree → emit session.updated
  ↓
  Browser renders in real-time
```

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `assets/sessions.html` | ~1100 | Dashboard HTML/JS/CSS |
| `src/live-events.ts` | ~95 | SSE event bus |
| `src/session-tree.ts` | ~130 | Session tree with dedup |
| `src/capture.ts` | ~150 | Stream accumulator |
| `src/token-tracker.ts` | ~130 | Token rotation tracking |
| `src/tool-call-parser.ts` | ~80 | Tool name → icon + summary |
| `src/dashboard-live.ts` | ~21 | Serves HTML from disk |

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/sessions` | GET | Serve live session viewer HTML |
| `/api/live/events` | GET | SSE stream of live events |
| `/api/sessions` | GET | List all sessions with tree structure |
| `/api/sessions/:id` | GET | Single session detail |
| `/api/token-stats` | GET | Token rotation stats |
