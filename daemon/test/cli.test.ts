import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { version } from '../package.json';

it('prints the daemon version and exits successfully from a standalone bundle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-cli-'));
  try {
    const bundle = path.join(directory, 'agent-hub.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    });
    for (const flag of ['--version', '-v']) {
      const result = spawnSync(process.execPath, [bundle, flag], { cwd: directory, encoding: 'utf8', timeout: 3000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(version);
      expect(result.stderr).toBe('');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
