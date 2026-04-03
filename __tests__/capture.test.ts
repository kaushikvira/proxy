import { describe, it, expect, beforeEach } from 'vitest';
import { StreamAccumulator } from '../src/capture.js';

describe('StreamAccumulator', () => {
  let acc: StreamAccumulator;

  beforeEach(() => {
    acc = new StreamAccumulator('trace-1', 'sess-1', null);
  });

  it('accumulates thinking deltas', () => {
    acc.onThinkingDelta('Hello ');
    acc.onThinkingDelta('world');
    expect(acc.getThinkingContent()).toBe('Hello world');
  });

  it('accumulates text deltas', () => {
    acc.onTextDelta('foo ');
    acc.onTextDelta('bar');
    expect(acc.getResponseText()).toBe('foo bar');
  });

  it('records tool calls', () => {
    acc.onToolCall('read_file', '{"path": "/tmp/foo"}');
    const calls = acc.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('finalizes into a CapturedRequest', () => {
    acc.onThinkingDelta('thinking...');
    acc.onTextDelta('response text');
    acc.setRequestMetadata({
      model: 'claude-sonnet-4-6',
      routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: 'You are helpful',
      userMessage: 'Hello',
      tools: [],
      agentFingerprint: 'abc',
    });
    acc.setResponseMetadata({
      tokensIn: 100,
      tokensOut: 50,
      thinkingTokens: 20,
      costUsd: 0.001,
      latencyMs: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      success: true,
      finishReason: 'end_turn',
    });

    const captured = acc.finalize();
    expect(captured.thinkingContent).toBe('thinking...');
    expect(captured.responseText).toBe('response text');
    expect(captured.sessionId).toBe('sess-1');
    expect(captured.tokensIn).toBe(100);
  });

  it('handles empty thinking gracefully', () => {
    acc.onTextDelta('just text');
    acc.setRequestMetadata({
      model: 'm', routedModel: 'm', systemPromptPreview: '',
      userMessage: '', tools: [], agentFingerprint: '',
    });
    acc.setResponseMetadata({
      tokensIn: 0, tokensOut: 0, thinkingTokens: 0, costUsd: 0,
      latencyMs: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      success: true, finishReason: 'end_turn',
    });
    const captured = acc.finalize();
    expect(captured.thinkingContent).toBe('');
  });
});
