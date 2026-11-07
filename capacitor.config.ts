import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tech.agenthub.app',
  appName: 'Agent Hub',
  webDir: 'app/dist',
  server: { androidScheme: 'http', cleartext: true },
  android: { adjustMarginsForEdgeToEdge: 'force' },
};

export default config;
