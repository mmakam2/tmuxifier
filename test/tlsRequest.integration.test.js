import { test, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { tlsProbe } from '../src/server/tlsPin.js';
import { requestCheck, resolveCheckTls } from '../src/server/checks/tlsRequest.js';

// A self-signed leaf, the shape of every internal service in a homelab: nothing
// in the system CA store will ever vouch for it. Built with openssl, following
// test/netboxApi.integration.test.js.
let cert, key;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsreq-'));
  const p = (f) => path.join(dir, f);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', p('key.pem'),
    '-out', p('cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  cert = fs.readFileSync(p('cert.pem'), 'utf8');
  key = fs.readFileSync(p('key.pem'), 'utf8');
});

const servers = [];
afterEach(async () => { while (servers.length) await new Promise((r) => servers.pop().close(r)); });

async function servePlain(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
async function serveTls(handler) {
  const s = https.createServer({ cert, key }, handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `https://127.0.0.1:${s.address().port}`, port: s.address().port };
}
const ok = (_req, res) => { res.writeHead(200); res.end('served'); };

test('resolveCheckTls leaves plain http alone — there is no TLS to configure', () => {
  expect(resolveCheckTls({ tlsMode: 'insecure' }, 'http://example.com/')).toEqual({});
});

test('resolveCheckTls defaults to system trust when no mode is stored', () => {
  expect(resolveCheckTls({}, 'https://example.com/')).toEqual({});
  expect(resolveCheckTls({ tlsMode: 'ca' }, 'https://example.com/')).toEqual({});
});

test('resolveCheckTls maps insecure and pin to their request options', () => {
  expect(resolveCheckTls({ tlsMode: 'insecure' }, 'https://example.com/')).toEqual({ rejectUnauthorized: false });
  expect(resolveCheckTls({ tlsMode: 'pin', fingerprint256: 'AA:BB' }, 'https://example.com/')).toEqual({ pin: 'AA:BB' });
});

// An unknown mode must not silently become "trust everything". Anything
// unrecognised falls back to system trust, the strictest of the three.
test('resolveCheckTls treats an unknown mode as system trust, never as insecure', () => {
  expect(resolveCheckTls({ tlsMode: 'whatever' }, 'https://example.com/')).toEqual({});
});

test('a plain http request returns the status and body', async () => {
  const url = await servePlain(ok);
  const got = await requestCheck({ url, timeoutMs: 2000 });
  expect(got.status).toBe(200);
  expect(got.text).toBe('served');
});

// The gap this module exists to close: before it, an internal HTTPS service was
// unmonitorable, because the executor reported the cert failure as an outage.
test('system trust rejects a private cert — the behaviour that made internal HTTPS unmonitorable', async () => {
  const { url } = await serveTls(ok);
  await expect(requestCheck({ url, timeoutMs: 2000, tls: {} })).rejects.toThrow();
});

test('insecure mode reaches a private-cert service', async () => {
  const { url } = await serveTls(ok);
  const got = await requestCheck({ url, timeoutMs: 2000, tls: { rejectUnauthorized: false } });
  expect(got.status).toBe(200);
});

test('pin mode reaches the service whose fingerprint matches', async () => {
  const { url, port } = await serveTls(ok);
  const probe = await tlsProbe({ host: '127.0.0.1', port, timeoutMs: 2000 });
  const got = await requestCheck({ url, timeoutMs: 2000, tls: { pin: probe.fingerprint256 } });
  expect(got.status).toBe(200);
});

test('pin mode refuses a fingerprint that does not match — a swapped cert is not silently accepted', async () => {
  const { url } = await serveTls(ok);
  await expect(requestCheck({ url, timeoutMs: 2000, tls: { pin: 'AA:BB:CC' } }))
    .rejects.toThrow(/fingerprint/i);
});

test('pin mode with no fingerprint stored refuses rather than trusting anything', async () => {
  const { url } = await serveTls(ok);
  await expect(requestCheck({ url, timeoutMs: 2000, tls: { pin: '' } })).rejects.toThrow();
});

test('a hung server times out, and the error says so distinguishably', async () => {
  const url = await servePlain(() => { /* never responds */ });
  const started = Date.now();
  await expect(requestCheck({ url, timeoutMs: 700 })).rejects.toMatchObject({ timedOut: true });
  expect(Date.now() - started).toBeLessThan(4000);
});

// A refused connection must not be reported the same way as a timeout, or the
// operator cannot tell "nothing is listening" from "too slow to answer".
test('a refused connection rejects without the timedOut marker', async () => {
  await expect(requestCheck({ url: 'http://127.0.0.1:1/x', timeoutMs: 1000 }))
    .rejects.not.toMatchObject({ timedOut: true });
});

// A probe must not be a way to exhaust the prober's own memory. A health
// endpoint that starts streaming gigabytes should cost a bounded read.
test('a response body is capped rather than buffered without limit', async () => {
  const url = await servePlain((_req, res) => {
    res.writeHead(200);
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 40; i++) res.write(chunk); // 2.5 MB
    res.end();
  });
  const got = await requestCheck({ url, timeoutMs: 4000 });
  expect(got.text.length).toBeLessThanOrEqual(256 * 1024);
});

// Probes must not hold connections open on the target — the same rule tcpCheck
// follows by destroying its socket the moment it settles.
test('the connection is not pooled or left open after a response', async () => {
  let open = 0;
  const s = http.createServer(ok);
  s.on('connection', (sock) => { open += 1; sock.on('close', () => { open -= 1; }); });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  await requestCheck({ url, timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 150));
  expect(open).toBe(0);
});
