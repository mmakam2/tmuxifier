import http from 'node:http';
import { SITES, DEVICES, DEVICE_STATS, CLIENTS_PAGE1, NETWORKS } from './unifiSamples.js';

// A real HTTP server speaking the UniFi integration-API envelope, so the client
// tests exercise the actual request path (no mocks — the repo convention).
// Counters let tests assert how often each endpoint was hit, which is how the
// snapshot TTL is verified.
export async function startFakeUnifi({
  apiKey = 'test-key',
  sites = SITES,
  devices = DEVICES,
  deviceStats = DEVICE_STATS,
  clients = CLIENTS_PAGE1,
  networks = NETWORKS,       // null => respond 404, simulating firmware without it
  statsStatus = 200,         // 404 => simulate firmware without /statistics/latest
  unauthorized = false,
  malformed = false,
} = {}) {
  // Per-endpoint counters are incremented past the auth gate, so they measure
  // work actually served. `requests` counts every arrival, which is what a test
  // asserting "the client retried at all" needs when every reply is a 401.
  const counts = { requests: 0, sites: 0, devices: 0, stats: 0, clients: 0, networks: 0 };
  const P = '/proxy/network/integration/v1';

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(malformed ? '{not json' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    counts.requests++;
    if (req.method !== 'GET') { send(res, 405, { error: 'read-only fixture' }); return; }
    if (unauthorized || req.headers['x-api-key'] !== apiKey) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === `${P}/sites`) { counts.sites++; send(res, 200, sites); return; }

    const stats = /^\/proxy\/network\/integration\/v1\/sites\/([^/]+)\/devices\/([^/]+)\/statistics\/latest$/.exec(path);
    if (stats) {
      counts.stats++;
      if (statsStatus !== 200) { send(res, statsStatus, { error: 'not found' }); return; }
      send(res, 200, deviceStats[stats[2]] ?? {});
      return;
    }

    const site = /^\/proxy\/network\/integration\/v1\/sites\/([^/]+)\/(devices|clients|networks)$/.exec(path);
    if (site) {
      const which = site[2];
      if (which === 'networks') {
        counts.networks++;
        if (networks === null) { send(res, 404, { error: 'not found' }); return; }
        send(res, 200, networks);
        return;
      }
      if (which === 'devices') { counts.devices++; send(res, 200, devices); return; }
      counts.clients++;
      send(res, 200, clients);
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}
