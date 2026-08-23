import { test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createApiClient, ApiError, ROUTES, ID_RE } from '../src/mcp/apiClient.js';

const EXPECTED = {
  listBoxes: ['GET', '/api/boxes'],
  addBox: ['POST', '/api/boxes'],
  getStatus: ['GET', '/api/status'],
  getSeries: ['GET', '/api/health/series'],
  getEvents: ['GET', '/api/health/events'],
  getPane: ['GET', '/api/boxes/:id/pane'],
  sendKeys: ['POST', '/api/boxes/:id/keys'],
  startSetup: ['POST', '/api/boxes/:id/setup'],
  listSetupJobs: ['GET', '/api/setup'],
  getSetupJob: ['GET', '/api/setup/:id'],
  listFleetScripts: ['GET', '/api/fleet/scripts'],
  createFleetJob: ['POST', '/api/fleet/jobs'],
  listFleetJobs: ['GET', '/api/fleet/jobs'],
  getFleetJob: ['GET', '/api/fleet/jobs/:id'],
  cancelFleetJob: ['POST', '/api/fleet/jobs/:id/cancel'],
  listPresets: ['GET', '/api/proxmox/presets'],
  listProxmoxHosts: ['GET', '/api/proxmox/hosts'],
  listGuests: ['GET', '/api/proxmox/guests'],
  createProvision: ['POST', '/api/proxmox/provisions'],
  listProvisions: ['GET', '/api/proxmox/provisions'],
  getProvision: ['GET', '/api/proxmox/provisions/:id'],
  createLifecycleJob: ['POST', '/api/proxmox/lifecycle-jobs'],
  listLifecycleJobs: ['GET', '/api/proxmox/lifecycle-jobs'],
  getLifecycleJob: ['GET', '/api/proxmox/lifecycle-jobs/:id'],
};

test('the client exposes exactly the allowlisted surface — no DELETE, no PUT, no admin routes', () => {
  expect(ROUTES).toEqual(EXPECTED);
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:1', token: 't', request: async () => ({ status: 200, json: {} }) });
  expect(Object.keys(client).sort()).toEqual(Object.keys(EXPECTED).sort());
  for (const [m] of Object.values(ROUTES)) expect(['GET', 'POST']).toContain(m);
});

test('every method hits its route with Bearer auth, encoded ids, and a JSON body where relevant', async () => {
  const calls = [];
  const request = async (opts) => { calls.push(opts); return { status: 200, json: { ok: true }, text: '{"ok":true}' }; };
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:7437/', token: 'tok', request });
  await c.listBoxes(); await c.addBox({ host: 'h' }); await c.getStatus(); await c.getSeries('b 1'); await c.getSeries(); await c.getEvents();
  await c.getPane('b1', { lines: 50 }); await c.sendKeys('b1', { text: 'x' }); await c.startSetup('b1', { tools: [] });
  await c.listSetupJobs(); await c.getSetupJob('s1'); await c.listFleetScripts(); await c.createFleetJob({ boxIds: ['b1'], command: 'x' });
  await c.listFleetJobs(); await c.getFleetJob('j1'); await c.cancelFleetJob('j1'); await c.listPresets(); await c.listProxmoxHosts();
  await c.listGuests(); await c.createProvision({ presetId: 'p' }); await c.listProvisions(); await c.getProvision('p1');
  await c.createLifecycleJob({ boxId: 'b1', action: 'start' }); await c.listLifecycleJobs(); await c.getLifecycleJob('l1');
  const seen = calls.map((o) => `${o.method} ${new URL(o.url).pathname}${new URL(o.url).search}`);
  expect(seen).toEqual([
    'GET /api/boxes', 'POST /api/boxes', 'GET /api/status', 'GET /api/health/series?box=b%201', 'GET /api/health/series', 'GET /api/health/events',
    'GET /api/boxes/b1/pane?lines=50', 'POST /api/boxes/b1/keys', 'POST /api/boxes/b1/setup',
    'GET /api/setup', 'GET /api/setup/s1', 'GET /api/fleet/scripts', 'POST /api/fleet/jobs',
    'GET /api/fleet/jobs', 'GET /api/fleet/jobs/j1', 'POST /api/fleet/jobs/j1/cancel', 'GET /api/proxmox/presets', 'GET /api/proxmox/hosts',
    'GET /api/proxmox/guests', 'POST /api/proxmox/provisions', 'GET /api/proxmox/provisions', 'GET /api/proxmox/provisions/p1',
    'POST /api/proxmox/lifecycle-jobs', 'GET /api/proxmox/lifecycle-jobs', 'GET /api/proxmox/lifecycle-jobs/l1',
  ]);
  for (const o of calls) expect(o.headers.Authorization).toBe('Bearer tok');
  expect(calls[1].body).toEqual({ host: 'h' });
  expect(calls[0].body).toBeUndefined();
  expect(calls[0].url.startsWith('http://127.0.0.1:7437/api/')).toBe(true); // trailing slash on baseUrl folded
});

test('non-2xx becomes an ApiError carrying the server message; 401 is unauthorized', async () => {
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => ({ status: 409, json: { error: 'pane has no mouse tracking' } }) });
  const err = await c.sendKeys('b1', { wheel: 'up' }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ kind: 'http', status: 409, path: '/api/boxes/b1/keys', message: 'pane has no mouse tracking' });
  const c401 = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => ({ status: 401, json: { error: 'unauthorized' } }) });
  expect(await c401.listBoxes().catch((e) => e)).toMatchObject({ kind: 'unauthorized', status: 401 });
  const c500 = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => ({ status: 500, json: null, text: 'oops' }) });
  expect(await c500.listBoxes().catch((e) => e)).toMatchObject({ kind: 'http', status: 500, message: 'HTTP 500' });
});

