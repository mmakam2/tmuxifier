import { test, expect, afterEach } from 'vitest';
import { createUnifiClient } from '../src/server/unifiApi.js';
import { startFakeUnifi } from './helpers/fakeUnifi.js';
import { SITES } from './helpers/unifiSamples.js';

let fake = null;
afterEach(async () => { await fake?.stop(); fake = null; });

const client = (over = {}) => createUnifiClient({ baseUrl: fake.baseUrl, apiKey: 'test-key', ...over });

test('snapshot assembles metrics from the live endpoints', async () => {
  fake = await startFakeUnifi();
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.clientsTotal).toBe(5);
  expect(res.metrics.gateway.name).toBe('Border Gateway');
  expect(res.metrics.networks).toBe(3);
  expect(res.metrics.offline).toHaveLength(1);
});

test('snapshot resolves the site once and reuses it', async () => {
  fake = await startFakeUnifi();
  const c = client({ ttlMs: 0 });
  await c.snapshot();
  await c.snapshot();
  expect(fake.counts.sites).toBe(1);
  expect(fake.counts.devices).toBe(2);
});

test('snapshot serves the cached result until the ttl expires', async () => {
  fake = await startFakeUnifi();
  let t = 1000;
  const c = client({ ttlMs: 30000, now: () => t });
  await c.snapshot();
  const after = fake.counts.devices;
  await c.snapshot();
  expect(fake.counts.devices).toBe(after); // inside the window: no traffic
  t += 30001;
  await c.snapshot();
  expect(fake.counts.devices).toBe(after + 1);
});

test('snapshot reports auth rather than down when the key is rejected', async () => {
  fake = await startFakeUnifi({ unauthorized: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
});

test('snapshot does not cache a failure', async () => {
  fake = await startFakeUnifi({ unauthorized: true });
  const c = client();
  await c.snapshot();
  await c.snapshot();
  // Every reply is a 401, so the per-endpoint counters never advance past the
  // auth gate — the arrival count is what proves the second call was retried.
  expect(fake.counts.requests).toBe(2);
});

test('snapshot degrades when the networks endpoint is absent', async () => {
  fake = await startFakeUnifi({ networks: null });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.networks).toBeNull();
  expect(res.metrics.clientsTotal).toBe(5);
});

test('snapshot degrades when the statistics endpoint is absent', async () => {
  fake = await startFakeUnifi({ statsStatus: 404 });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.gateway.cpuPct).toBeNull();
  expect(res.metrics.wanTxBps).toBeNull();
  expect(res.metrics.wanState).toBe('up'); // state comes from the device list
});

test('snapshot selects a site by its internal reference', async () => {
  const sites = {
    ...SITES,
    count: 2,
    totalCount: 2,
    data: [
      { id: 'site-other', internalReference: 'other', name: 'Other' },
      { id: 'site-0001', internalReference: 'default', name: 'Default' },
    ],
  };
  fake = await startFakeUnifi({ sites });
  const res = await client({ site: 'default' }).snapshot();
  expect(res.ok).toBe(true);
});

test('snapshot reports unexpected when the named site does not exist', async () => {
  fake = await startFakeUnifi();
  const res = await client({ site: 'nope' }).snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unexpected');
  expect(res.error).toMatch(/nope/);
});

