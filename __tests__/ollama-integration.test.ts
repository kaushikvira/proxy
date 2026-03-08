/**
 * Integration Tests for Ollama Provider
 *
 * Tests the integration between Ollama routing and the proxy's
 * routing decision layer (complexity, model resolution, fallback).
 * All network calls are mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  shouldRouteToOllama,
  resolveOllamaModel,
  checkOllamaHealth,
  forwardToOllama,
  clearOllamaHealthCache,
  mapCloudModelToOllama,
  CLOUD_TO_OLLAMA_MODEL_MAP,
  OLLAMA_DEFAULTS,
  type OllamaProviderConfig,
} from '../src/ollama.js';
import { classifyComplexity } from '../src/standalone-proxy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<OllamaProviderConfig>): OllamaProviderConfig {
  return {
    baseUrl: 'http://localhost:11434',
    models: ['llama3.2', 'codestral'],
    routeWhen: { complexity: ['simple'] },
    enabled: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// End-to-End Routing Flow (mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('Ollama routing flow (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearOllamaHealthCache();
  });

  it('routes simple question to Ollama and gets valid OpenAI response', async () => {
    const config = makeConfig({ routeWhen: { complexity: ['simple'] } });
    const messages = [{ role: 'user', content: 'What is 2+2?' }];

    // 1. Classify complexity
    const complexity = classifyComplexity(messages.map(m => ({ ...m })));
    expect(complexity).toBe('simple');

    // 2. Check routing decision
    const shouldRoute = shouldRouteToOllama(config, complexity, 'question_answering');
    expect(shouldRoute).toBe(true);

    // 3. Resolve model
    const model = resolveOllamaModel('claude-sonnet-4-6', config);
    expect(model).toBe('llama3.2'); // Falls to default model

    // 4. Mock Ollama response and forward
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: '4' },
          done: true,
          prompt_eval_count: 8,
          eval_count: 1,
        }),
        { status: 200 },
      ),
    );

    const result = await forwardToOllama('llama3.2', messages, { baseUrl: config.baseUrl });
    expect(result.success).toBe(true);

    // 5. Verify OpenAI-compatible response format
    const data = result.data!;
    expect(data['object']).toBe('chat.completion');
    expect(data['model']).toBe('llama3.2');
    const choices = data['choices'] as Array<{ message: { content: string }; finish_reason: string }>;
    expect(choices[0]!.message.content).toBe('4');
    expect(choices[0]!.finish_reason).toBe('stop');
  });

  it('does NOT route complex code generation to Ollama', () => {
    const config = makeConfig({ routeWhen: { complexity: ['simple'] } });
    const messages = [
      {
        role: 'user',
        content: 'Implement a distributed consensus algorithm with Raft protocol. Include leader election, log replication, and snapshot handling. Build the architecture from scratch.',
      },
    ];

    const complexity = classifyComplexity(messages.map(m => ({ ...m })));
    // This should be classified as complex
    expect(['moderate', 'complex']).toContain(complexity);

    // Should NOT route to Ollama
    const shouldRoute = shouldRouteToOllama(config, complexity, 'code_generation');
    expect(shouldRoute).toBe(false);
  });

  it('falls back to cloud when Ollama is unavailable', async () => {
    const config = makeConfig();

    // Mock Ollama health check failure
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    
    const health = await checkOllamaHealth(config.baseUrl);
    expect(health.available).toBe(false);

    // The proxy should fall back to cloud provider
    // (In the actual proxy, this happens in the routing intercept)
    // Here we verify health check returns unavailable
    expect(health.error).toContain('ECONNREFUSED');
  });

  it('routes direct Ollama model request regardless of complexity', () => {
    const config = makeConfig();

    // Requesting "ollama/llama3.2" directly should always route to Ollama
    const shouldRoute = shouldRouteToOllama(config, 'complex', 'code_generation', 'ollama/llama3.2');
    expect(shouldRoute).toBe(true);

    const model = resolveOllamaModel('ollama/llama3.2', config);
    expect(model).toBe('llama3.2');
  });

  it('routes by task type when configured', () => {
    const config = makeConfig({
      routeWhen: {
        taskTypes: ['question_answering', 'translation'],
      },
    });

    expect(shouldRouteToOllama(config, 'moderate', 'question_answering')).toBe(true);
    expect(shouldRouteToOllama(config, 'moderate', 'translation')).toBe(true);
    expect(shouldRouteToOllama(config, 'moderate', 'code_generation')).toBe(false);
    expect(shouldRouteToOllama(config, 'moderate', 'analysis')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud-to-Ollama Model Mapping Coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('CLOUD_TO_OLLAMA_MODEL_MAP', () => {
  it('covers all major Anthropic models', () => {
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['claude-opus-4-6']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['claude-sonnet-4-6']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['claude-haiku-4-5']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['claude-3-5-sonnet-latest']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['claude-3-5-haiku-latest']).toBeDefined();
  });

  it('covers major OpenAI models', () => {
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['gpt-4o']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['gpt-4o-mini']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['gpt-4.1']).toBeDefined();
  });

  it('covers major Google models', () => {
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['gemini-2.0-flash']).toBeDefined();
    expect(CLOUD_TO_OLLAMA_MODEL_MAP['gemini-2.0-flash-lite']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Ollama config edge cases', () => {
  it('handles empty config gracefully', () => {
    const config: OllamaProviderConfig = {};
    expect(shouldRouteToOllama(config, 'simple')).toBe(false);
    expect(resolveOllamaModel('test', config)).toBe('test');
    expect(mapCloudModelToOllama('claude-sonnet-4-6', config)).toBe('llama3.2'); // built-in fallback
  });

  it('handles config with only baseUrl', () => {
    const config: OllamaProviderConfig = { baseUrl: 'http://gpu-server:11434' };
    expect(shouldRouteToOllama(config, 'simple')).toBe(false);
  });

  it('handles config with multiple complexity levels', () => {
    const config = makeConfig({
      routeWhen: { complexity: ['simple', 'moderate'] },
    });
    expect(shouldRouteToOllama(config, 'simple')).toBe(true);
    expect(shouldRouteToOllama(config, 'moderate')).toBe(true);
    expect(shouldRouteToOllama(config, 'complex')).toBe(false);
  });

  it('handles config with no models list', () => {
    const config = makeConfig({ models: undefined });
    // Should still route based on complexity
    expect(shouldRouteToOllama(config, 'simple')).toBe(true);
    // But model resolution falls through
    const model = resolveOllamaModel('claude-sonnet-4-6', config);
    expect(model).toBe('claude-sonnet-4-6'); // Falls through since no default
  });

  it('respects custom defaultModel over first in list', () => {
    const config = makeConfig({
      models: ['llama3.2', 'codestral', 'mistral'],
      defaultModel: 'mistral',
    });
    const model = resolveOllamaModel('unknown', config);
    expect(model).toBe('mistral');
  });

  it('handles custom baseUrl for remote Ollama', () => {
    const config = makeConfig({ baseUrl: 'http://192.168.1.100:11434' });
    expect(config.baseUrl).toBe('http://192.168.1.100:11434');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OLLAMA_DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe('OLLAMA_DEFAULTS', () => {
  it('has sensible default values', () => {
    expect(OLLAMA_DEFAULTS.baseUrl).toBe('http://localhost:11434');
    expect(OLLAMA_DEFAULTS.timeoutMs).toBe(120_000);
    expect(OLLAMA_DEFAULTS.enabled).toBe(true);
    expect(OLLAMA_DEFAULTS.models).toEqual([]);
  });
});
