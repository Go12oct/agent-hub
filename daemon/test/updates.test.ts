import { describe, expect, it, vi } from 'vitest';
import { compareVersions, UpdateChecker } from '../src/updates.js';

describe('compareVersions', () => {
  it('compares semver strings and prereleases', () => {
    expect(compareVersions('0.2.7', '0.2.6')).toBeGreaterThan(0);
    expect(compareVersions('v0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.6', '0.2.6')).toBe(0);
    expect(compareVersions('0.2.6-beta.1', '0.2.6')).toBeLessThan(0);
  });
});

describe('UpdateChecker', () => {
  it('detects a newer release and caches the result', async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v0.2.7',
      html_url: 'https://github.com/Go12oct/agent-hub/releases/tag/v0.2.7',
      assets: [
        { name: 'agent-hub-windows.zip', browser_download_url: 'https://example.test/win.zip' },
        { name: 'agent-hub-android.apk', browser_download_url: 'https://example.test/app.apk' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const checker = new UpdateChecker('0.2.6', { fetcher, now: () => now, ttlMs: 60_000 });
    const first = await checker.check();
    expect(first.updateAvailable).toBe(true);
    expect(first.latestVersion).toBe('0.2.7');
    expect(first.androidDownloadUrl).toBe('https://example.test/app.apk');

    now += 10_000;
    const second = await checker.check();
    expect(second.latestVersion).toBe('0.2.7');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed when offline', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const checker = new UpdateChecker('0.2.6', { fetcher });
    const info = await checker.check();
    expect(info).toEqual({ currentVersion: '0.2.6', updateAvailable: false });
  });
});
