import { test, expect } from 'vitest';
import { runDnsCheck } from '../src/server/checks/dnsCheck.js';

// The resolver is injected, the same way execCheck takes boxActions/store: a
// real DNS server in-process would test node's resolver, not this executor.
const deps = (answers, { throws = null } = {}) => ({
  now: () => 0,
  makeResolver: () => ({
    resolve: async () => { if (throws) throw throws; return answers; },
  }),
});
const check = (over = {}) => ({
  type: 'dns', target: { server: '192.168.1.2', name: 'example.com', type: 'A' },
  assert: {}, timeoutMs: 3000, ...over,
});

test('a name that resolves passes, and the detail carries the answers', async () => {
  const got = await runDnsCheck(check(), deps(['203.0.113.34']));
  expect(got.ok).toBe(true);
  expect(got.detail).toContain('203.0.113.34');
  expect(got.detail).toContain('192.168.1.2');
});

test('NXDOMAIN fails with the resolver code in the detail', async () => {
  const got = await runDnsCheck(check(), deps(null, { throws: Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('ENOTFOUND');
});

// The false-green case: a resolver that answers with an empty set has not
// resolved anything, and treating "no error" as success would report a broken
// zone as healthy.
test('an empty answer set fails rather than passing vacuously', async () => {
  const got = await runDnsCheck(check(), deps([]));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/no records/i);
});

test('resolvesTo passes when one of the answers matches', async () => {
  const got = await runDnsCheck(
    check({ assert: { resolvesTo: '10.0.0.9' } }), deps(['10.0.0.9', '10.0.0.10']));
  expect(got.ok).toBe(true);
});

test('resolvesTo fails when nothing matches, and the detail shows what came back', async () => {
  const got = await runDnsCheck(
    check({ assert: { resolvesTo: '10.0.0.9' } }), deps(['203.0.113.7']));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('203.0.113.7');
  expect(got.detail).toContain('10.0.0.9');
});

test('a timeout is reported distinguishably from a lookup failure', async () => {
  const got = await runDnsCheck(check(), deps(null, { throws: Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('ETIMEOUT');
});

// MX/TXT/SRV answers are objects or nested arrays, not strings. Rendering them
// as [object Object] would make the detail useless exactly when an operator
// most needs to see what the server actually returned.
test('record types that answer with objects are rendered readably', async () => {
  const mx = await runDnsCheck(
    check({ target: { server: '192.168.1.2', name: 'example.com', type: 'MX' } }),
    deps([{ priority: 10, exchange: 'mail.example.com' }]));
  expect(mx.ok).toBe(true);
  expect(mx.detail).toContain('mail.example.com');
  expect(mx.detail).not.toContain('[object');
});

test('txt records, which nest arrays, are flattened', async () => {
  const got = await runDnsCheck(
    check({ target: { server: '192.168.1.2', name: 'example.com', type: 'TXT' } }),
    deps([['v=spf1 -all']]));
  expect(got.ok).toBe(true);
  expect(got.detail).toContain('v=spf1 -all');
});

test('a runaway answer set is truncated so one check cannot bloat the event log', async () => {
  const got = await runDnsCheck(check(), deps(Array.from({ length: 500 }, (_, i) => `10.0.0.${i % 255}`)));
  expect(got.detail.length).toBeLessThanOrEqual(360);
});

// The slice's executor contract: never throw, never reject — a throw aborts the
// runner's whole due cycle, so every check scheduled alongside goes unrun.
test('a target missing its server or name fails rather than throwing', async () => {
  expect((await runDnsCheck(check({ target: { name: 'example.com' } }), deps([]))).ok).toBe(false);
  expect((await runDnsCheck(check({ target: { server: '192.168.1.2' } }), deps([]))).ok).toBe(false);
});

test('an unsupported record type fails rather than being sent to the resolver', async () => {
  let asked = false;
  const got = await runDnsCheck(
    check({ target: { server: '192.168.1.2', name: 'example.com', type: 'HTTPSSVC' } }),
    { now: () => 0, makeResolver: () => ({ resolve: async () => { asked = true; return []; } }) });
  expect(got.ok).toBe(false);
  expect(asked).toBe(false);
});

test('a resolver that throws on construction fails the check rather than the cycle', async () => {
  const got = await runDnsCheck(check(), {
    now: () => 0,
    makeResolver: () => { throw new Error('bad server address'); },
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('bad server address');
});

test('a missing check object fails rather than throwing', async () => {
  const got = await runDnsCheck(undefined, deps([]));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
