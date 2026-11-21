export interface UpdateInfo {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  windowsDownloadUrl?: string;
  androidDownloadUrl?: string;
  checkedAt?: string;
}

function parseSemver(version: string): { core: [number, number, number]; pre: string } | undefined {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || '',
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left.localeCompare(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! - b.core[i]!;
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

export class UpdateChecker {
  private cached?: { info: UpdateInfo; at: number };
  private readonly repo: string;
  private readonly ttlMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly currentVersion: string,
    options: { repo?: string; ttlMs?: number; fetcher?: typeof fetch; now?: () => number } = {},
  ) {
    this.repo = options.repo || 'Go12oct/agent-hub';
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60_000;
    this.fetcher = options.fetcher || fetch;
    this.now = options.now || Date.now;
  }

  async check(force = false): Promise<UpdateInfo> {
    const now = this.now();
    if (!force && this.cached && now - this.cached.at < this.ttlMs) {
      return this.cached.info;
    }
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `agent-hub/${this.currentVersion}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { tag_name?: string; html_url?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
      const latestVersion = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : undefined;
      const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, this.currentVersion) > 0);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const windowsDownloadUrl = assets.find((asset) => asset.name === 'agent-hub-windows.zip')?.browser_download_url
        || `https://github.com/${this.repo}/releases/latest/download/agent-hub-windows.zip`;
      const androidDownloadUrl = assets.find((asset) => asset.name === 'agent-hub-android.apk')?.browser_download_url
        || `https://github.com/${this.repo}/releases/latest/download/agent-hub-android.apk`;
      const info: UpdateInfo = {
        currentVersion: this.currentVersion,
        ...(latestVersion ? { latestVersion } : {}),
        updateAvailable,
        releaseUrl: data.html_url || `https://github.com/${this.repo}/releases/latest`,
        windowsDownloadUrl,
        androidDownloadUrl,
        checkedAt: new Date(now).toISOString(),
      };
      this.cached = { info, at: now };
      return info;
    } catch {
      return this.cached?.info ?? { currentVersion: this.currentVersion, updateAvailable: false };
    }
  }
}
