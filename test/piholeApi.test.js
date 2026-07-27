import { test, expect } from 'vitest';
import { createPiholeClient } from '../src/server/piholeApi.js';
import { startFakePihole, DEFAULT_VERSION } from './helpers/fakePihole.js';

test('fetchSummary authenticates once and maps every metric', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();

  expect(res.ok).toBe(true);
  expect(res.metrics).toEqual({
    blocking: 'enabled',
    blockingTimer: null,
    queriesTotal: 48132,
    queriesBlocked: 10780,
    percentBlocked: 22.396,
    clientsActive: 31,
    clientsTotal: 54,
    gravityDomains: 1284933,
    versionCore: 'v6.2.1',
    versionWeb: 'v6.2',
    versionFtl: 'v6.2.3',
    updateAvailable: false,
    uptimeSec: 1220400,
  });
  expect(pi.counts.auth).toBe(1);
});

test('the session is reused across calls — one auth for three sweeps', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  await client.fetchSummary();
  await client.fetchSummary();
  await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(pi.counts.auth).toBe(1);
});

test('concurrent calls share a single authentication', async () => {
  const pi = await startFakePihole({ delayMs: 5 });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const all = await Promise.all([client.fetchSummary(), client.fetchSummary(), client.fetchSummary()]);
  await client.close();
  await pi.stop();
  expect(all.every((r) => r.ok)).toBe(true);
  expect(pi.counts.auth).toBe(1);
});

test('the session is renewed before its advertised validity expires', async () => {
  const pi = await startFakePihole({ validity: 100 });
  let clock = 1_000_000;
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw', now: () => clock });
  await client.fetchSummary();
  clock += 79 * 1000; // still inside the 80% window
  await client.fetchSummary();
  expect(pi.counts.auth).toBe(1);
  clock += 2 * 1000; // now past it
  await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(pi.counts.auth).toBe(2);
});

test('a 401 mid-flight re-authenticates once and retries', async () => {
  const pi = await startFakePihole({ expireSidAfter: 4 }); // first sweep's 4 reads succeed
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  expect((await client.fetchSummary()).ok).toBe(true);
  const second = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(second.ok).toBe(false); // the fake never stops 401ing, so the retry fails too
  expect(second.kind).toBe('auth');
  expect(pi.counts.auth).toBe(2); // exactly one re-auth, no loop
});

test('a rejected password is an auth failure that never leaks the password', async () => {
  const pi = await startFakePihole({ password: 'right' });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'wrong' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res).toMatchObject({ ok: false, kind: 'auth' });
  expect(res.error).toMatch(/app password/i);
  expect(res.error).not.toContain('wrong');
});

test('a TOTP-protected Pi-hole reports the app-password remedy', async () => {
  const pi = await startFakePihole({ totp: true });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.kind).toBe('auth');
  expect(res.error).toMatch(/app password/i);
});

test('an unreachable host is an unreachable failure, not a throw', async () => {
  const pi = await startFakePihole();
  const { baseUrl } = pi;
  await pi.stop();
  const client = createPiholeClient({ baseUrl, password: 'app-pw', timeoutMs: 500 });
  const res = await client.fetchSummary();
  await client.close();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('malformed JSON is a parse failure, not a throw', async () => {
  const pi = await startFakePihole({ malformed: true });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.ok).toBe(false);
  expect(['parse', 'auth']).toContain(res.kind);
});

test('updateAvailable is set when any component has a newer remote version', async () => {
  const version = JSON.parse(JSON.stringify(DEFAULT_VERSION));
  version.version.ftl.remote.version = 'v6.3.0';
  const pi = await startFakePihole({ version });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.metrics.updateAvailable).toBe(true);
});

test('a disabled Pi-hole reports its re-enable timer', async () => {
  const pi = await startFakePihole({ blocking: { blocking: 'disabled', timer: 1680 } });
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.metrics.blocking).toBe('disabled');
  expect(res.metrics.blockingTimer).toBe(1680);
});

test('close revokes the session and is safe to call twice', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  await client.fetchSummary();
  await client.close();
  await client.close();
  await pi.stop();
  expect(pi.counts.delete).toBe(1);
});

test('fetchVersion reads only the version endpoint', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: pi.baseUrl, password: 'app-pw' });
  const res = await client.fetchVersion();
  await client.close();
  await pi.stop();
  expect(res).toEqual({ ok: true, version: 'v6.2.1' });
  expect(pi.counts.summary).toBe(0);
});

test('a trailing slash on the base URL does not double up in the path', async () => {
  const pi = await startFakePihole();
  const client = createPiholeClient({ baseUrl: `${pi.baseUrl}/`, password: 'app-pw' });
  const res = await client.fetchSummary();
  await client.close();
  await pi.stop();
  expect(res.ok).toBe(true);
});
