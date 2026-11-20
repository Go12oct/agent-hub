import { createHash } from 'node:crypto';

export const maxBody = 64 * 1024;
export const maxChunk = 32 * 1024;
export const maxFrame = 2 * maxBody + 8192;
export const maxBuffered = 2 * 1024 * 1024;
export const maxRequests = 32;
export const routePrefix = '/hub/';
export const registrationPath = '/connect';
export const hexKey = /^[a-f0-9]{64}$/;

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function hubRoute(method: string, path: string): URL | undefined {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 4096) return;
  const url = new URL(path, 'http://localhost');
  if (url.origin !== 'http://localhost' || url.hash || url.pathname !== path.split('?')[0]) return;
  if (method === 'GET' && ['/health', '/api/sessions', '/api/pair', '/api/events'].includes(url.pathname)) return url;
  if (method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return url;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/(messages|approval|reply\/stop)$/.test(url.pathname)) return url;
}

export type ToDaemon =
  | { type: 'request'; id: string; method: string; path: string; token: string; body?: string }
  | { type: 'cancel'; id: string };

export type ToRelay =
  | { type: 'start'; id: string; status: number }
  | { type: 'chunk'; id: string; data: string }
  | { type: 'end' | 'error'; id: string };
