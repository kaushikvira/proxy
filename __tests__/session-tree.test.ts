import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTree, type CapturedRequest } from '../src/session-tree.js';

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    parentTraceId: null,
    agentFingerprint: 'abc123',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-6',
    routedModel: 'claude-sonnet-4-6',
    systemPromptPreview: 'You are a helpful assistant',
    userMessage: 'Hello',
    tools: [],
    thinkingContent: 'Let me think about this...',
    responseText: 'Hi there!',
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    thinkingTokens: 20,
    costUsd: 0.001,
    latencyMs: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    success: true,
    finishReason: 'end_turn',
    error: null,
    ...overrides,
  };
}

describe('SessionTree', () => {
  let tree: SessionTree;

  beforeEach(() => {
    tree = new SessionTree();
  });

  it('creates a session on first request', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    const sessions = tree.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-1');
  });

  it('groups requests under same session', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1', id: 'r1' }));
    tree.addRequest(makeRequest({ sessionId: 'sess-1', id: 'r2' }));
    const session = tree.getSession('sess-1');
    expect(session?.requests).toHaveLength(2);
  });

  it('builds subagent as child node when parentTraceId is set', () => {
    tree.addRequest(makeRequest({
      sessionId: 'sess-1',
      id: 'main-1',
      parentTraceId: null,
      agentFingerprint: 'main-fp',
    }));
    tree.addRequest(makeRequest({
      sessionId: 'sess-1',
      id: 'sub-1',
      parentTraceId: 'main-1',
      agentFingerprint: 'sub-fp',
    }));

    const session = tree.getSession('sess-1');
    expect(session?.children).toHaveLength(1);
    expect(session?.children[0].agentFingerprint).toBe('sub-fp');
    expect(session?.children[0].requests).toHaveLength(1);
  });

  it('tracks session as active within timeout', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    const sessions = tree.getSessions();
    expect(sessions[0].isActive).toBe(true);
  });

  it('aggregates cost across session', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1', costUsd: 0.01 }));
    tree.addRequest(makeRequest({ sessionId: 'sess-1', costUsd: 0.02 }));
    const session = tree.getSession('sess-1');
    expect(session?.totalCost).toBeCloseTo(0.03);
    expect(session?.totalRequests).toBe(2);
  });

  it('handles multiple sessions independently', () => {
    tree.addRequest(makeRequest({ sessionId: 'sess-1' }));
    tree.addRequest(makeRequest({ sessionId: 'sess-2' }));
    expect(tree.getSessions()).toHaveLength(2);
  });
});
