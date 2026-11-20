import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
});
