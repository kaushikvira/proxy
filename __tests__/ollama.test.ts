/**
 * Tests for Ollama Local Model Provider
 *
 * Covers:
 * - Health checking and availability detection
 * - Routing decision logic (complexity, taskType, model matching)
 * - Message format conversion (OpenAI → Ollama)
 * - Request building
 * - Response conversion (Ollama → OpenAI, non-streaming)
 * - Stream chunk conversion (Ollama NDJSON → OpenAI SSE)
 * - Model resolution and mapping
 * - Fallback behavior when Ollama is unavailable
 * - Config edge cases
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  checkOllamaHealth,
  checkOllamaHealthCached,
  clearOllamaHealthCache,
  shouldRouteToOllama,
  resolveOllamaModel,
  convertMessagesToOllama,
  buildOllamaRequest,
  convertOllamaResponse,
  convertOllamaStreamChunk,
  forwardToOllama,
  forwardToOllamaStream,
  mapCloudModelToOllama,
  OLLAMA_DEFAULTS,
  CLOUD_TO_OLLAMA_MODEL_MAP,
  type OllamaProviderConfig,
} from '../src/ollama.js';

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
// shouldRouteToOllama
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldRouteToOllama', () => {
  it('returns false when disabled', () => {
    const config = makeConfig({ enabled: false });
    expect(shouldRouteToOllama(config, 'simple')).toBe(false);
  });

  it('routes when complexity matches routeWhen.complexity', () => {
    const config = makeConfig({ routeWhen: { complexity: ['simple'] } });
    expect(shouldRouteToOllama(config, 'simple')).toBe(true);
    expect(shouldRouteToOllama(config, 'moderate')).toBe(false);
    expect(shouldRouteToOllama(config, 'complex')).toBe(false);
  });

  it('routes when model name matches an Ollama model', () => {
    const config = makeConfig();
    expect(shouldRouteToOllama(config, 'complex', 'general', 'llama3.2')).toBe(true);
    expect(shouldRouteToOllama(config, 'complex', 'general', 'codestral')).toBe(true);
  });

  it('routes when model is prefixed with ollama/', () => {
    const config = makeConfig();
    expect(shouldRouteToOllama(config, 'complex', 'general', 'ollama/mistral')).toBe(true);
  });

  it('does not route when no conditions match', () => {
    const config = makeConfig({ routeWhen: { complexity: ['simple'] } });
    expect(shouldRouteToOllama(config, 'complex', 'code_generation', 'gpt-4o')).toBe(false);
  });

  it('routes when taskType matches routeWhen.taskTypes', () => {
    const config = makeConfig({ routeWhen: { taskTypes: ['question_answering'] } });
    expect(shouldRouteToOllama(config, 'complex', 'question_answering')).toBe(true);
    expect(shouldRouteToOllama(config, 'complex', 'code_generation')).toBe(false);
  });

  it('routes when both complexity and taskType are configured', () => {
    const config = makeConfig({
      routeWhen: { complexity: ['simple'], taskTypes: ['question_answering'] },
    });
    // Either condition matching should trigger routing
    expect(shouldRouteToOllama(config, 'simple', 'code_generation')).toBe(true);
    expect(shouldRouteToOllama(config, 'complex', 'question_answering')).toBe(true);
    expect(shouldRouteToOllama(config, 'complex', 'code_generation')).toBe(false);
  });

  it('returns false when no routeWhen is configured and model does not match', () => {
    const config = makeConfig({ routeWhen: undefined });
    expect(shouldRouteToOllama(config, 'simple', 'general', 'gpt-4o')).toBe(false);
  });

  it('returns true for model match even without routeWhen', () => {
    const config = makeConfig({ routeWhen: undefined });
    expect(shouldRouteToOllama(config, 'simple', 'general', 'llama3.2')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveOllamaModel
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveOllamaModel', () => {
  it('strips ollama/ prefix', () => {
    const config = makeConfig();
    expect(resolveOllamaModel('ollama/llama3.2', config)).toBe('llama3.2');
    expect(resolveOllamaModel('ollama/mistral', config)).toBe('mistral');
  });

  it('returns model directly if in configured models list', () => {
    const config = makeConfig();
    expect(resolveOllamaModel('codestral', config)).toBe('codestral');
  });

  it('returns defaultModel when model is unknown', () => {
    const config = makeConfig({ defaultModel: 'llama3.2' });
    expect(resolveOllamaModel('claude-sonnet-4-6', config)).toBe('llama3.2');
  });

  it('returns first configured model when no defaultModel', () => {
    const config = makeConfig({ defaultModel: undefined, models: ['codestral', 'llama3.2'] });
    expect(resolveOllamaModel('unknown-model', config)).toBe('codestral');
  });

  it('returns the input model as fallback when no models configured', () => {
    const config = makeConfig({ defaultModel: undefined, models: [] });
    expect(resolveOllamaModel('some-model', config)).toBe('some-model');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// convertMessagesToOllama
// ─────────────────────────────────────────────────────────────────────────────

describe('convertMessagesToOllama', () => {
  it('converts simple text messages', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result).toEqual([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
  });

  it('flattens multimodal content blocks to text', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this:' },
          { type: 'image_url', url: 'https://example.com/img.png' },
          { type: 'text', text: 'What is it?' },
        ],
      },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result).toEqual([
      { role: 'user', content: 'Look at this:\nWhat is it?' },
    ]);
  });

  it('maps tool role to user', () => {
    const messages = [
      { role: 'tool', content: '{"result": 42}', tool_call_id: 'call_1' },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.content).toBe('{"result": 42}');
  });

  it('handles empty content gracefully', () => {
    const messages = [
      { role: 'user', content: '' },
      { role: 'assistant', content: null as unknown as string },
    ];
    const result = convertMessagesToOllama(messages);
    expect(result[0]!.content).toBe('');
    expect(result[1]!.content).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildOllamaRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOllamaRequest', () => {
  it('builds a basic non-streaming request', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const req = buildOllamaRequest('llama3.2', messages, false);
    
    expect(req.model).toBe('llama3.2');
    expect(req.stream).toBe(false);
    expect(req.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(req.options).toBeUndefined();
  });

  it('sets streaming flag', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const req = buildOllamaRequest('codestral', messages, true);
    expect(req.stream).toBe(true);
  });

  it('maps temperature and max_tokens to Ollama options', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const req = buildOllamaRequest('llama3.2', messages, false, {
      temperature: 0.7,
      max_tokens: 1024,
    });
    expect(req.options?.temperature).toBe(0.7);
    expect(req.options?.num_predict).toBe(1024);
  });

  it('passes through tools', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: {} } }];
    const req = buildOllamaRequest('llama3.2', messages, false, { tools });
    expect(req.tools).toEqual(tools);
  });

  it('does not include options when no temperature or max_tokens', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const req = buildOllamaRequest('llama3.2', messages, false, {});
    expect(req.options).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// convertOllamaResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('convertOllamaResponse', () => {
  it('converts a basic text response to OpenAI format', () => {
    const ollamaResp = {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'Hello, world!' },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };

    const result = convertOllamaResponse(ollamaResp, 'llama3.2');
    
    expect(result['object']).toBe('chat.completion');
    expect(result['model']).toBe('llama3.2');
    
    const choices = result['choices'] as Array<{ message: { content: string }; finish_reason: string }>;
    expect(choices).toHaveLength(1);
    expect(choices[0]!.message.content).toBe('Hello, world!');
    expect(choices[0]!.finish_reason).toBe('stop');
    
    const usage = result['usage'] as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it('converts tool calls response', () => {
    const ollamaResp = {
      model: 'llama3.2',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'get_weather',
              arguments: { location: 'London' },
            },
          },
        ],
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 10,
    };

    const result = convertOllamaResponse(ollamaResp, 'llama3.2');
    
    const choices = result['choices'] as Array<{
      message: { tool_calls?: Array<{ type: string; function: { name: string; arguments: string } }> };
      finish_reason: string;
    }>;
    expect(choices[0]!.finish_reason).toBe('tool_calls');
    expect(choices[0]!.message.tool_calls).toHaveLength(1);
    expect(choices[0]!.message.tool_calls![0]!.type).toBe('function');
    expect(choices[0]!.message.tool_calls![0]!.function.name).toBe('get_weather');
    expect(JSON.parse(choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual({ location: 'London' });
  });

  it('handles missing usage counts gracefully', () => {
    const ollamaResp = {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'Hi' },
      done: true,
    };

    const result = convertOllamaResponse(ollamaResp, 'llama3.2');
    const usage = result['usage'] as { prompt_tokens: number; completion_tokens: number };
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// convertOllamaStreamChunk
// ─────────────────────────────────────────────────────────────────────────────

describe('convertOllamaStreamChunk', () => {
  it('converts first chunk with role', () => {
    const chunk = {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'Hel' },
      done: false,
    };

    const result = convertOllamaStreamChunk(chunk, 'chatcmpl-test-1', true);
    expect(result).toContain('data: ');
    expect(result).toContain('"role":"assistant"');
    expect(result).toContain('"content":"Hel"');
  });

  it('converts subsequent chunks without role', () => {
    const chunk = {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'lo' },
      done: false,
    };

    const result = convertOllamaStreamChunk(chunk, 'chatcmpl-test-1', false);
    expect(result).not.toContain('"role"');
    expect(result).toContain('"content":"lo"');
  });

  it('converts final chunk with finish_reason stop', () => {
    const chunk = {
      model: 'llama3.2',
      message: { role: 'assistant', content: '' },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };

    const result = convertOllamaStreamChunk(chunk, 'chatcmpl-test-1', false);
    expect(result).toContain('"finish_reason":"stop"');
    expect(result).toContain('"prompt_tokens":10');
    expect(result).toContain('"completion_tokens":5');
  });

  it('returns valid SSE format', () => {
    const chunk = {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'test' },
      done: false,
    };

    const result = convertOllamaStreamChunk(chunk, 'msg-1', false);
    expect(result).toMatch(/^data: \{.*\}\n\n$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapCloudModelToOllama
// ─────────────────────────────────────────────────────────────────────────────

describe('mapCloudModelToOllama', () => {
  it('maps known Anthropic models to Ollama equivalents', () => {
    const config = makeConfig({ models: ['llama3.2'] });
    expect(mapCloudModelToOllama('claude-sonnet-4-6', config)).toBe('llama3.2');
    expect(mapCloudModelToOllama('claude-opus-4-6', config)).toBe('llama3.2');
    expect(mapCloudModelToOllama('claude-haiku-4-5', config)).toBe('llama3.2');
  });

  it('maps known OpenAI models to Ollama equivalents', () => {
    const config = makeConfig({ models: ['llama3.2'] });
    expect(mapCloudModelToOllama('gpt-4o', config)).toBe('llama3.2');
    expect(mapCloudModelToOllama('gpt-4o-mini', config)).toBe('llama3.2');
  });

  it('uses configured defaultModel for unknown models', () => {
    const config = makeConfig({ defaultModel: 'codestral' });
    expect(mapCloudModelToOllama('unknown-model', config)).toBe('codestral');
  });

  it('uses first configured model when no defaultModel', () => {
    const config = makeConfig({ defaultModel: undefined, models: ['codestral', 'llama3.2'] });
    expect(mapCloudModelToOllama('unknown-model', config)).toBe('codestral');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkOllamaHealth (with fetch mock)
// ─────────────────────────────────────────────────────────────────────────────

describe('checkOllamaHealth', () => {
  beforeEach(() => {
    clearOllamaHealthCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns available=true when Ollama responds with model list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: 'llama3.2:latest', model: 'llama3.2', modified_at: '', size: 0 },
            { name: 'codestral:latest', model: 'codestral', modified_at: '', size: 0 },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await checkOllamaHealth('http://localhost:11434', 5000);
    expect(result.available).toBe(true);
    expect(result.models).toEqual(['llama3.2', 'codestral']);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns available=false when Ollama returns error status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Server Error', { status: 500 }),
    );

    const result = await checkOllamaHealth('http://localhost:11434', 5000);
    expect(result.available).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns available=false on connection error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );

    const result = await checkOllamaHealth('http://localhost:11434', 5000);
    expect(result.available).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns available=false on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new DOMException('The operation was aborted', 'AbortError'),
    );

    const result = await checkOllamaHealth('http://localhost:11434', 100);
    expect(result.available).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('strips :latest suffix from model names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ name: 'llama3.2:latest', model: 'llama3.2', modified_at: '', size: 0 }],
        }),
        { status: 200 },
      ),
    );

    const result = await checkOllamaHealth();
    expect(result.models).toEqual(['llama3.2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkOllamaHealthCached
// ─────────────────────────────────────────────────────────────────────────────

describe('checkOllamaHealthCached', () => {
  beforeEach(() => {
    clearOllamaHealthCache();
    vi.restoreAllMocks();
  });

  it('caches results for subsequent calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ name: 'llama3.2', model: 'llama3.2', modified_at: '', size: 0 }] }),
        { status: 200 },
      ),
    );

    await checkOllamaHealthCached();
    await checkOllamaHealthCached();
    await checkOllamaHealthCached();

    // Only one fetch call because of caching
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardToOllama (with fetch mock)
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardToOllama', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with converted response on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        }),
        { status: 200 },
      ),
    );

    const result = await forwardToOllama(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const choices = result.data!['choices'] as Array<{ message: { content: string } }>;
    expect(choices[0]!.message.content).toBe('Hello!');
    expect(result.usage?.prompt_tokens).toBe(5);
    expect(result.usage?.completion_tokens).toBe(3);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error on non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('model not found', { status: 404 }),
    );

    const result = await forwardToOllama(
      'nonexistent-model',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(404);
    expect(result.error!.code).toBe('ollama_404');
  });

  it('returns connection error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );

    const result = await forwardToOllama(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ollama_connection_error');
    expect(result.error!.retryable).toBe(true);
  });

  it('returns timeout error on AbortError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new DOMException('The operation was aborted', 'AbortError'),
    );

    const result = await forwardToOllama(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
      { timeoutMs: 100 },
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ollama_timeout');
    expect(result.error!.status).toBe(408);
    expect(result.error!.retryable).toBe(true);
  });

  it('passes through options to Ollama request', async () => {
    let capturedBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Ok' },
          done: true,
        }),
        { status: 200 },
      );
    });

    await forwardToOllama(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
      { temperature: 0.5, max_tokens: 512, baseUrl: 'http://custom:11434' },
    );

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    expect(body.options.temperature).toBe(0.5);
    expect(body.options.num_predict).toBe(512);
    expect(body.stream).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardToOllamaStream (with fetch mock)
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardToOllamaStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error on non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('model not found', { status: 404 }),
    );

    const result = await forwardToOllamaStream(
      'nonexistent-model',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(404);
  });

  it('returns connection error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );

    const result = await forwardToOllamaStream(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('ollama_connection_error');
    expect(result.error!.retryable).toBe(true);
  });

  it('returns success with stream generator on 200', async () => {
    // Create a readable stream that simulates Ollama NDJSON output
    const ndjsonChunks = [
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: 'He' }, done: false }) + '\n',
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: 'llo' }, done: false }) + '\n',
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 5, eval_count: 3 }) + '\n',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of ndjsonChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, { status: 200 }),
    );

    const result = await forwardToOllamaStream(
      'llama3.2',
      [{ role: 'user', content: 'Hi' }],
    );

    expect(result.success).toBe(true);
    expect(result.stream).toBeDefined();

    // Collect all SSE events
    const events: string[] = [];
    for await (const event of result.stream!) {
      events.push(event);
    }

    // Should have: first chunk with role, second chunk, done chunk, [DONE]
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]).toContain('"role":"assistant"');
    expect(events[0]).toContain('"content":"He"');
    expect(events[events.length - 1]).toBe('data: [DONE]\n\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────