import { build } from 'esbuild';

const options = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'info' };
await build({
  ...options, entryPoints: ['src/cli.ts'], outfile: 'dist/agent-hub.cjs',
  define: { __DEFAULT_RELAY_URL__: JSON.stringify(process.env.AGENT_HUB_DEFAULT_RELAY_URL || '') },
});
await build({ ...options, entryPoints: ['src/hook-bridge.ts'], outfile: 'dist/hook-bridge.cjs' });
