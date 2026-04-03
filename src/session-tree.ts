/**
 * In-memory session tree. Groups requests by session ID and builds
 * parent/child relationships for subagent visualization.
 */

export interface ToolCallRecord {
  name: string;
  inputPreview: string;
  outputPreview: string;
}

export interface CapturedRequest {
  id: string;
  sessionId: string;
  parentTraceId: string | null;
  agentFingerprint: string;
  timestamp: string;
  model: string;
  routedModel: string;
  systemPromptPreview: string;
  userMessage: string;
  tools: string[];
  thinkingContent: string;
  responseText: string;
  toolCalls: ToolCallRecord[];
  tokensIn: number;
  tokensOut: number;
  thinkingTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  success: boolean;
  finishReason: string;
  error: string | null;
}

export interface SessionNode {
  sessionId: string;
  agentFingerprint: string;
  agentLabel: string;
  parentTraceId: string | null;
  children: SessionNode[];
  requests: CapturedRequest[];
  isActive: boolean;
  totalCost: number;
  totalRequests: number;
  lastSeenAt: number;
}

const ACTIVE_TIMEOUT_MS = 60_000;
const MAX_SESSIONS = 100;

export class SessionTree {
  private sessions = new Map<string, SessionNode>();

  addRequest(req: CapturedRequest): void {
    let root = this.sessions.get(req.sessionId);
    if (!root) {
      root = this.createNode(req.sessionId, req.agentFingerprint, null, 'Main Agent');
      this.sessions.set(req.sessionId, root);
      this.evictOldSessions();
    }

    if (req.parentTraceId) {
      let child = root.children.find(c => c.agentFingerprint === req.agentFingerprint);
      if (!child) {
        child = this.createNode(
          req.sessionId,
          req.agentFingerprint,
          req.parentTraceId,
          `Subagent ${root.children.length + 1}`,
        );
        root.children.push(child);
      }
      child.requests.push(req);
      child.totalCost += req.costUsd;
      child.totalRequests++;
      child.lastSeenAt = Date.now();
    } else {
      root.requests.push(req);
    }

    root.totalCost += req.costUsd;
    root.totalRequests++;
    root.lastSeenAt = Date.now();
  }

  getSession(sessionId: string): SessionNode | null {
    const node = this.sessions.get(sessionId) ?? null;
    if (node) {
      node.isActive = Date.now() - node.lastSeenAt < ACTIVE_TIMEOUT_MS;
      for (const child of node.children) {
        child.isActive = Date.now() - child.lastSeenAt < ACTIVE_TIMEOUT_MS;
      }
    }
    return node;
  }

  getSessions(): SessionNode[] {
    const now = Date.now();
    const result: SessionNode[] = [];
    for (const node of this.sessions.values()) {
      node.isActive = now - node.lastSeenAt < ACTIVE_TIMEOUT_MS;
      result.push(node);
    }
    result.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastSeenAt - a.lastSeenAt;
    });
    return result;
  }

  private createNode(
    sessionId: string,
    agentFingerprint: string,
    parentTraceId: string | null,
    agentLabel: string,
  ): SessionNode {
    return {
      sessionId,
      agentFingerprint,
      agentLabel,
      parentTraceId,
      children: [],
      requests: [],
      isActive: true,
      totalCost: 0,
      totalRequests: 0,
      lastSeenAt: Date.now(),
    };
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    let oldest: { key: string; time: number } | null = null;
    for (const [key, node] of this.sessions) {
      if (!node.isActive && (!oldest || node.lastSeenAt < oldest.time)) {
        oldest = { key, time: node.lastSeenAt };
      }
    }
    if (oldest) this.sessions.delete(oldest.key);
  }
}

let _tree: SessionTree | null = null;

export function getSessionTree(): SessionTree {
  if (!_tree) _tree = new SessionTree();
  return _tree;
}

export function resetSessionTree(): void {
  _tree = null;
}
