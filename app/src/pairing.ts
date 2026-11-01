import type { AgentSession } from '@agent-hub/shared';

export interface PairingDetails {
  url: string;
  token: string;
  urls?: string[];
}

function origin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function parsePairingLink(input: string): PairingDetails | undefined {
  const value = input.trim();
  try {
    if (value.startsWith('agenthub://')) {
      const parsed = new URL(value);
      const urls = parsed.searchParams.getAll('url').map(origin).filter((item): item is string => Boolean(item));
      const token = parsed.searchParams.get('token');
      if (!urls.length || !token) return undefined;
      return urls.length > 1 ? { url: urls[0]!, token, urls } : { url: urls[0]!, token };
    }
    const parsed = new URL(value);
    const token = parsed.searchParams.get('token');
    if (token) return { url: parsed.origin, token };
  } catch {
    return undefined;
  }
  return undefined;
}

export function candidateUrls(pairing: PairingDetails): string[] {
  return [...new Set([pairing.url, ...(pairing.urls || [])].map(origin).filter((item): item is string => Boolean(item)))];
}

export function mergeKnownUrls(pairing: PairingDetails, discovered: unknown): PairingDetails {
  const extra = Array.isArray(discovered) ? discovered.filter((item): item is string => typeof item === 'string') : [];
  const urls = [...new Set([...(pairing.urls || []), pairing.url, ...extra].map(origin).filter((item): item is string => Boolean(item)))];
  return { ...pairing, urls };
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

export function previewText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
