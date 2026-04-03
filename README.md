# Local LLM Proxy

Forked from [@relayplane/proxy](https://github.com/RelayPlane/proxy) (MIT). Modified for **strictly local operation** with all external network calls removed except LLM provider API forwarding.

## Security Policy

This fork enforces a strict security boundary:

**The proxy ONLY makes outbound network calls to LLM providers.** Nothing else. No telemetry, no analytics, no cloud sync, no version checks, no mesh, no phone-home of any kind.

### What was removed from upstream

| Removed | Files affected | Why |
|---------|---------------|-----|
| Cloud telemetry upload to `api.relayplane.com` | `telemetry.ts` | Sent usage metadata to RelayPlane servers |
| Lifecycle events (`proxy.activated`, `proxy.session`, `proxy.dashboard_linked`) | `lifecycle-telemetry.ts` (deleted) | Phoned home on startup and first request |
| Osmosis mesh sync to `osmosis-mesh-dev.fly.dev` | `mesh/sync.ts`, `mesh/index.ts`, `mesh.ts` (deleted), `config.ts` | Shared routing data with external mesh server |
| Swarm routing API calls to `api.relayplane.com/v1/route` | `swarm-client.ts` (gutted) | Sent task metadata to cloud for routing decisions |
| Recovery mesh push/pull to external server | `recovery-mesh.ts` | Shared error recovery patterns externally |
| npm version check to `registry.npmjs.org` | `standalone-proxy.ts`, `cli.ts` | Fetched latest package version on every startup |
| OAuth login flow (`/v1/cli/device/start`, `/poll`) | `cli.ts` | Device auth flow to `api.relayplane.com` |
| Cloud status check (`/v1/cli/teams/current`) | `cli.ts` | Fetched plan/team info from cloud API |
| `@relayplane/core` (closed-source package) | `standalone-proxy.ts`, `index.ts` | Replaced with local open-source stub (`relay-core-stub.ts`) |
| `@relayplane/learning-engine`, `auth-gate`, `ledger`, `policy-engine`, `routing-engine`, `explainability` | `server.ts` (deleted), `package.json` | All closed-source packages removed |
| Telemetry disclosure / signup nudge / star nudge | `cli.ts` | Promotional messages for cloud signup |

### What remains (all local)

- Local telemetry logging to `~/.relayplane/telemetry.jsonl` (never uploaded)
- Local SQLite databases for caching, budget tracking, alerts, sessions
- Local dashboard at `localhost:4100`
- LLM provider API calls (Anthropic, OpenAI, Google Gemini, xAI, OpenRouter, DeepSeek, Groq, Mistral, Together, Fireworks, Perplexity, Ollama)
- Optional user-configured alert webhook (only if you explicitly set `webhookUrl` in config)

### Dependencies (all open-source)

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Local SQLite for caching, budgets, alerts |
| `fastest-levenshtein` | String distance for model name typo suggestions |
| `typescript` (dev) | TypeScript compiler |
| `vitest` (dev) | Test runner |

Zero closed-source dependencies.

### Pulling from upstream

If pulling changes from the upstream RelayPlane repo, apply this checklist:

1. **Grep for `fetch(`** in all changed files. Every new fetch must target an LLM provider or `127.0.0.1`. Block anything else.
2. **Grep for `@relayplane/`** imports. Do not re-introduce closed-source packages.
3. **Grep for `api.relayplane.com`**, `registry.npmjs.org`, `osmosis-mesh`, `fly.dev`**. These must not appear in executable code (comments are fine).
4. **Check `package.json`** for new dependencies. Audit any new package before adding. No `postinstall` or `preinstall` hooks.
5. **Check for new `process.env` reads** — ensure env vars are only used for local config and LLM provider auth, never sent externally.
6. **Run the full audit**: `grep -rn 'fetch(' src/ --include='*.ts'` and verify every result.

---

## What It Does

A local HTTP proxy that sits between your AI agents and LLM providers. Drop-in replacement for OpenAI and Anthropic base URLs.

- Per-request cost tracking across 11 providers
- Cache-aware cost tracking (Anthropic prompt caching)
- Configurable task-aware routing (complexity-based, cascade, model overrides)
- Response caching with SQLite persistence
- Budget enforcement (daily/hourly/per-request limits)
- Anomaly detection (runaway loops, cost spikes)
- Rate limiting per model/provider
- Auto-downgrade when budget thresholds are hit
- Per-agent cost tracking by system prompt fingerprint
- Local dashboard at `localhost:4100`

## Quick Start

```bash
npm install
npm run build
```

Set at least one API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# and/or
export OPENAI_API_KEY="sk-..."
```

Start the proxy:

```bash
npm start
# or
node dist/cli.js start
```

Point your agent at the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:4100 your-agent
OPENAI_BASE_URL=http://localhost:4100 your-agent
```

Dashboard at http://localhost:4100

## Supported Providers

Anthropic, OpenAI, Google Gemini, xAI/Grok, OpenRouter, DeepSeek, Groq, Mistral, Together, Fireworks, Perplexity, Ollama (local)

## Configuration

Config file: `~/.relayplane/config.json`

```json
{
  "enabled": true,
  "routing": {
    "complexity": {
      "enabled": true,
      "simple": "claude-3-5-haiku-latest",
      "moderate": "claude-sonnet-4-20250514",
      "complex": "claude-opus-4-20250514"
    }
  }
}
```

All configuration is optional — sensible defaults are applied.

### Complexity-Based Routing

Classifies requests by complexity (simple/moderate/complex) based on prompt length, token patterns, and tool usage. Each tier maps to a different model.

- **Simple** — short prompts, basic Q&A
- **Moderate** — multi-step reasoning, code review
- **Complex** — architecture decisions, large codebases, many tools

### Model Overrides

```json
{
  "modelOverrides": {
    "claude-opus-4-5": "claude-3-5-haiku",
    "gpt-4o": "gpt-4o-mini"
  }
}
```

### Cascade Mode

Start cheap, escalate on uncertainty or refusal:

```json
{
  "routing": {
    "mode": "cascade",
    "cascade": {
      "enabled": true,
      "models": ["claude-3-5-haiku-latest", "claude-sonnet-4-20250514", "claude-opus-4-20250514"],
      "escalateOn": "uncertainty",
      "maxEscalations": 2
    }
  }
}
```

### Budget Enforcement

```json
{
  "budget": {
    "enabled": true,
    "dailyUsd": 50,
    "hourlyUsd": 10,
    "perRequestUsd": 2,
    "onBreach": "downgrade",
    "downgradeTo": "claude-sonnet-4-6"
  }
}
```

### Response Cache

```json
{
  "cache": {
    "enabled": true,
    "mode": "exact",
    "maxSizeMb": 100,
    "defaultTtlSeconds": 3600
  }
}
```

### Auto-Downgrade

When budget hits a threshold, automatically switch to cheaper models:

```json
{
  "downgrade": {
    "enabled": true,
    "thresholdPercent": 80,
    "mapping": {
      "claude-opus-4-6": "claude-sonnet-4-6",
      "gpt-4o": "gpt-4o-mini"
    }
  }
}
```

### Provider Cooldowns

```json
{
  "reliability": {
    "cooldowns": {
      "enabled": true,
      "allowedFails": 3,
      "windowSeconds": 60,
      "cooldownSeconds": 120
    }
  }
}
```

### Anomaly Detection

```json
{
  "anomaly": {
    "enabled": true,
    "velocityThreshold": 50,
    "tokenExplosionUsd": 5.0,
    "repetitionThreshold": 20,
    "windowMs": 300000
  }
}
```

### Cost Alerts

```json
{
  "alerts": {
    "enabled": true,
    "webhookUrl": "https://your-webhook-url.com/...",
    "cooldownMs": 300000
  }
}
```

Note: `webhookUrl` is the only user-configured outbound call. Only set this if you want alert notifications delivered to an external endpoint you control.

## CLI Reference

| Command | Description |
|---------|-------------|
| `start` | Start the proxy server |
| `init` | Initialize config |
| `status` | Show proxy status |
| `stats` | Show usage statistics and savings |
| `telemetry on\|off\|status` | Manage local telemetry |
| `budget status\|set\|reset` | Manage spend limits |
| `alerts list\|counts` | View alert history |
| `cache status\|stats\|clear\|on\|off` | Manage response cache |
| `service install\|uninstall\|status` | System service management |

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4100` | Port to listen on |
| `--host <s>` | `127.0.0.1` | Host to bind to |
| `-v, --verbose` | - | Verbose logging |

## Architecture

```
Client (Claude Code / Cursor / any agent)
        |
        |  OpenAI/Anthropic-compatible request
        v
+-------------------------------------------------------+
| Local Proxy (localhost:4100)                           |
|-------------------------------------------------------|
| 1) Parse request                                      |
| 2) Cache check → HIT = return cached (skip provider)  |
| 3) Budget check → BREACH = block/warn/downgrade       |
| 4) Anomaly detection → DETECTED = alert               |
| 5) Auto-downgrade (if budget threshold exceeded)      |
| 6) Classify task complexity                            |
| 7) Select model (explicit / complexity / cascade)     |
| 8) Forward request to LLM provider                    |
| 9) Return response + cache it                         |
| 10) Record cost locally                               |
+-------------------------------------------------------+
        |
        v
LLM Provider APIs (Anthropic/OpenAI/Gemini/xAI/...)
```

No data leaves this machine except the LLM API calls themselves.

## License

[MIT](LICENSE) — forked from [RelayPlane/proxy](https://github.com/RelayPlane/proxy)
