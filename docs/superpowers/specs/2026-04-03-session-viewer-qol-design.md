# Session Viewer QoL — Design Spec (Final)

## What Was Built

Quality-of-life improvements transforming the live session viewer from raw data into a human-readable "Claude's workbench" for context engineering.

## Features Delivered

### Tool Call Visualization
- 17+ tool types mapped to icons + human-readable summaries
- Full input captured via `input_json_delta` accumulation
- `src/tool-call-parser.ts` — pure function, 26 tests

### Expanded Data Capture
- Full system prompt (no truncation, deduped per session)
- Tool definitions with descriptions
- Auth type + full key (masked in UI, reveal on click, copy to clipboard)
- Thinking config + max tokens
- Full tool call input JSON

### Instrument Panel
- 5 real-time gauges: context %, cost $/min, cache hit rate, thinking tokens, throughput
- Correct calculations: context = input + cache_read + cache_create tokens

### Visual Hierarchy
- Two-line request card: metadata row + user message row
- User message: 14px, bright white, markdown rendered
- Badges: colored pills for request type (Chat, Cmd, Edit, Search, Agent)
- Cost bar: inline 80px bar with token distribution

### Readability
- Markdown rendering: code, bold, italic, code blocks, tables, headers, links, file paths
- Live markdown during streaming (throttled 300ms)
- Response text: 14px, proper line height, full width
- No truncation on messages or tool commands

### Scroll & Layout
- Chronological order (terminal-style)
- Auto-expand last 2, older collapsed
- Expand/collapse persists across re-renders
- Scroll anchoring — reading position stable
- "↓ N new" banner when scrolled up

### User Message Cleaning
- Strips system-reminder, task-notification, command tags
- Removes task lists, IMPORTANT directives
- Shows actual human input

## Files Changed

| File | Change |
|------|--------|
| `src/tool-call-parser.ts` | New — pure function for tool display |
| `src/session-tree.ts` | Added optional fields, session-level dedup |
| `src/capture.ts` | Expanded metadata, full tool input, stream.end ordering fix |
| `src/standalone-proxy.ts` | Richer capture, maskApiKey, extractLastUserMessage, tool input accumulation |
| `assets/sessions.html` | Major UI overhaul — instrument panel, card redesign, markdown, scroll |
| `src/token-tracker.ts` | New — rotation monitoring with persistence |
| `src/dashboard-live.ts` | Refactored to serve HTML from disk |
