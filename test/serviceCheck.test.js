import { test, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkHttp, checkTcp, checkService, CREDENTIALED_CHECKS } from '../src/server/serviceCheck.js';
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
    { piholeRegistry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('up');
  expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  expect(r.pihole.queriesTotal).toBe(48132);
});

test('checkService: a rejected password is the auth state, not down', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'wrong' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: true, check: { kind: 'pihole' } },
    { piholeRegistry: oneClientRegistry(client) },
  );
  await client.close();
  await pi.stop();
  expect(r.state).toBe('auth');
  expect(r.error).toMatch(/app password/i);
  expect(r.pihole).toBeUndefined();
});

test('checkService: no stored password names that as the problem', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: '' });
  const r = await checkService(
    { id: 'a', url: pi.baseUrl, hasPassword: false, check: { kind: 'pihole' } },
    { piholeRegistry: oneClientRegistry(client) },
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
    { piholeRegistry: oneClientRegistry(client) },
  );
  expect(r.state).toBe('down');
});

test('checkService: a pihole service with no registry is down, not a throw', async () => {
  const r = await checkService({ id: 'a', url: 'http://127.0.0.1:1/', hasPassword: true, check: { kind: 'pihole' } }, {});
  expect(r.state).toBe('down');
});

// The truenas, unifi and immich blocks that stood here were stub-driven copies
// of the same five assertions, one set per kind. They are the table-driven loop
// at the bottom of this file now (C1) — which also covers the `tls`-is-down rule
// that only unifi used to assert, and a registry that throws during setup, which
// none of them did. The pihole block above stays: it drives a real client against
// a fake Pi-hole, so it is an integration test, not a fourth copy.

// C1 (2026-07-29 review). The four credentialed checks above were four
// structurally identical wrappers, ~80 lines differing only in registry name,
// client method, metrics key and message. The tests were four hand-written
// copies to match — which meant a fifth integration had to re-transcribe both,
// and could get the auth-vs-down distinction subtly wrong without any test
// noticing.
//
// They are one table now, and this covers whatever is in it. Adding a kind to
// CREDENTIALED_CHECKS gets these five semantics for free; getting one wrong
// fails here rather than shipping a tile that cries wolf on a rotated key.
const stubRegistry = (spec, result) => ({
  [spec.registry]: { clientFor: async () => ({ [spec.method]: async () => result }) },
});

for (const [kind, spec] of Object.entries(CREDENTIALED_CHECKS)) {
  const service = { id: 's', check: { kind } };

  test(`${kind}: a successful read is up, with the metrics under its own key`, async () => {
    const metrics = { marker: kind };
    const res = await checkService(service, stubRegistry(spec, { ok: true, metrics }));
    expect(res.state).toBe('up');
    expect(res[spec.metricsKey], `metrics must land under \`${spec.metricsKey}\``).toBe(metrics);
    expect(typeof res.latencyMs).toBe('number');
  });

  // The load-bearing one. A rotated credential means the service is answering
  // perfectly well; painting it red would cry wolf, so auth is its own state
  // and its own violet lamp.
  test(`${kind}: a rejected credential is auth, not down`, async () => {
    const res = await checkService(service, stubRegistry(spec, { ok: false, kind: 'auth', error: 'rejected' }));
    expect(res.state).toBe('auth');
    expect(res.error).toBe('rejected');
  });

  test(`${kind}: no stored credential is named instead of repeating the API message`, async () => {
    const res = await checkService(
      { ...service, hasPassword: false },
      stubRegistry(spec, { ok: false, kind: 'auth', error: 'rejected' }),
    );
    expect(res.state).toBe('auth');
    expect(res.error).toContain(spec.credential);
    expect(res.error).toMatch(/Settings → Services/);
  });

  test(`${kind}: an unreachable service is down`, async () => {
    const res = await checkService(service, stubRegistry(spec, { ok: false, kind: 'unreachable', error: 'refused' }));
    expect(res.state).toBe('down');
    expect(res.error).toBe('refused');
  });

  // A TLS failure is deliberately NOT auth: it is a transport the operator has
  // to decide about. This was only ever asserted for unifi, but it is the
  // shared rule — a pinned fingerprint that stops matching must not be reported
  // as a credential problem for any kind.
  test(`${kind}: a tls failure is down, not auth`, async () => {
    const res = await checkService(service, stubRegistry(spec, { ok: false, kind: 'tls', error: 'fingerprint mismatch' }));
    expect(res.state).toBe('down');
    expect(res.error).toMatch(/fingerprint mismatch/);
  });

  test(`${kind}: a missing registry is down, not a throw`, async () => {
    const res = await checkService(service, {});
    expect(res.state).toBe('down');
    expect(res.error).toContain(spec.label);
  });

  test(`${kind}: a registry that throws during setup is down, not a throw`, async () => {
    const registry = { [spec.registry]: { clientFor: async () => { throw new Error('boom'); } } };
    const res = await checkService(service, registry);
    expect(res.state).toBe('down');
    expect(res.error).toBe('boom');
  });
}

// A table-driven suite that silently covers nothing is worse than no suite:
// this repo has shipped a UI feature that rendered nothing while every test
// stayed green.
test('the credentialed-check table covers every kind checkService dispatches', () => {
  const kinds = Object.keys(CREDENTIALED_CHECKS);
  expect(kinds.sort()).toEqual(['immich', 'pihole', 'truenas', 'unifi']);
  for (const [kind, spec] of Object.entries(CREDENTIALED_CHECKS)) {
    for (const field of ['registry', 'method', 'metricsKey', 'label', 'credential']) {
      expect(spec[field], `${kind}.${field}`).toBeTruthy();
    }
  }
});
