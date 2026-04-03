/**
 * Stream capture layer. Accumulates streaming chunks into complete
 * CapturedRequest records and emits real-time events to the live bus.
 */

import { getLiveEventBus } from './live-events.js';
import { getSessionTree, type CapturedRequest, type ToolCallRecord } from './session-tree.js';

interface RequestMetadata {
  model: string;
  routedModel: string;
  systemPromptPreview: string;
  userMessage: string;
  tools: string[];
  agentFingerprint: string;
  // New:
  systemPrompt?: string;
  toolDefinitions?: { name: string; description: string }[];
  authType?: 'oauth' | 'api-key' | 'none';
  authKeyPreview?: string;
  thinkingConfig?: string;
  maxTokens?: number;
}

interface ResponseMetadata {
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  success: boolean;
  finishReason: string;
}

export class StreamAccumulator {
  private thinkingChunks: string[] = [];
  private textChunks: string[] = [];
  private toolCallList: ToolCallRecord[] = [];
  private reqMeta: RequestMetadata | null = null;
  private resMeta: ResponseMetadata | null = null;

  constructor(
    public readonly traceId: string,
    public readonly sessionId: string,
    public readonly parentTraceId: string | null,
  ) {}

  onThinkingDelta(text: string): void {
    this.thinkingChunks.push(text);
    getLiveEventBus().emit('stream.thinking', { traceId: this.traceId, text });
  }

  onTextDelta(text: string): void {
    this.textChunks.push(text);
    getLiveEventBus().emit('stream.text', { traceId: this.traceId, text });
  }

  onToolCall(name: string, inputJson: string): void {
    const record: ToolCallRecord = {
      name,
      inputPreview: inputJson.slice(0, 200),
      inputFull: inputJson,
      outputPreview: '',
    };
    this.toolCallList.push(record);
    getLiveEventBus().emit('stream.tool_call', {
      traceId: this.traceId, name,
      inputPreview: record.inputPreview,
      inputFull: inputJson
    });
  }

  setRequestMetadata(meta: RequestMetadata): void { this.reqMeta = meta; }
  setResponseMetadata(meta: ResponseMetadata): void { this.resMeta = meta; }
  getThinkingContent(): string { return this.thinkingChunks.join(''); }
  getResponseText(): string { return this.textChunks.join(''); }
  getToolCalls(): ToolCallRecord[] { return this.toolCallList; }

  finalize(): CapturedRequest {
    const req: CapturedRequest = {
      id: this.traceId,
      sessionId: this.sessionId,
      parentTraceId: this.parentTraceId,
      agentFingerprint: this.reqMeta?.agentFingerprint ?? '',
      timestamp: new Date().toISOString(),
      model: this.reqMeta?.model ?? '',
      routedModel: this.reqMeta?.routedModel ?? '',
      systemPromptPreview: this.reqMeta?.systemPromptPreview ?? '',
      userMessage: this.reqMeta?.userMessage ?? '',
      tools: this.reqMeta?.tools ?? [],
      thinkingContent: this.getThinkingContent(),
      responseText: this.getResponseText(),
      toolCalls: this.toolCallList,
      tokensIn: this.resMeta?.tokensIn ?? 0,
      tokensOut: this.resMeta?.tokensOut ?? 0,
      thinkingTokens: this.resMeta?.thinkingTokens ?? 0,
      costUsd: this.resMeta?.costUsd ?? 0,
      latencyMs: this.resMeta?.latencyMs ?? 0,
      cacheReadTokens: this.resMeta?.cacheReadTokens ?? 0,
      cacheCreationTokens: this.resMeta?.cacheCreationTokens ?? 0,
      success: this.resMeta?.success ?? false,
      finishReason: this.resMeta?.finishReason ?? '',
      error: null,
      systemPrompt: this.reqMeta?.systemPrompt,
      toolDefinitions: this.reqMeta?.toolDefinitions,
      authType: this.reqMeta?.authType,
      authKeyPreview: this.reqMeta?.authKeyPreview,
      thinkingConfig: this.reqMeta?.thinkingConfig,
      maxTokens: this.reqMeta?.maxTokens,
    };

    getSessionTree().addRequest(req);
    getLiveEventBus().emit('request.captured', req);
    getLiveEventBus().emit('session.updated', {
      sessionId: req.sessionId,
      tree: getSessionTree().getSession(req.sessionId),
    });

    return req;
  }
}

const activeStreams = new Map<string, StreamAccumulator>();

export function startStream(traceId: string, sessionId: string, parentTraceId: string | null, model: string): StreamAccumulator {
  const acc = new StreamAccumulator(traceId, sessionId, parentTraceId);
  activeStreams.set(traceId, acc);
  getLiveEventBus().emit('stream.start', { traceId, sessionId, parentTraceId, model, timestamp: new Date().toISOString() });
  return acc;
}

export function getStream(traceId: string): StreamAccumulator | undefined {
  return activeStreams.get(traceId);
}

export function endStream(traceId: string): CapturedRequest | undefined {
  const acc = activeStreams.get(traceId);
  if (!acc) return undefined;
  activeStreams.delete(traceId);
  // Emit stream.end BEFORE finalize() so the client removes the streaming
  // entry before session.updated adds the completed request (avoids duplicate)
  getLiveEventBus().emit('stream.end', { traceId });
  const captured = acc.finalize();
  return captured;
}
