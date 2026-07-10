import { test, expect } from 'vitest';
import http from 'node:http';
import { testNetbox } from '../src/server/netboxApi.js';

const CA = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 'tok123' };
const ok = { status: 200, json: { 'netbox-version': '4.3.2' }, text: '' };

test('200 /api/status/ resolves ok with the NetBox version', async () => {
  const calls = [];
  const res = await testNetbox(CA, { request: async (o) => { calls.push(o); return ok; } });
  expect(res).toEqual({ ok: true, version: '4.3.2' });
  expect(calls[0].url).toBe('https://netbox.example.com/api/status/');
  expect(calls[0].headers.Authorization).toBe('Token tok123');
});

test('a path-prefixed URL keeps its prefix in the probe URL', async () => {
  const calls = [];
  await testNetbox({ ...CA, url: 'https://example.com/netbox' }, { request: async (o) => { calls.push(o); return ok; } });
  expect(calls[0].url).toBe('https://example.com/netbox/api/status/');
});

test('401/403 map to an auth failure with the allowed-IP hint', async () => {
  const res = await testNetbox(CA, { request: async () => ({ status: 403, json: { detail: 'Invalid token' }, text: '' }) });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
  expect(res.error).toContain('Invalid token');
  expect(res.error).toContain('::ffff:'); // IPv4-mapped-IPv6 allowed-IP hint
});

test('pin mode: fingerprint mismatch reports tls with the observed fingerprint and never sends the token', async () => {
  const calls = [];
  const res = await testNetbox(
    { ...CA, tlsMode: 'pin', fingerprint256: 'AA:BB' },
    { connect: async () => ({ fingerprint256: 'CC:DD', raw: Buffer.from('x'), chain: [Buffer.from('x')] }),
      request: async (o) => { calls.push(o); return ok; } },
  );
  expect(res).toEqual({ ok: false, kind: 'tls', fingerprint256: 'CC:DD', error: expect.stringMatching(/fingerprint/i) });
  expect(calls).toHaveLength(0);
});

test('pin mode: matching fingerprint (case/sep-insensitive) pins the probed chain as CA trust', async () => {
  const calls = [];
  const res = await testNetbox(
    { ...CA, tlsMode: 'pin', fingerprint256: 'aabb' },
    { connect: async () => ({ fingerprint256: 'AA:BB', raw: Buffer.from('x'), chain: [Buffer.from('x'), Buffer.from('y')] }),
      request: async (o) => { calls.push(o); return ok; } },
  );
  expect(res.ok).toBe(true);
  expect(calls[0].tls.rejectUnauthorized).toBe(true);
  expect(calls[0].tls.ca).toHaveLength(2);
  expect(calls[0].tls.ca[0]).toContain('BEGIN CERTIFICATE');
  expect(typeof calls[0].tls.checkServerIdentity).toBe('function');
});

test('ca mode: a certificate verification error probes and offers the observed fingerprint', async () => {
  const err = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const res = await testNetbox(CA, {
    request: async () => { throw err; },
    connect: async () => ({ fingerprint256: 'EE:FF', raw: Buffer.from('x'), chain: [] }),
  });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(res.fingerprint256).toBe('EE:FF');
});

test('connection errors report unreachable', async () => {
  const res = await testNetbox(CA, { request: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  expect(res).toEqual({ ok: false, kind: 'unreachable', error: 'connect ECONNREFUSED' });
});

test('a 200 that is not NetBox reports unexpected', async () => {
  const res = await testNetbox(CA, { request: async () => ({ status: 200, json: { hello: 'world' }, text: '' }) });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unexpected');
});

test('insecure mode passes rejectUnauthorized:false', async () => {
  const calls = [];
  await testNetbox({ ...CA, tlsMode: 'insecure' }, { request: async (o) => { calls.push(o); return ok; } });
  expect(calls[0].tls.rejectUnauthorized).toBe(false);
});

test('plain http works end to end against a real local server (default request impl)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/status/' && req.headers.authorization === 'Token tok123') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 'netbox-version': '4.1.0' }));
    } else { res.statusCode = 403; res.end(JSON.stringify({ detail: 'Invalid token' })); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    expect(await testNetbox({ url, tlsMode: null, fingerprint256: null, token: 'tok123' }))
      .toEqual({ ok: true, version: '4.1.0' });
    const bad = await testNetbox({ url, tlsMode: null, fingerprint256: null, token: 'wrong' });
    expect(bad.kind).toBe('auth');
  } finally { srv.close(); }
});
