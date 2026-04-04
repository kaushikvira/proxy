/**
 * n8n Credential Sync
 *
 * Pushes the current Anthropic token to n8n via PATCH /api/v1/credentials/:id.
 * Called on proxy startup (first observed request) and on every token rotation.
 *
 * Config (env vars):
 *   N8N_URL                      — n8n instance URL (e.g. https://n8n.localhost)
 *   N8N_API_KEY                  — n8n API key (X-N8N-API-KEY header)
 *   N8N_ANTHROPIC_CREDENTIAL_ID  — credential ID to update
 */

import * as https from 'node:https';
import * as http from 'node:http';

export async function pushToN8n(newToken: string): Promise<void> {
  const n8nUrl = process.env['N8N_URL'];
  const n8nApiKey = process.env['N8N_API_KEY'];
  const credentialId = process.env['N8N_ANTHROPIC_CREDENTIAL_ID'];

  if (!n8nUrl || !n8nApiKey || !credentialId) {
    console.warn('[N8N-SYNC] WARN: N8N_URL / N8N_API_KEY / N8N_ANTHROPIC_CREDENTIAL_ID not set — skipping credential sync');
    return;
  }

  const body = JSON.stringify({ data: { apiKey: newToken, headerName: 'x-api-key', headerValue: newToken } });
  const url = new URL(`/api/v1/credentials/${credentialId}`, n8nUrl);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': n8nApiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[N8N-SYNC] Updated Anthropic credential (id: ${credentialId})`);
        } else {
          console.error(`[N8N-SYNC] Failed to update Anthropic credential: HTTP ${res.statusCode} — ${data}`);
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error(`[N8N-SYNC] Failed to update Anthropic credential: ${err.message}`);
      resolve();
    });

    req.write(body);
    req.end();
  });
}
