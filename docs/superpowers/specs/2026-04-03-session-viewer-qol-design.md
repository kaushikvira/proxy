# Session Viewer QoL — Design Spec

## Goal

Transform the live session viewer from raw data display into a human-readable "Claude's workbench" that teaches you how Claude thinks, what tools it uses, and helps you engineer better context (system prompts, MCP tools, skills).

## User Role

Context engineer — someone tuning system prompts, MCP tools, skills, and workflows to get better results from Claude. The session viewer should be the feedback loop for that tuning.

## Features

### 1. Tool Call Visualization

Parse tool call inputs and display as human-readable actions with icons:

| Tool | Display |
|------|---------|
| `Read` / `read_file` | 📖 Read `src/auth.ts` (lines 1-50) |
| `Grep` / `grep` | 🔍 Grep `"middleware"` in `src/` → N matches |
| `Glob` / `glob` | 🔍 Glob `**/*.ts` → N files |
| `Edit` / `edit_file` | 🖊️ Edit `src/config.ts` (replaced N lines) |
| `Write` / `write_file` | 📝 Write `src/new-file.ts` |
| `Bash` | ⚡ `npm test` → exit 0 |
| `Agent` | 🤖 Agent: "explore codebase" |
| `AskUserQuestion` | 💬 Ask: "Which approach?" |
| `WebFetch` | 🌐 Fetch `https://...` |
| `WebSearch` | 🌐 Search: "query" |
| `Skill` | 🎯 Skill: `commit` |
| `TaskCreate/Update` | 📋 Task: "subject" |
| Other MCP tools | 🔌 `mcp__slack__send_message` |

**Input parsing**: Extract the key field from tool input JSON:
- Read/Edit/Write → `file_path`
- Grep → `pattern` + `path`
- Glob → `pattern`
- Bash → `command` (first 100 chars)
- Agent → `description`
- Skill → `skill` name

### 2. Thinking Summary

- **First sentence** shown as one-liner under the request header (dimmed, italic)
- Click to expand full thinking text
- Interleaved thinking (between tool calls) shown inline at the position it appeared
- If thinking is redacted: show `[thinking — redacted by API]` in grey

### 3. Request Type Badges

Color-coded pill badges on each request header:

- 💬 **Chat** (grey) — no tool calls
- 🔧 **Tools** (blue) — has tool calls
- 🤖 **Agent** (purple) — spawned subagent
- ⚡ **Command** (orange) — Bash tool call present
- 📝 **Edit** (green) — Edit/Write tool call present
- 🔍 **Search** (cyan) — Grep/Glob/Read tool call present

A request can have multiple badges.

### 4. Session Summary Bar

Sticky bar at top of each session view:

```
⏱ 45s  |  💰 $0.12  |  📊 3.2k tok  |  🔧 8 tools  |  📖 4 reads  |  ⚡ 2 cmds  |  🤖 1 agent
```

### 5. Cost Breakdown Per Request

Thin bar under each request header showing token distribution:
- Purple segment = thinking tokens
- Blue segment = input tokens
- Green segment = output tokens
- Cache badge if cache_read_tokens > 0: `💾 saved $X.XX`

### 6. Bash Command Viewer

When a Bash tool call is detected, render it prominently:
```
⚡ npm run build
   → exit 0
```
Show first 3 lines of output if available. Expand for full output.

### 7. "What Claude Sees" — Context Panel

Collapsible section per session (or per request) showing:

**System Prompt** (collapsed by default):
- First line shown as preview
- Click to expand full system prompt
- Helps user tune their system prompts, MCP tool descriptions, skill prompts

**Tools Available**:
- List of tool names with descriptions (collapsed)
- Count badge: "42 tools available"
- Helps user see which MCP tools are registered and their descriptions

**Auth Info** (hidden by default):
- "🔑 API Key" button
- Click reveals masked key: `sk-ant-oat01-****...****abcd`
- Shows key type badge: `OAuth` / `API Key`
- Helps user verify which account is being used

**Model & Config**:
- Model requested vs model routed
- Thinking config: `adaptive` / `enabled` / `off`
- Token budget info if present

## Data Model Changes

### CapturedRequest — expanded fields

```typescript
interface CapturedRequest {
  // ... existing fields ...

  // NEW: Full system prompt (not truncated)
  systemPrompt: string;

  // NEW: Full tools list with descriptions
  toolDefinitions: ToolDefinition[];

  // NEW: Auth info (masked)
  authType: 'oauth' | 'api-key' | 'none';
  authKeyPreview: string;  // "sk-ant-oat01-****...abcd"

  // NEW: Parsed tool call details
  toolCalls: ParsedToolCall[];

  // NEW: Model config
  thinkingConfig: string;  // "adaptive", "enabled", etc.
  maxTokens: number;
}

interface ToolDefinition {
  name: string;
  description: string;  // first 100 chars
}

interface ParsedToolCall {
  name: string;
  icon: string;           // emoji
  displayName: string;    // human-readable
  summary: string;        // "src/auth.ts (lines 1-50)"
  inputPreview: string;   // raw JSON first 200 chars
  outputPreview: string;
}
```

## Implementation

### Capture Layer Changes (`src/capture.ts` + `src/standalone-proxy.ts`)

1. Capture full system prompt (remove 200-char truncation)
2. Capture tool definitions from request body `tools[]` array
3. Capture auth header (mask middle of key)
4. Capture thinking config and max_tokens from request body
5. Parse tool call inputs into human-readable summaries

### Dashboard Changes (`src/dashboard-live.ts`)

1. Tool call visualization with icons + parsed summaries
2. Thinking summary (first sentence + expandable)
3. Request type badges
4. Session summary bar
5. Cost breakdown bar
6. Bash command viewer
7. Context panel (system prompt, tools, auth, model config)

## What We Skip

- Skill detection (complex parsing, low immediate value)
- Decision flow visualization (too ambitious for now)
- Syntax highlighting (later)
- Markdown rendering (later)
