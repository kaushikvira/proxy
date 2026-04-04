# n8n Credential Sync

Automatically keeps an n8n Anthropic credential in sync with the token the proxy observes from Claude Code.

## How It Works

The proxy tracks the Anthropic auth token on every proxied request. Two events trigger a sync to n8n:

| Event | When |
|---|---|
| **Startup sync** | Proxy starts → decrypts stored token → immediately PATCHes n8n |
| **Rotation sync** | Proxy detects a new token → PATCHes n8n with the new token |

The token is stored encrypted on disk (AES-256, key derived from machine hostname) so it survives restarts without being plaintext.

## Setup

### 1. Create the Anthropic credential in n8n

In n8n UI: **Credentials → Add → Anthropic**. Save it — note the credential ID from the URL or via the API:

```bash
curl -k -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/credentials" \
  | python3 -c "import json,sys; [print(c['id'], c['name'], c['type']) for c in json.load(sys.stdin)['data']]"
```

### 2. Set environment variables

Add to `~/.../secrets.sh` (or equivalent):

```bash
export N8N_URL="https://your-n8n-instance"
export N8N_API_KEY="your-n8n-api-key"
export N8N_ANTHROPIC_CREDENTIAL_ID="credential-id-from-step-1"
```

### 3. Install the service with the vars sourced

```bash
source secrets.sh
relayplane service install   # or: make service-install
```

This bakes the variables into the launchd plist (macOS) or systemd unit (Linux) so the proxy has access to them even when started automatically at boot.

> **Important:** Re-run `service install` any time you change these variables.

## Files

| File | Purpose |
|---|---|
| `src/n8n-sync.ts` | PATCH logic — reads env vars, calls n8n API |
| `src/token-tracker.ts` | Calls sync on startup and on rotation detection |
| `~/.kv-local-proxy/token-rotations.json` | Persisted token state (encrypted current token + masked history) |

## Logs

```
# stdout (relayplane-proxy.log)
[N8N-SYNC] Updated Anthropic credential (id: LyS7MfHfXW4lv2rc)

# stderr (relayplane-proxy.error.log)
[N8N-SYNC] WARN: N8N_URL / N8N_API_KEY / N8N_ANTHROPIC_CREDENTIAL_ID not set — skipping credential sync
[N8N-SYNC] Failed to update Anthropic credential: HTTP 400 — ...
```

Watch both:

```bash
tail -f ~/Library/Logs/relayplane-proxy.log ~/Library/Logs/relayplane-proxy.error.log | grep 'N8N-SYNC'
```

## Testing

### Force a startup sync test

```bash
# 1. Break the n8n credential
curl -k -s -X PATCH \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {"apiKey": "sk-ant-INVALID", "headerName": "x-api-key", "headerValue": "sk-ant-INVALID"}}' \
  "$N8N_URL/api/v1/credentials/$N8N_ANTHROPIC_CREDENTIAL_ID"

# 2. Restart the proxy — sync fires on startup
make service-restart

# 3. Watch logs
tail -f ~/Library/Logs/relayplane-proxy.log | grep 'N8N-SYNC'
# Expected: [N8N-SYNC] Updated Anthropic credential (id: ...)
```

### Force a rotation sync test

```bash
make test-token-rotation   # corrupts stored hash → triggers rotation on next request
```

## n8n API Credential Schema

The `anthropicApi` credential type in n8n requires all three fields in the `data` object:

```json
{
  "data": {
    "apiKey": "<token>",
    "headerName": "x-api-key",
    "headerValue": "<token>"
  }
}
```

## Security Notes

- The token is encrypted with AES-256-CBC using a key derived from `hostname + fixed salt`
- History entries on disk are always masked (`sk-ant-oat0****...abc1`)
- The encryption is machine-specific — the file cannot be decrypted on a different machine
- `token-rotations.json` is written with mode `0600` (owner read/write only)
- The n8n API key is stored in the launchd/systemd service config, not in application files
