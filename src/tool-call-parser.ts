export interface ToolCallDisplay {
  icon: string;
  displayName: string;
  summary: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function previewInput(input: Record<string, unknown>): string {
  return truncate(JSON.stringify(input), 80);
}

export function parseToolCall(name: string, inputJson: string): ToolCallDisplay {
  let input: Record<string, unknown> | null = null;
  let parseFailed = false;

  if (inputJson.length > 0) {
    try {
      input = JSON.parse(inputJson) as Record<string, unknown>;
    } catch {
      parseFailed = true;
    }
  }

  const fallbackSummary = parseFailed ? truncate(inputJson, 80) : (input ? previewInput(input) : '');

  switch (name) {
    case 'Read':
    case 'read_file': {
      const filePath = input?.file_path as string | undefined;
      let summary = filePath ?? fallbackSummary;
      if (filePath && input?.offset != null) {
        const offset = Number(input.offset);
        const limit = Number(input.limit ?? 0);
        summary = `${filePath} (lines ${offset}-${offset + limit})`;
      }
      return { icon: '📖', displayName: 'Read', summary };
    }

    case 'Grep': {
      const pattern = input?.pattern as string | undefined;
      const path = input?.path as string | undefined;
      let summary: string;
      if (pattern && path) {
        summary = `"${pattern}" in ${path}`;
      } else if (pattern) {
        summary = `"${pattern}"`;
      } else {
        summary = fallbackSummary;
      }
      return { icon: '🔍', displayName: 'Grep', summary };
    }

    case 'Glob': {
      const pattern = input?.pattern as string | undefined;
      return { icon: '🔍', displayName: 'Glob', summary: pattern ?? fallbackSummary };
    }

    case 'Edit':
    case 'edit_file': {
      const filePath = input?.file_path as string | undefined;
      return { icon: '✏️', displayName: 'Edit', summary: filePath ?? fallbackSummary };
    }

    case 'Write':
    case 'write_file': {
      const filePath = input?.file_path as string | undefined;
      return { icon: '📝', displayName: 'Write', summary: filePath ?? fallbackSummary };
    }

    case 'Bash': {
      const command = input?.command as string | undefined;
      return { icon: '⚡', displayName: 'Bash', summary: command ? truncate(command, 100) : fallbackSummary };
    }

    case 'Agent': {
      const desc = input?.description as string | undefined;
      return { icon: '🤖', displayName: 'Agent', summary: desc ? truncate(desc, 80) : fallbackSummary };
    }

    case 'AskUserQuestion': {
      const questions = input?.questions as Array<{ question: string }> | undefined;
      const q = questions?.[0]?.question;
      return { icon: '💬', displayName: 'Ask', summary: q ? truncate(q, 80) : fallbackSummary };
    }

    case 'WebFetch': {
      const url = input?.url as string | undefined;
      return { icon: '🌐', displayName: 'Fetch', summary: url ? truncate(url, 80) : fallbackSummary };
    }

    case 'WebSearch': {
      const query = input?.query as string | undefined;
      return { icon: '🌐', displayName: 'Search', summary: query ?? fallbackSummary };
    }

    case 'Skill': {
      const skill = input?.skill as string | undefined;
      return { icon: '🎯', displayName: 'Skill', summary: skill ?? fallbackSummary };
    }

    case 'TaskCreate': {
      const subject = input?.subject as string | undefined;
      return { icon: '📋', displayName: 'Task', summary: subject ?? fallbackSummary };
    }

    case 'TaskUpdate': {
      const taskId = input?.taskId as string | undefined;
      const status = input?.status as string | undefined;
      let summary: string;
      if (taskId && status) {
        summary = `#${taskId} → ${status}`;
      } else if (taskId) {
        summary = `#${taskId}`;
      } else {
        summary = fallbackSummary;
      }
      return { icon: '📋', displayName: 'Task', summary };
    }

    case 'LSP': {
      const op = input?.operation as string | undefined;
      const fp = input?.filePath as string | undefined;
      const line = input?.line;
      const summary = op && fp && line != null ? `${op} ${fp}:${line}` : fallbackSummary;
      return { icon: '🔗', displayName: 'LSP', summary };
    }

    case 'SendMessage': {
      const to = input?.to as string | undefined;
      const msg = input?.message as string | undefined;
      let summary: string;
      if (to && msg) {
        summary = `→ ${to}: ${truncate(msg, 60)}`;
      } else {
        summary = fallbackSummary;
      }
      return { icon: '💬', displayName: 'Message', summary };
    }

    default: {
      if (name.startsWith('mcp__')) {
        const cleanName = name.slice(5).replace(/__/g, '/');
        return { icon: '🔌', displayName: cleanName, summary: fallbackSummary };
      }
      return { icon: '🔧', displayName: name, summary: fallbackSummary };
    }
  }
}
