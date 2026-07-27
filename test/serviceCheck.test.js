import { test, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkHttp, checkTcp, checkService } from '../src/server/serviceCheck.js';
import { createPiholeClient } from '../src/server/piholeApi.js';
import { startFakePihole } from './helpers/fakePihole.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('checkHttp: 2xx is up with a latency', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
});

test('checkHttp: 3xx is up without following the redirect', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(302, { location: '/elsewhere' }); res.end(); });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
  expect(hits).toBe(1); // no follow
});

test('checkHttp: 5xx is down with the status in the error', async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 503; res.end(); });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  server.close();
  expect(r).toMatchObject({ state: 'down', error: 'http 503' });
});

test('checkHttp: an unresponsive server times out as down', async () => {
  const server = http.createServer(() => { /* never respond */ });
  const port = await listen(server);
  const r = await checkHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 200 });
  server.close();
  expect(r.state).toBe('down');
  expect(r.error).toMatch(/timeout|socket hang up|aborted/i);
});

test('checkHttp: connection refused is down, not a throw', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await new Promise((r) => server.close(r)); // port now closed
  const r = await checkHttp(`http://127.0.0.1:${port}/`);
  expect(r.state).toBe('down');
});

test('checkHttp: an unparseable URL is down, not a throw', async () => {
  expect((await checkHttp('not a url')).state).toBe('down');
});

test('checkHttp: self-signed HTTPS is up (liveness probe, not a security boundary)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-cert-'));
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1']);
  } catch { return; } // no openssl binary here — the sweep against real self-signed hosts covers this in live validation
  const server = https.createServer({
    key: await fs.readFile(path.join(dir, 'key.pem')),
    cert: await fs.readFile(path.join(dir, 'cert.pem')),
  }, (_req, res) => res.end('ok'));
  const port = await listen(server);
  const r = await checkHttp(`https://127.0.0.1:${port}/`);
  server.close();
  expect(r.state).toBe('up');
});

test('checkTcp: connect succeeds is up', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  const r = await checkTcp(`127.0.0.1:${port}`);
  server.close();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
});

test('checkTcp: refused port is down', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  expect((await checkTcp(`127.0.0.1:${port}`)).state).toBe('down');
});

test('checkTcp: malformed target is down', async () => {
  expect((await checkTcp('nonsense')).state).toBe('down');
});

test('checkService dispatches by kind and skips none', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  const up = await checkService({ url: `http://127.0.0.1:${port}/`, check: { kind: 'http' } });
  const viaTarget = await checkService({ url: 'http://unused.example.com/', check: { kind: 'http', target: `http://127.0.0.1:${port}/` } });
  server.close();
  expect(up.state).toBe('up');
  expect(viaTarget.state).toBe('up');
  expect(await checkService({ url: 'http://x.example.com/', check: { kind: 'none' } })).toBeNull();
});

// A minimal registry over one real client — the same interface serviceChecker
// hands in, without needing a store on disk for a check-level test.
function oneClientRegistry(client) {
  return { clientFor: async () => client, retain: async () => {}, closeAll: async () => client.close() };
}

test('checkService: pihole kind returns metrics and an up state', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  expect(r.metrics.queriesTotal).toBe(48132);
});

test('checkService: a rejected password is the auth state, not down', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'wrong' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('auth');
  expect(r.error).toMatch(/app password/i);
  expect(r.metrics).toBeUndefined();
});

test('checkService: no stored password names that as the problem', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: '' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: false, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('auth');
  expect(r.error).toMatch(/no app password/i);
});

test('checkService: an unreachable pihole is down', async () => {
  const pi = await startFakePihole();
  const { baseUrl } = pi;
  await pi.stop();
  const client = createPiholeClient({ baseUrl, password: 'app-pw', timeoutMs: 500 });
  const r = await checkService(
    { id: 'a', url: baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { registry: oneClientRegistry(client) },
  );
  expect(r.state).toBe('down');
});

test('checkService: a pihole service with no registry is down, not a throw', async () => {
  const r = await checkService({ id: 'a', url: 'http://127.0.0.1:1/', hasPassword: true, check: { kind: 'pihole' } }, {});
  expect(r.state).toBe('down');
});
