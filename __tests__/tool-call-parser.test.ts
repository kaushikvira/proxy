import { describe, it, expect } from 'vitest';
import { parseToolCall } from '../src/tool-call-parser.js';

describe('parseToolCall', () => {
  it('Read with file_path shows path', () => {
    const result = parseToolCall('Read', JSON.stringify({ file_path: '/src/index.ts' }));
    expect(result.icon).toBe('📖');
    expect(result.displayName).toBe('Read');
    expect(result.summary).toBe('/src/index.ts');
  });

  it('Read with file_path + offset + limit shows line range', () => {
    const result = parseToolCall('Read', JSON.stringify({ file_path: '/src/index.ts', offset: 10, limit: 50 }));
    expect(result.icon).toBe('📖');
    expect(result.displayName).toBe('Read');
    expect(result.summary).toBe('/src/index.ts (lines 10-60)');
  });

  it('read_file also maps to Read', () => {
    const result = parseToolCall('read_file', JSON.stringify({ file_path: '/foo.ts' }));
    expect(result.icon).toBe('📖');
    expect(result.displayName).toBe('Read');
    expect(result.summary).toBe('/foo.ts');
  });

  it('Grep with pattern + path', () => {
    const result = parseToolCall('Grep', JSON.stringify({ pattern: 'TODO', path: '/src' }));
    expect(result.icon).toBe('🔍');
    expect(result.displayName).toBe('Grep');
    expect(result.summary).toBe('"TODO" in /src');
  });

  it('Grep with pattern only', () => {
    const result = parseToolCall('Grep', JSON.stringify({ pattern: 'TODO' }));
    expect(result.summary).toBe('"TODO"');
  });

  it('Glob with pattern', () => {
    const result = parseToolCall('Glob', JSON.stringify({ pattern: '**/*.ts' }));
    expect(result.icon).toBe('🔍');
    expect(result.displayName).toBe('Glob');
    expect(result.summary).toBe('**/*.ts');
  });

  it('Edit with file_path', () => {
    const result = parseToolCall('Edit', JSON.stringify({ file_path: '/src/foo.ts' }));
    expect(result.icon).toBe('✏️');
    expect(result.displayName).toBe('Edit');
    expect(result.summary).toBe('/src/foo.ts');
  });

  it('Write with file_path', () => {
    const result = parseToolCall('Write', JSON.stringify({ file_path: '/src/bar.ts' }));
    expect(result.icon).toBe('📝');
    expect(result.displayName).toBe('Write');
    expect(result.summary).toBe('/src/bar.ts');
  });

  it('Bash with command', () => {
    const result = parseToolCall('Bash', JSON.stringify({ command: 'echo hello' }));
    expect(result.icon).toBe('⚡');
    expect(result.displayName).toBe('Bash');
    expect(result.summary).toBe('echo hello');
  });

  it('Bash truncates long commands to 100 chars', () => {
    const longCmd = 'a'.repeat(150);
    const result = parseToolCall('Bash', JSON.stringify({ command: longCmd }));
    expect(result.summary).toBe('a'.repeat(100) + '…');
  });

  it('Agent with description', () => {
    const result = parseToolCall('Agent', JSON.stringify({ description: 'Search for config files' }));
    expect(result.icon).toBe('🤖');
    expect(result.displayName).toBe('Agent');
    expect(result.summary).toBe('Search for config files');
  });

  it('Agent truncates long description to 80 chars', () => {
    const longDesc = 'x'.repeat(100);
    const result = parseToolCall('Agent', JSON.stringify({ description: longDesc }));
    expect(result.summary).toBe('x'.repeat(80) + '…');
  });

  it('AskUserQuestion extracts first question', () => {
    const result = parseToolCall('AskUserQuestion', JSON.stringify({
      questions: [{ question: 'What is your name?' }],
    }));
    expect(result.icon).toBe('💬');
    expect(result.displayName).toBe('Ask');
    expect(result.summary).toBe('What is your name?');
  });

  it('WebFetch with url', () => {
    const result = parseToolCall('WebFetch', JSON.stringify({ url: 'https://example.com/page' }));
    expect(result.icon).toBe('🌐');
    expect(result.displayName).toBe('Fetch');
    expect(result.summary).toBe('https://example.com/page');
  });

  it('WebSearch with query', () => {
    const result = parseToolCall('WebSearch', JSON.stringify({ query: 'vitest docs' }));
    expect(result.icon).toBe('🌐');
    expect(result.displayName).toBe('Search');
    expect(result.summary).toBe('vitest docs');
  });

  it('Skill with skill name', () => {
    const result = parseToolCall('Skill', JSON.stringify({ skill: 'commit' }));
    expect(result.icon).toBe('🎯');
    expect(result.displayName).toBe('Skill');
    expect(result.summary).toBe('commit');
  });

  it('TaskCreate with subject', () => {
    const result = parseToolCall('TaskCreate', JSON.stringify({ subject: 'Fix the bug' }));
    expect(result.icon).toBe('📋');
    expect(result.displayName).toBe('Task');
    expect(result.summary).toBe('Fix the bug');
  });

  it('TaskUpdate with taskId and status', () => {
    const result = parseToolCall('TaskUpdate', JSON.stringify({ taskId: '42', status: 'done' }));
    expect(result.icon).toBe('📋');
    expect(result.displayName).toBe('Task');
    expect(result.summary).toBe('#42 → done');
  });

  it('TaskUpdate with taskId only', () => {
    const result = parseToolCall('TaskUpdate', JSON.stringify({ taskId: '42' }));
    expect(result.summary).toBe('#42');
  });

  it('LSP with operation and filePath', () => {
    const result = parseToolCall('LSP', JSON.stringify({ operation: 'hover', filePath: '/src/index.ts', line: 10 }));
    expect(result.icon).toBe('🔗');
    expect(result.displayName).toBe('LSP');
    expect(result.summary).toBe('hover /src/index.ts:10');
  });

  it('SendMessage with to and message', () => {
    const result = parseToolCall('SendMessage', JSON.stringify({ to: 'user1', message: 'Hello there friend' }));
    expect(result.icon).toBe('💬');
    expect(result.displayName).toBe('Message');
    expect(result.summary).toBe('→ user1: Hello there friend');
  });

  it('MCP tool name cleaning', () => {
    const result = parseToolCall(
      'mcp__claude_ai_Slack__slack_send_message',
      JSON.stringify({ channel_id: 'C123', message: 'hi' }),
    );
    expect(result.icon).toBe('🔌');
    expect(result.displayName).toBe('claude_ai_Slack/slack_send_message');
    expect(result.summary.length).toBeLessThanOrEqual(81); // 80 + possible ellipsis
  });

  it('Unknown tool fallback', () => {
    const result = parseToolCall('SomeCustomTool', JSON.stringify({ foo: 'bar' }));
    expect(result.icon).toBe('🔧');
    expect(result.displayName).toBe('SomeCustomTool');
    expect(result.summary).toContain('foo');
  });

  it('Invalid JSON input graceful fallback', () => {
    const result = parseToolCall('Bash', 'not valid json {{{');
    expect(result.icon).toBe('⚡');
    expect(result.displayName).toBe('Bash');
    expect(result.summary).toBe('not valid json {{{');
  });

  it('Invalid JSON truncated to 80 chars', () => {
    const longBad = 'z'.repeat(100);
    const result = parseToolCall('Bash', longBad);
    expect(result.summary).toBe('z'.repeat(80) + '…');
  });

  it('Empty input string', () => {
    const result = parseToolCall('Bash', '');
    expect(result.icon).toBe('⚡');
    expect(result.displayName).toBe('Bash');
    expect(result.summary).toBe('');
  });
});
