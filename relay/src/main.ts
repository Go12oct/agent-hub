import { createRelay } from './server.js';
import { hexKey } from './protocol.js';

const port = Number(process.env.PORT || 8787);
const ids = process.env.RELAY_ALLOWED_HUB_IDS?.split(',').map((id) => id.trim());
if (ids?.some((id) => !hexKey.test(id))) throw new Error('RELAY_ALLOWED_HUB_IDS must contain comma-separated SHA-256 hub IDs.');
const relay = createRelay({ trustProxy: process.env.RELAY_TRUST_PROXY === '1', allowedHubIds: ids && new Set(ids) });
relay.server.listen(port, '127.0.0.1', () => console.log(`Agent Hub relay listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void relay.close());
