import type { AgentSession } from '@agent-hub/shared';

export interface PairingDetails {
  url: string;
  token: string;
}

export function parsePairingLink(input: string): PairingDetails | undefined {
  const value = input.trim();
  try {
    if (value.startsWith('agenthub://')) {
      const parsed = new URL(value);
      const url = parsed.searchParams.get('url');
      const token = parsed.searchParams.get('token');
      if (!url || !token) return undefined;
      return { url: new URL(url).origin, token };
    }
    const parsed = new URL(value);
    const token = parsed.searchParams.get('token');
    if (token) return { url: parsed.origin, token };
  } catch {
    return undefined;
  }
  return undefined;
}

export function feedGroups(sessions: AgentSession[]): { needsYou: AgentSession[]; working: AgentSession[]; recent: AgentSession[] } {
  const sorted = [...sessions].sort((a, b) => {
    const rank = (status: string) => status === 'needs_input' ? 0 : status === 'working' ? 1 : 2;
    return rank(a.status) - rank(b.status) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  return {
    needsYou: sorted.filter((session) => session.status === 'needs_input'),
    working: sorted.filter((session) => session.status === 'working'),
    recent: sorted.filter((session) => !['needs_input', 'working'].includes(session.status)),
  };
}
