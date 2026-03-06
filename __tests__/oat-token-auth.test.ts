/**
 * Regression test: oat tokens must use x-api-key, not Authorization: Bearer
 *
 * Bug: buildAnthropicHeadersWithAuth was sending sk-ant-oat* tokens as
 *   Authorization: Bearer <token>
 * which Anthropic rejects with "OAuth authentication is currently not supported."
 *
 * Fix: all Anthropic token types (sk-ant-api*, sk-ant-oat*) use x-api-key header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageRoot = join(__dirname, '..');

describe('oat token auth fix — dist/standalone-proxy.js', () => {
  const distPath = join(packageRoot, 'dist', 'standalone-proxy.js');

  it('buildAnthropicHeadersWithAuth extracts token from Bearer and sets x-api-key', () => {
    const content = readFileSync(distPath, 'utf-8');

    // Find the buildAnthropicHeadersWithAuth function body in the compiled output
    const fnIndex = content.indexOf('buildAnthropicHeadersWithAuth');
    expect(fnIndex).toBeGreaterThan(-1);

    // The fix: Bearer header is stripped and token is sent as x-api-key
    // Look for the pattern: replace Bearer prefix and assign to x-api-key
    expect(content).toContain("replace(/^Bearer\\s+/i, '')");
    expect(content).toContain("headers['x-api-key'] = token");
  });

  it('does not send oat tokens as Authorization: Bearer to Anthropic', () => {
    const content = readFileSync(distPath, 'utf-8');

    // Extract the buildAnthropicHeadersWithAuth function region
    const fnStart = content.indexOf('buildAnthropicHeadersWithAuth');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the end of this function by looking for the next top-level function
    // We'll check a reasonable window around the function definition
    const fnRegion = content.slice(fnStart, fnStart + 2000);

    // The function must NOT set Authorization: Bearer for incoming auth headers
    // (it should strip Bearer and use x-api-key instead)
    expect(fnRegion).not.toMatch(/headers\[.Authorization.\]\s*=\s*`Bearer/);
    expect(fnRegion).not.toMatch(/Authorization.*Bearer.*ctx\.authHeader/);
  });

  it('all Anthropic token types use x-api-key in the function comment', () => {
    const content = readFileSync(distPath, 'utf-8');

    // Verify the fix description is present in the compiled output (from the JSDoc)
    expect(content).toContain('sk-ant-oat');
    expect(content).toContain('x-api-key');
  });
});
