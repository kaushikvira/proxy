import { describe, it, expect, beforeEach } from 'vitest';
import { LiveEventBus, resetLiveEventBus } from '../src/live-events.js';
import { SessionTree, resetSessionTree } from '../src/session-tree.js';
import { StreamAccumulator } from '../src/capture.js';

describe('Live Session Integration', () => {
  beforeEach(() => {
    resetLiveEventBus();
    resetSessionTree();
  });

  it('full flow: stream start -> thinking -> text -> end -> appears in tree', () => {
    const bus = new LiveEventBus();
    const tree = new SessionTree();
    const events: string[] = [];

    bus.subscribe((event) => { events.push(event); });

    // Simulate a stream
    const acc = new StreamAccumulator('trace-1', 'sess-1', null);
    acc.onThinkingDelta('Let me analyze ');
    acc.onThinkingDelta('the code...');
    acc.onTextDelta('Here is my analysis.');
    acc.onToolCall('read_file', '{"path":"/src/main.ts"}');

    acc.setRequestMetadata({
      model: 'claude-sonnet-4-6',
      routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: 'You are a coding assistant',
      userMessage: 'Review this code',
      tools: ['read_file'],
      agentFingerprint: 'fp-main',
    });
    acc.setResponseMetadata({
      tokensIn: 1000, tokensOut: 500, thinkingTokens: 200,
      costUsd: 0.005, latencyMs: 1500,
      cacheReadTokens: 100, cacheCreationTokens: 0,
      success: true, finishReason: 'end_turn',
    });

    const captured = acc.finalize();

    // Verify captured data
    expect(captured.thinkingContent).toBe('Let me analyze the code...');
    expect(captured.responseText).toBe('Here is my analysis.');
    expect(captured.toolCalls).toHaveLength(1);
    expect(captured.toolCalls[0].name).toBe('read_file');
    expect(captured.tokensIn).toBe(1000);

    // Manually add to tree (finalize() also adds via singleton, but we test our own tree instance)
    tree.addRequest(captured);

    // Verify tree
    const session = tree.getSession('sess-1');
    expect(session).not.toBeNull();
    expect(session!.requests).toHaveLength(1);
    expect(session!.totalCost).toBeCloseTo(0.005);
  });

  it('subagent requests appear as children in tree', () => {
    const tree = new SessionTree();

    // Main agent request
    tree.addRequest({
      id: 'main-1', sessionId: 'sess-1', parentTraceId: null,
      agentFingerprint: 'fp-main', timestamp: new Date().toISOString(),
      model: 'claude-sonnet-4-6', routedModel: 'claude-sonnet-4-6',
      systemPromptPreview: '', userMessage: 'Fix the bug', tools: [],
      thinkingContent: 'I need to investigate...', responseText: 'Let me check.',
      toolCalls: [], tokensIn: 100, tokensOut: 50, thinkingTokens: 30,
      costUsd: 0.001, latencyMs: 500, cacheReadTokens: 0,
      cacheCreationTokens: 0, success: true, finishReason: 'end_turn', error: null,
    });

    // Subagent request
    tree.addRequest({
      id: 'sub-1', sessionId: 'sess-1', parentTraceId: 'main-1',
      agentFingerprint: 'fp-sub', timestamp: new Date().toISOString(),
      model: 'claude-haiku-4-5', routedModel: 'claude-haiku-4-5',
      systemPromptPreview: '', userMessage: 'Search for auth code', tools: ['grep'],
      thinkingContent: 'Searching the codebase...', responseText: 'Found in src/auth.ts',
      toolCalls: [{ name: 'grep', inputPreview: '{"pattern":"auth"}', outputPreview: '' }],
      tokensIn: 50, tokensOut: 30, thinkingTokens: 10,
      costUsd: 0.0002, latencyMs: 200, cacheReadTokens: 0,
      cacheCreationTokens: 0, success: true, finishReason: 'end_turn', error: null,
    });

    const session = tree.getSession('sess-1');
    expect(session!.requests).toHaveLength(1); // main agent
    expect(session!.children).toHaveLength(1); // one subagent group
    expect(session!.children[0].requests).toHaveLength(1);
    expect(session!.children[0].agentFingerprint).toBe('fp-sub');
    expect(session!.totalCost).toBeCloseTo(0.0012);
  });
});
