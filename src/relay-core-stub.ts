/**
 * Local replacement for @relayplane/core
 *
 * Provides the same types and functions that standalone-proxy.ts
 * imported from the closed-source @relayplane/core package.
 * Everything here is pure local logic — zero network calls.
 */

export type TaskType =
  | 'code_generation'
  | 'code_review'
  | 'summarization'
  | 'analysis'
  | 'creative_writing'
  | 'data_extraction'
  | 'translation'
  | 'question_answering'
  | 'general';

export type Provider = 'anthropic' | 'openai' | 'google' | 'xai' | 'local';

/**
 * Infer task type from prompt text using keyword heuristics.
 */
export function inferTaskType(prompt: string): TaskType {
  const lower = prompt.toLowerCase();

  if (/\b(write|generate|create|implement|build|code|function|class|module)\b/.test(lower) &&
      /\b(code|function|class|component|api|endpoint|script|program)\b/.test(lower)) {
    return 'code_generation';
  }
  if (/\b(review|audit|check|inspect|analyze)\b/.test(lower) &&
      /\b(code|pull request|pr|diff|commit|implementation)\b/.test(lower)) {
    return 'code_review';
  }
  if (/\b(summarize|summary|tldr|brief|overview|condense)\b/.test(lower)) {
    return 'summarization';
  }
  if (/\b(analyze|analysis|evaluate|assess|examine|investigate)\b/.test(lower)) {
    return 'analysis';
  }
  if (/\b(write|compose|draft|create)\b/.test(lower) &&
      /\b(story|poem|essay|blog|article|content|copy)\b/.test(lower)) {
    return 'creative_writing';
  }
  if (/\b(extract|parse|scrape|pull out|find all)\b/.test(lower) &&
      /\b(data|information|fields|values|entities|names|emails)\b/.test(lower)) {
    return 'data_extraction';
  }
  if (/\b(translate|translation|convert to|in \w+ language)\b/.test(lower)) {
    return 'translation';
  }
  if (/\b(what|why|how|when|where|who|explain|tell me|describe)\b/.test(lower) && lower.length < 500) {
    return 'question_answering';
  }
  return 'general';
}

/**
 * Return a confidence score for the inferred task type.
 * Simple heuristic: longer prompts with more keyword matches = higher confidence.
 */
export function getInferenceConfidence(prompt: string, _taskType: TaskType): number {
  const len = prompt.length;
  if (len < 20) return 0.3;
  if (len < 100) return 0.5;
  if (len < 500) return 0.7;
  return 0.85;
}

/**
 * Stub for the RelayPlane run-tracking class.
 * The real class wrote runs to a local SQLite DB for the dashboard.
 * This stub is a no-op — run tracking is not needed for core proxy operation.
 */
export class RelayPlane {
  routing = {
    get(_taskType: string): { preferredModel?: string; source?: string } | null {
      return null; // No learned routing rules — falls through to DEFAULT_ROUTING
    },
    clearDefaultRules(): number {
      return 0;
    },
  };

  constructor(_opts?: { dbPath?: string }) {}

  async run(_params: { prompt: string; taskType: string; model: string }): Promise<{ runId: string }> {
    return { runId: `local-${Date.now()}` };
  }

  patchRunTokens(_runId: string, _tokensIn: number, _tokensOut: number, _costUsd: number): void {}
}
