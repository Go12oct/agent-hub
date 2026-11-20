import type { AgentSession } from '@agent-hub/shared';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export interface PairingDetails {
  url: string;
  token: string;
  urls?: string[];
  relay?: string;
}

function relayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/hub\/[a-f0-9]{64}$/.test(url.pathname)) return url.href;
  } catch { /* Ignore invalid relay addresses. */ }
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
      const relay = relayUrl(parsed.searchParams.get('relay'));
      return { url: urls[0]!, token, ...(urls.length > 1 ? { urls } : {}), ...(relay ? { relay } : {}) };
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
  const relay = relayUrl(pairing.relay);
  const direct = directUrls([pairing.url, ...(pairing.urls || [])]);
  return !relay ? direct : pairing.url === relay ? [relay, ...direct] : [...direct, relay];
}

function directUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((item) => !relayUrl(item)).map(origin).filter((item): item is string => Boolean(item)))];
}

export function newNonce(): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyHubProof(token: string, nonce: string, proof: unknown): Promise<boolean> {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  const expected = bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(nonce)));
  const actual = proof.toLowerCase();
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

export function mergeKnownUrls(pairing: PairingDetails, discovered: unknown, discoveredRelay?: unknown): PairingDetails {
  const extra = Array.isArray(discovered) ? discovered.filter((item): item is string => typeof item === 'string') : [];
  const urls = directUrls([...(pairing.urls || []), pairing.url, ...extra]);
  const relay = relayUrl(discoveredRelay);
  return { ...pairing, urls, ...(relay ? { relay } : {}) };
}

export async function findReachable(
  pairing: PairingDetails,
  probe: (url: string, relay: boolean) => Promise<boolean>,
): Promise<string | undefined> {
  const checks = candidateUrls(pairing).map((url) => ({ url, result: probe(url, url === pairing.relay) }));
  for (const { url, result } of checks) if (await result) return url;
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
