import { createRelay } from './server.js';

const port = Number(process.env.PORT || 8787);
const relay = createRelay({ trustProxy: process.env.RELAY_TRUST_PROXY === '1' });
relay.server.listen(port, '127.0.0.1', () => console.log(`Agent Hub relay listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void relay.close());
