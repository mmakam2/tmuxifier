import { test, expect, afterEach } from 'vitest';
import { createImmichClient, normalizeBase } from '../src/server/immichApi.js';
import { startFakeImmich } from './helpers/fakeImmich.js';

let fake = null;
afterEach(async () => { await fake?.stop(); fake = null; });

const client = (over = {}) => createImmichClient({ baseUrl: fake.baseUrl, apiKey: 'test-key', ttlMs: 0, ...over });

test('normalizeBase strips trailing slashes', () => {
  expect(normalizeBase('https://immich.example.com/')).toBe('https://immich.example.com');
  expect(normalizeBase('https://immich.example.com///')).toBe('https://immich.example.com');
});

// Pasting the API base rather than the web base would otherwise build
// /api/api/server/about and 404 with no clue why.
test('normalizeBase strips a trailing /api segment', () => {
  expect(normalizeBase('https://immich.example.com/api')).toBe('https://immich.example.com');
  expect(normalizeBase('https://immich.example.com/api/')).toBe('https://immich.example.com');
});

test('normalizeBase leaves a path that merely contains api alone', () => {
  expect(normalizeBase('https://example.com/apiary')).toBe('https://example.com/apiary');
});

test('snapshot assembles metrics from the live endpoints', async () => {
  fake = await startFakeImmich();
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBe('v3.0.3');
  expect(res.metrics.photos).toBe(48300);
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.jobs).toEqual({ active: 0, waiting: 0, failed: 0, paused: [] });
  expect(res.metrics.denied).toEqual([]);
});

// The fixture answers 405 to any verb but GET, and a 405 degrades its endpoint
// to null. If any call ever stopped being a GET, the reading it feeds would go
// missing here rather than failing loudly somewhere else.
test('every endpoint is fetched with GET', async () => {
  fake = await startFakeImmich();
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBe('v3.0.3');
  expect(res.metrics.photos).toBe(48300);
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.jobs).not.toBeNull();
  expect(res.metrics.maintenanceMode).toBe(false);
});

test('snapshot reports auth rather than down when the key is rejected', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('auth');
});

// The heart of the degradation contract: a 403 proves the server answered, so
// the tile stays up and only the refused readings go missing.
test('snapshot degrades a 403 endpoint instead of failing the tile', async () => {
  fake = await startFakeImmich({ deny: ['/api/server/statistics', '/api/jobs'] });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.denied).toEqual(expect.arrayContaining(['server.statistics', 'job.read']));
  expect(res.metrics.photos).toBeNull();
  expect(res.metrics.jobs).toBeNull();
  // The permitted endpoints still report.
  expect(res.metrics.diskUsedPct).toBe(39);
  expect(res.metrics.version).toBe('v3.0.3');
});

// An older server that does not implement an endpoint answers 404, which must
// cost that endpoint's readings and nothing else — the same tolerance
// unifiApi.js extends to firmware without /statistics/latest.
test('snapshot degrades a 404 endpoint the same way it degrades a 403', async () => {
  fake = await startFakeImmich({ status: { '/api/server/config': 404 } });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.maintenanceMode).toBe(false);
  expect(res.metrics.denied).toContain('systemConfig.read');
  expect(res.metrics.version).toBe('v3.0.3');
});

test('snapshot reports down only when every endpoint fails at the transport layer', async () => {
  // Port 1 refuses: no listener, so every request errors at the socket.
  const dead = createImmichClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', ttlMs: 0, timeoutMs: 1000 });
  const res = await dead.snapshot();
  expect(res.ok).toBe(false);
  expect(res.kind).toBe('unreachable');
});

test('snapshot tolerates a single endpoint erroring with 500', async () => {
  fake = await startFakeImmich({ status: { '/api/jobs': 500 } });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.jobs).toBeNull();
  expect(res.metrics.photos).toBe(48300);
});

test('snapshot serves the cached result until the ttl expires', async () => {
  fake = await startFakeImmich();
  let t = 1000;
  const c = client({ ttlMs: 30000, now: () => t });
  await c.snapshot();
  const after = fake.counts['/api/server/about'];
  await c.snapshot();
  expect(fake.counts['/api/server/about']).toBe(after); // inside the window: no traffic
  t += 30001;
  await c.snapshot();
  expect(fake.counts['/api/server/about']).toBe(after + 1);
});

test('snapshot does not cache a failure', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const c = client({ ttlMs: 30000, now: () => 1000 });
  await c.snapshot();
  const after = fake.counts.requests;
  await c.snapshot();
  expect(fake.counts.requests).toBeGreaterThan(after);
});

test('probe reports the version and which permissions are missing', async () => {
  fake = await startFakeImmich({ deny: ['/api/server/statistics'] });
  const res = await client().probe();
  expect(res.ok).toBe(true);
  expect(res.version).toBe('v3.0.3');
  expect(res.denied).toEqual(['server.statistics']);
});

test('probe reports a rejected key', async () => {
  fake = await startFakeImmich({ unauthorized: true });
  const res = await client().probe();
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/API key/i);
});

test('an unparseable body degrades that endpoint rather than throwing', async () => {
  fake = await startFakeImmich({ malformed: true });
  const res = await client().snapshot();
  expect(res.ok).toBe(true);
  expect(res.metrics.version).toBeNull();
});