test('snapshot reports unexpected on a malformed body', async () => {
  fake = await startFakeUnifi({ malformed: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unexpected');
});

test('snapshot reports unreachable when nothing is listening', async () => {
  fake = await startFakeUnifi();
  const base = fake.baseUrl;
  await fake.stop();
  fake = null;
  const res = await createUnifiClient({ baseUrl: base, apiKey: 'test-key' }).snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('probe returns the site list for the settings form', async () => {
  fake = await startFakeUnifi();
  const res = await client().probe();
  expect(res.ok).toBe(true);
  expect(res.sites).toEqual([{ id: 'site-0001', name: 'Default', reference: 'default' }]);
});

test('probe reports auth without leaking the key', async () => {
  fake = await startFakeUnifi({ unauthorized: true });
  const res = await client().probe();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
  expect(JSON.stringify(res)).not.toContain('test-key');
});

// `connect` is always injected: probe() reaches for the served fingerprint on an
// https base, and an un-injected tlsProbe would make a real network call out of
// a unit test.
const capture = (fingerprint256 = null) => {
  const calls = [];
  const request = async (opts) => { calls.push(opts); return { status: 200, json: SITES }; };
  return { calls, request, connect: async () => ({ fingerprint256 }) };
};

test('tls: certificates are verified by default', async () => {
  const { calls, request, connect } = capture();
  await createUnifiClient({ baseUrl: 'https://unifi.example.com', apiKey: 'k', request, connect }).probe();
  expect(calls[0].tls).toEqual({});
});

test('tls: verification is disabled only in insecure mode', async () => {
  const { calls, request, connect } = capture();
  await createUnifiClient({ baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'insecure', request, connect }).probe();
  expect(calls[0].tls).toEqual({ rejectUnauthorized: false });
});

test('tls: pin mode probes the certificate then pins the request', async () => {
  const { calls, request, connect } = capture('AA:BB:CC');
  await createUnifiClient({
    baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: 'aabbcc', request, connect,
  }).probe();
  expect(calls[0].tls).toEqual({ pin: 'aabbcc' });
});

test('tls: a fingerprint mismatch fails closed and sends no request', async () => {
  const { calls, request } = capture();
  const connect = async () => ({ fingerprint256: 'DD:EE:FF' });
  const res = await createUnifiClient({
    baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: 'aabbcc', request, connect,
  }).snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(res.error).toMatch(/fingerprint mismatch/i);
  expect(calls).toHaveLength(0); // the key was never written to the wire
});

test('tls: pin mode with no fingerprint stored refuses rather than trusting', async () => {
  const { calls, request } = capture();
  const connect = async () => ({ fingerprint256: 'AA:BB:CC' });
  const res = await createUnifiClient({
    baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: '', request, connect,
  }).snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(calls).toHaveLength(0);
});

// B2 (2026-07-29 review): pin-mode arming was a dead loop. probe() calls
// listSites() first, so resolveTls() threw "no fingerprint pinned yet — run
// Test connection" *before* attaching the fingerprint it had just observed, and
// asResult dropped everything but { ok, kind, error }. The route's error-path
// spread therefore never fired and the operator had no way to obtain the pin,
// which pushed self-signed controllers to `insecure` — the outcome pinning
// exists to prevent. The TOFU moment must hand back what it saw.
test('tls: pin mode with no fingerprint stored hands back the served fingerprint to arm with', async () => {
  const { calls, request } = capture();
  const connect = async () => ({ fingerprint256: 'AA:BB:CC' });
  const res = await createUnifiClient({
    baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: '', request, connect,
  }).probe();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(res.fingerprint256).toBe('AA:BB:CC');
  expect(calls).toHaveLength(0); // still never on the wire
});

// The mismatch case is deliberately NOT offered for re-pinning: Tmuxifier never
// re-pins automatically, the same posture it takes toward a changed SSH host key.
test('tls: a fingerprint mismatch never hands back the new fingerprint', async () => {
  const { calls, request } = capture();
  const connect = async () => ({ fingerprint256: 'DD:EE:FF' });
  const res = await createUnifiClient({
    baseUrl: 'https://unifi.example.com', apiKey: 'k', tls: 'pin', fingerprint: 'aabbcc', request, connect,
  }).probe();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('tls');
  expect(res.fingerprint256).toBeUndefined();
  expect(calls).toHaveLength(0);
});

// E2 (2026-07-29 review). Per-device statistics were fetched in a serial `for`
// loop with an await inside, so a refresh cost one round trip per device in
// sequence — up to 200 on a large site, and every one of them holding up the
// snapshot that the whole tile (and, through the shared sweep, every other
// tile's freshness) waits on.
//
// A request count cannot tell a serial loop from a parallel one; the fake
// records the high-water mark of concurrent statistics requests instead, which
// is the actual property under test.
test('device statistics are fetched concurrently, not one after another', async () => {
  fake = await startFakeUnifi({ statsDelayMs: 40 });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  // Four devices in the fixture: serial would peak at 1.
  expect(fake.counts.stats).toBe(4);
  expect(fake.counts.maxConcurrentStats).toBeGreaterThan(1);
});

// Concurrency is bounded on purpose rather than unleashed: a site with 200
// devices would otherwise open 200 sockets at once against a controller that is
// often a consumer gateway, which is the same burst-avoidance reasoning behind
// mapWithConcurrency's use for SSH probes.
test('device statistics concurrency is bounded, not unbounded', async () => {
  fake = await startFakeUnifi({ statsDelayMs: 40 });
  await client().snapshot();
  expect(fake.counts.maxConcurrentStats).toBeLessThanOrEqual(6);
});

// Serial-to-parallel must not change what the card reads.
test('concurrent statistics still land against the right device', async () => {
  fake = await startFakeUnifi({ statsDelayMs: 5 });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.gateway.name).toBe('Border Gateway');
  expect(res.metrics.clientsTotal).toBe(5);
});
