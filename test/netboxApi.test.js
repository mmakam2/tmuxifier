import { test, expect } from 'vitest';
import http from 'node:http';
import { testNetbox, createNetboxClient, firstUsableIp } from '../src/server/netboxApi.js';

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

test('pin mode: no fingerprint pinned yet reports tls with the observed fingerprint and never sends the token', async () => {
  const calls = [];
  const res = await testNetbox(
    { ...CA, tlsMode: 'pin', fingerprint256: null },
    { connect: async () => ({ fingerprint256: 'CC:DD', raw: Buffer.from('x'), chain: [Buffer.from('x')] }),
      request: async (o) => { calls.push(o); return ok; } },
  );
  expect(res).toEqual({ ok: false, kind: 'tls', fingerprint256: 'CC:DD', error: expect.stringMatching(/no fingerprint pinned yet/i) });
  expect(res.error).not.toMatch(/mismatch/i);
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

const NB = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 'tok123' };

test('findPrefixByVlan resolves exactly-one and throws on 0/many', async () => {
  const calls = [];
  const mk = (results) => createNetboxClient(NB, { request: async (o) => { calls.push(o); return { status: 200, json: { results }, text: '' }; } });
  await expect(mk([{ id: 7, prefix: '192.168.30.0/24' }]).findPrefixByVlan(30)).resolves.toEqual({ id: 7, prefix: '192.168.30.0/24' });
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/?vlan_vid=30');
  expect(calls[0].method).toBe('GET');
  expect(calls[0].headers.Authorization).toBe('Token tok123');
  await expect(mk([]).findPrefixByVlan(31)).rejects.toThrow('no NetBox prefix for VLAN 31');
  await expect(mk([{ id: 1 }, { id: 2 }]).findPrefixByVlan(32)).rejects.toThrow(/multiple NetBox prefixes/);
});

test('firstUsableIp: network + 1, and tiny prefixes are rejected', () => {
  expect(firstUsableIp('192.168.3.0/24')).toBe('192.168.3.1');
  expect(firstUsableIp('10.20.0.0/16')).toBe('10.20.0.1');
  expect(firstUsableIp('192.168.3.128/30')).toBe('192.168.3.129');
  expect(firstUsableIp('192.168.3.77/24')).toBe('192.168.3.1'); // non-canonical base normalizes
  expect(() => firstUsableIp('192.168.3.0/31')).toThrow(/too small/);
  expect(() => firstUsableIp('192.168.3.4/32')).toThrow(/too small/);
  expect(() => firstUsableIp('not-a-prefix')).toThrow(/unparseable/);
});

test('allocateIp skips the gateway and reserves the first other available address', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => {
    calls.push(o);
    if (o.method === 'GET') return { status: 200, json: [{ address: '192.168.3.1/24' }, { address: '192.168.3.5/24' }], text: '' };
    return { status: 201, json: { id: 99, address: '192.168.3.5/24' }, text: '' };
  } });
  const res = await client.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, { status: 'active', description: 'tmuxifier: dev-01' });
  expect(res).toEqual({ id: 99, address: '192.168.3.5/24', gateway: '192.168.3.1' });
  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/prefixes/7/available-ips/');
  expect(calls[1].method).toBe('POST');
  expect(calls[1].url).toBe('https://netbox.example.com/api/ipam/ip-addresses/');
  expect(calls[1].body).toEqual({ address: '192.168.3.5/24', status: 'active', description: 'tmuxifier: dev-01' });
});

test('allocateIp: only the gateway left (or nothing) means prefix full', async () => {
  const gwOnly = createNetboxClient(NB, { request: async () => ({ status: 200, json: [{ address: '192.168.3.1/24' }], text: '' }) });
  await expect(gwOnly.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, {})).rejects.toThrow('prefix 192.168.3.0/24 has no available IPs');
  const empty = createNetboxClient(NB, { request: async () => ({ status: 200, json: [], text: '' }) });
  await expect(empty.allocateIp({ id: 7, prefix: '192.168.3.0/24' }, {})).rejects.toThrow('has no available IPs');
});

test('releaseIp DELETEs the ip-address record and tolerates an empty 204 body', async () => {
  const calls = [];
  const client = createNetboxClient(NB, { request: async (o) => { calls.push(o); return { status: 204, json: null, text: '' }; } });
  await client.releaseIp(99);
  expect(calls[0].url).toBe('https://netbox.example.com/api/ipam/ip-addresses/99/');
  expect(calls[0].method).toBe('DELETE');
});

test('client surfaces NetBox detail on 4xx and never embeds the token', async () => {
  const client = createNetboxClient(NB, { request: async () => ({ status: 403, json: { detail: 'Invalid token' }, text: '' }) });
  const err = await client.findPrefixByVlan(30).catch((e) => e);
  expect(err.message).toContain('403');
  expect(err.message).toContain('Invalid token');
  expect(err.message).not.toContain('tok123');
});

test('client pin mode withholds the authenticated request on fingerprint mismatch', async () => {
  const calls = [];
  const client = createNetboxClient(
    { ...NB, tlsMode: 'pin', fingerprint256: 'AA:BB' },
    { connect: async () => ({ fingerprint256: 'CC:DD', raw: Buffer.from('x'), chain: [Buffer.from('x')] }),
      request: async (o) => { calls.push(o); return { status: 200, json: { results: [] }, text: '' }; } },
  );
  await expect(client.findPrefixByVlan(30)).rejects.toThrow(/fingerprint mismatch/);
  expect(calls).toHaveLength(0);
});

test('jsonRequest POSTs JSON with fixed Content-Length against a real local server', async () => {
  const http = await import('node:http');
  let seen = null;
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') { res.end(JSON.stringify([{ address: '192.168.30.50/24' }])); return; }
      seen = { method: req.method, type: req.headers['content-type'], length: req.headers['content-length'], transfer: req.headers['transfer-encoding'] || null, data };
      res.end(JSON.stringify({ id: 1, address: '192.168.30.50/24' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const client = createNetboxClient({ url, tlsMode: null, fingerprint256: null, token: 't' });
    const res = await client.allocateIp({ id: 5, prefix: '192.168.30.0/24' }, { status: 'active' });
    expect(res).toEqual({ id: 1, address: '192.168.30.50/24' });
    expect(seen.method).toBe('POST');
    expect(seen.type).toBe('application/json');
    expect(seen.transfer).toBeNull();               // fixed Content-Length, not chunked
    expect(Number(seen.length)).toBe(Buffer.byteLength(seen.data));
    expect(JSON.parse(seen.data)).toEqual({ address: '192.168.30.50/24', status: 'active' });
  } finally { srv.close(); }
});
