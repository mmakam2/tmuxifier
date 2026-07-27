import { test, expect, afterEach } from 'vitest';
import { createTruenasClient } from '../src/server/truenasApi.js';
import { startFakeTruenas, DEFAULT_POOLS, DEFAULT_INFO } from './helpers/fakeTruenas.js';

let nas = null;
let client = null;
afterEach(async () => {
  if (client) await client.close();
  if (nas) await nas.stop();
  client = null;
  nas = null;
});

const connect = (extra = {}) => createTruenasClient({
  baseUrl: nas.baseUrl, username: 'truenas_admin', apiKey: '1-testkey', timeoutMs: 5000, ...extra,
});

test('logs in once and maps pools, alerts, version and uptime', async () => {
  nas = await startFakeTruenas();
  client = connect();

  const res = await client.fetchMetrics();
  expect(res.ok).toBe(true);
  expect(res.metrics.pools).toHaveLength(2);
  expect(res.metrics.pools[0]).toMatchObject({
    name: 'tank', size: DEFAULT_POOLS[0].size, free: DEFAULT_POOLS[0].free, healthy: true, status: 'ONLINE', scanning: false,
  });
  expect(res.metrics.pools[0].usedPct).toBeCloseTo(68.0, 0);
  // INFO is ignored; the CRITICAL one is dismissed, so only the WARNING counts.
  expect(res.metrics.alerts).toEqual({ critical: 0, warning: 1 });
  expect(res.metrics.version).toBe(DEFAULT_INFO.version);
  expect(res.metrics.hostname).toBe('nas');
  expect(res.metrics.uptimeSec).toBe(DEFAULT_INFO.uptime_seconds);
  expect(nas.counts.login).toBe(1);
});

test('a second sweep reuses the socket and does not log in again', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  await client.fetchMetrics();
  expect(nas.counts.login).toBe(1);
  expect(nas.counts.connections).toBe(1);
  expect(nas.counts.pool).toBe(2);
});

test('concurrent first calls share a single login', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await Promise.all([client.fetchMetrics(), client.fetchMetrics(), client.fetchMetrics()]);
  expect(nas.counts.login).toBe(1);
});

test('a wrong key resolves as auth, not as a throw, and never echoes the key', async () => {
  nas = await startFakeTruenas();
  client = connect({ apiKey: '1-wrongkey' });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
  expect(res.error).toMatch(/rejected/i);
  expect(res.error).not.toContain('1-wrongkey');
});

test('an expired key and an OTP-required account report distinct reasons', async () => {
  nas = await startFakeTruenas({ responseType: 'EXPIRED' });
  client = connect();
  expect((await client.fetchMetrics()).error).toMatch(/expired/i);
  await client.close();
  await nas.stop();

  nas = await startFakeTruenas({ responseType: 'OTP_REQUIRED' });
  client = connect();
  expect((await client.fetchMetrics()).error).toMatch(/one-time password/i);
});

test('a mid-session expiry re-logs-in exactly once and replays the calls', async () => {
  // Three data calls per sweep: sweep one succeeds, sweep two finds the session dead.
  nas = await startFakeTruenas({ expireAfterCalls: 3 });
  client = connect();
  expect((await client.fetchMetrics()).ok).toBe(true);
  const second = await client.fetchMetrics();
  expect(second.ok).toBe(true);
  expect(nas.counts.login).toBe(2);
});

test('a socket that closed between sweeps reconnects on the next call', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  for (const c of nas.wssClients) c.close();
  await new Promise((r) => setTimeout(r, 50));
  const again = await client.fetchMetrics();
  expect(again.ok).toBe(true);
  expect(nas.counts.connections).toBe(2);
});

test('an unreachable NAS resolves as down', async () => {
  client = createTruenasClient({
    baseUrl: 'http://127.0.0.1:1', username: 'truenas_admin', apiKey: '1-testkey', timeoutMs: 2000,
  });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('an unparseable frame resolves as a failure rather than throwing', async () => {
  nas = await startFakeTruenas({ malformed: true });
  client = connect({ timeoutMs: 1000 });
  const res = await client.fetchMetrics();
  expect(res.ok).toBe(false);
});

test('close logs out so the session is not leaked', async () => {
  nas = await startFakeTruenas();
  client = connect();
  await client.fetchMetrics();
  await client.close();
  await new Promise((r) => setTimeout(r, 50));
  expect(nas.counts.logout).toBe(1);
  client = null;
});

test('fetchVersion reads system.info only', async () => {
  nas = await startFakeTruenas();
  client = connect();
  const res = await client.fetchVersion();
  expect(res).toMatchObject({ ok: true, version: '25.10.5', hostname: 'nas' });
  expect(nas.counts.pool).toBe(0);
});

test('a pool with a scrub running and a null size is reported without dividing by zero', async () => {
  nas = await startFakeTruenas({
    pools: [{ name: 'odd', size: null, allocated: null, free: null, healthy: false, status: 'DEGRADED', scan: { state: 'SCANNING' } }],
  });
  client = connect();
  const { metrics } = await client.fetchMetrics();
  expect(metrics.pools[0]).toMatchObject({ usedPct: null, healthy: false, status: 'DEGRADED', scanning: true });
});
