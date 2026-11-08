export type AgentKind = 'devin' | 'codex' | 'codex-cloud' | 'claude-code' | 'antigravity';
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'done' | 'error';
export type MessageRole = 'user' | 'assistant' | 'tool';

export interface PendingApproval {
  id: string;
  toolName: string;
  summary: string;
  detail?: string;
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  requestedAt: string;
}

export interface AgentSession {
  id: string;
  agent: AgentKind;
  nativeId: string;
  title: string;
  project?: string;
  cwd?: string;
  branch?: string;
  status: SessionStatus;
  canReply: boolean;
  replyRunning?: boolean;
  replyError?: string;
  approval?: PendingApproval;
  approvals?: PendingApproval[];
  lastMessage?: string;
  lastRole?: MessageRole;
  startedAt?: string;
  updatedAt: string;
  url?: string;
  machine: string;
}

export interface SessionMessage {
  role: MessageRole;
  text: string;
  at?: string;
}

export const agentLabels: Record<AgentKind, string> = {
  devin: 'Devin',
  codex: 'Codex',
  'codex-cloud': 'Codex Cloud',
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
};

export function sessionOrder(a: AgentSession, b: AgentSession): number {
  const rank: Record<SessionStatus, number> = {
    needs_input: 0,
    working: 1,
    idle: 2,
    done: 3,
    error: 4,
  };
  return rank[a.status] - rank[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}
