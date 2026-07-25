import path from 'node:path';
import { loadConfig } from '../config.js';
import { readJson } from '../jsonFile.js';
import { createEventLog } from '../eventLog.js';
import { createHeartbeatServer } from './heartbeatServer.js';

// Separate process on purpose: this one accepts input from the network and
// holds nothing — no SSH keys, no cookie secret, no box store, no API tokens.
// It reads data/checks.json to learn valid tokens and never writes it.
const config = loadConfig();
const eventsDir = path.join(config.dataDir, 'events');
const checksFile = path.join(config.dataDir, 'checks.json');

const server = createHeartbeatServer({
  checkinLog: createEventLog({ dir: eventsDir, prefix: 'checkins' }),
  heartbeatFile: path.join(config.dataDir, 'ingest-heartbeat.json'),
  // Read per request rather than cached at boot: a check enabled, disabled, or
  // deleted in the dashboard takes effect on the next check-in, with no restart
  // of this daemon and no channel between the two processes beyond the file.
  isKnownToken: async (token) => {
    const data = await readJson(checksFile, { fallback: { checks: [] } });
    return (data.checks || []).some((c) => c.id === token && c.type === 'heartbeat' && c.enabled);
  },
});

const port = await server.listen(config.ingestPort, config.ingestBind);
console.log(`[tmuxifier-ingest] heartbeat endpoint listening on ${config.ingestBind}:${port}`);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close().finally(() => process.exit(0)); });
}