test('a transport failure is unreachable with the resolved base URL', async () => {
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; } });
  const err = await c.listBoxes().catch((e) => e);
  expect(err).toMatchObject({ kind: 'unreachable', baseUrl: 'http://127.0.0.1:7437', message: 'ECONNREFUSED' });
});

let srv;
afterEach(async () => { if (srv) await new Promise((r) => srv.close(r)); srv = null; });

// Probed at module level rather than in beforeAll: test.skipIf is evaluated when
// the test is registered, which happens before any hook runs. A host without
// IPv6 skips silently instead of failing on EADDRNOTAVAIL/EAFNOSUPPORT.
const IPV6 = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

test.skipIf(!IPV6)('an IPv6 base URL reaches the server: the literal\'s brackets never go to the resolver', async () => {
  srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('[]'); });
  await new Promise((r) => srv.listen(0, '::1', r));
  const c = createApiClient({ baseUrl: `http://[::1]:${srv.address().port}`, token: 'tok', timeoutMs: 5000 });
  expect(await c.listBoxes()).toEqual([]);
});

test('the default httpRequest speaks real HTTP with a fixed Content-Length and parses JSON', async () => {
  const seen = [];
  srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cl: req.headers['content-length'], te: req.headers['transfer-encoding'], data });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'j1' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = createApiClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 'tok' });
  expect(await c.createFleetJob({ boxIds: ['b1'], command: 'uptime' })).toEqual({ id: 'j1' });
  expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/fleet/jobs', auth: 'Bearer tok', cl: '36', te: undefined, data: '{"boxIds":["b1"],"command":"uptime"}' });
});

test('a refused port is unreachable end to end', async () => {
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok', timeoutMs: 2000 });
  expect(await c.listBoxes().catch((e) => e)).toMatchObject({ kind: 'unreachable' });
});

test('a response aborted mid-body rejects as unreachable instead of hanging forever', async () => {
  srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'application/json' });
    res.write('{"a":');
    // The delay lets the client fully receive the headers (so the response
    // callback fires and its handlers attach) before the socket dies —
    // an immediate destroy races the client's own parser and can surface as
    // a plain req-level error instead, which was never the gap.
    setTimeout(() => res.socket.destroy(), 10);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = createApiClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 'tok', timeoutMs: 2000 });
  await expect(c.listBoxes()).rejects.toMatchObject({ kind: 'unreachable' });
});

test('a multi-byte UTF-8 character split across a chunk boundary decodes correctly', async () => {
  const buf = Buffer.from(JSON.stringify({ text: '─' }));
  const splitAt = buf.indexOf(Buffer.from('─')) + 1; // splits inside the 3-byte character
  srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(buf.subarray(0, splitAt));
    setTimeout(() => { res.write(buf.subarray(splitAt)); res.end(); }, 5);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = createApiClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 'tok' });
  const result = await c.listBoxes();
  expect(result.text).toBe('─');
});

test('ROUTES is frozen at the table level and per-row', () => {
  expect(Object.isFrozen(ROUTES)).toBe(true);
  expect(Object.isFrozen(ROUTES.listBoxes)).toBe(true);
});

test('a non-JSON 2xx body is an ApiError; an empty/whitespace 2xx body still resolves null', async () => {
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => ({ status: 200, json: null, text: '<!doctype html>' }) });
  await expect(c.listBoxes()).rejects.toMatchObject({ kind: 'http', status: 200, message: 'non-JSON response from /api/boxes' });
  const c204 = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async () => ({ status: 204, json: null, text: '' }) });
  expect(await c204.listBoxes()).toBeNull();
});

test('an id outside the uuid-ish shape is refused before any request is made', async () => {
  const calls = [];
  const c = createApiClient({ baseUrl: 'http://127.0.0.1:7437', token: 't', request: async (o) => { calls.push(o); return { status: 200, json: {}, text: '{}' }; } });
  for (const bad of ['..', '.', 'a/b', '%2e%2e', 'a b', '../../api/boxes/x', '']) {
    await expect(c.getPane(bad)).rejects.toMatchObject({ kind: 'http', status: 400, message: expect.stringContaining('invalid id') });
  }
  await expect(c.getSetupJob('a/b')).rejects.toMatchObject({ kind: 'http', status: 400, path: '/api/setup/:id' });
  expect(calls).toEqual([]);
  // Every id the server actually mints still passes: a uuid, a script's fs-<uuid>, the host shell.
  await c.getSetupJob('6f1c0c8e-2f9a-4a1b-8f4b-1b2c3d4e5f60');
  await c.getFleetJob('fs-6f1c0c8e-2f9a-4a1b-8f4b-1b2c3d4e5f60');
  await c.getPane('__local__');
  expect(calls.map((o) => new URL(o.url).pathname)).toEqual([
    '/api/setup/6f1c0c8e-2f9a-4a1b-8f4b-1b2c3d4e5f60',
    '/api/fleet/jobs/fs-6f1c0c8e-2f9a-4a1b-8f4b-1b2c3d4e5f60',
    '/api/boxes/__local__/pane',
  ]);
  expect(ID_RE.test('a'.repeat(128))).toBe(true);
  expect(ID_RE.test('a'.repeat(129))).toBe(false);
});

test('a ca certificate is forwarded to the request layer, unlike the default', async () => {
  const calls = [];
  const request = async (o) => { calls.push(o); return { status: 200, json: [], text: '[]' }; };
  const ca = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';
  await createApiClient({ baseUrl: 'https://tmux.example.com', token: 't', ca, request }).listBoxes();
  await createApiClient({ baseUrl: 'https://tmux.example.com', token: 't', request }).listBoxes();
  expect(calls[0].ca).toBe(ca);
  expect(calls[1].ca).toBeUndefined();
});
