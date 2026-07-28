import http from 'node:http';
import {
  ABOUT, STORAGE, STATISTICS, JOBS_IDLE, VERSION_CHECK, CONFIG,
} from './immichSamples.js';

// A real HTTP server speaking the Immich REST shapes, so the client tests
// exercise the actual request path (no mocks — the repo convention). Per-path
// counters are what the snapshot-TTL test asserts against.
//
// `deny` is the list of paths that answer 403, which is how the permission-
// degradation contract is exercised without needing a scoped key.
export async function startFakeImmich({
  apiKey = 'test-key',
  about = ABOUT,
  storage = STORAGE,
  statistics = STATISTICS,
  jobs = JOBS_IDLE,
  versionCheck = VERSION_CHECK,
  config = CONFIG,
  deny = [],              // e.g. ['/api/server/statistics']
  unauthorized = false,   // every path answers 401
  malformed = false,
  status = {},            // path -> status override, e.g. { '/api/jobs': 500 }
} = {}) {
  const counts = { requests: 0 };
  const bodies = {
    '/api/server/about': about,
    '/api/server/storage': storage,
    '/api/server/statistics': statistics,
    '/api/jobs': jobs,
    '/api/server/version-check': versionCheck,
    '/api/server/config': config,
  };
  for (const p of Object.keys(bodies)) counts[p] = 0;

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(malformed ? '{not json' : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    counts.requests++;
    // The integration is read-only; a fixture that answered another verb would
    // let a regression through silently.
    if (req.method !== 'GET') { send(res, 405, { error: 'read-only fixture' }); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (unauthorized || req.headers['x-api-key'] !== apiKey) { send(res, 401, { error: 'Unauthorized' }); return; }
    if (!(path in bodies)) { send(res, 404, { error: 'not found' }); return; }
    counts[path]++;
    if (deny.includes(path)) { send(res, 403, { error: 'Forbidden' }); return; }
    if (status[path]) { send(res, status[path], { error: 'boom' }); return; }
    send(res, 200, bodies[path]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}
