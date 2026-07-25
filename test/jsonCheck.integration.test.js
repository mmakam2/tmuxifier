import { test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runJsonCheck, pickPath } from '../src/server/checks/jsonCheck.js';

const servers = [];
afterEach(async () => { while (servers.length) await new Promise((r) => servers.pop().close(r)); });

async function serveJson(payload) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/api`;
}
const check = (url, path, assert) => ({ type: 'json', target: { url, path }, assert, timeoutMs: 2000 });

test('pickPath walks dotted paths and reports missing ones as undefined', () => {
  expect(pickPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  expect(pickPath({ a: {} }, 'a.b.c')).toBeUndefined();
  expect(pickPath(null, 'a')).toBeUndefined();
});

test('greaterThan passes when the field clears the floor', async () => {
  const url = await serveJson({ onlineScore: 0.99 });
  expect((await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0.95 }))).ok).toBe(true);
});

test('greaterThan fails when the field drops below and the detail shows the value', async () => {
  const url = await serveJson({ onlineScore: 0.80 });
  const got = await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0.95 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('0.8');
});

test('equals compares as a string so "OK" and OK behave the same', async () => {
  const url = await serveJson({ quic: { status: 'OK' } });
  expect((await runJsonCheck(check(url, 'quic.status', { equals: 'OK' }))).ok).toBe(true);
  expect((await runJsonCheck(check(url, 'quic.status', { equals: 'BROKEN' }))).ok).toBe(false);
});

test('a missing field fails rather than passing vacuously', async () => {
  const url = await serveJson({ other: 1 });
  const got = await runJsonCheck(check(url, 'onlineScore', { greaterThan: 0 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/missing|not found/i);
});

test('a non-JSON response fails with a readable detail', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('<html>nope'); });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await runJsonCheck(check(`http://127.0.0.1:${server.address().port}/api`, 'a', { equals: 'b' }));
  expect(got.ok).toBe(false);
});

test('no assertion means the fetch itself is the check', async () => {
  const url = await serveJson({ anything: true });
  expect((await runJsonCheck(check(url, 'anything', {}))).ok).toBe(true);
});

// A path naming an inherited property must read as missing. Walking with a bare
// `acc[part]` resolves 'constructor', 'toString', '__proto__' and friends on
// every object alive, so such a path would return a truthy value the operator
// never stored — and with no assertion that is a straight ok:true on a field
// the response does not contain. A false green is the one outcome this system
// cannot afford, so the walk only follows the object's own keys.
test('a path naming an inherited property reads as missing, not as a value', () => {
  expect(pickPath({ a: 1 }, 'constructor')).toBeUndefined();
  expect(pickPath({ a: 1 }, 'toString')).toBeUndefined();
  expect(pickPath({ a: { b: 1 } }, 'a.__proto__')).toBeUndefined();
});

test('an inherited-property path fails the check rather than passing it', async () => {
  const url = await serveJson({ real: 1 });
  const got = await runJsonCheck(check(url, 'constructor', {}));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/missing|not found/i);
});

// The slice's executor contract: never throw, never reject — a throw aborts the
// runner's whole due cycle, so every other check scheduled alongside goes unrun.
// The timer setup in particular has to sit inside the guard: it reads
// check.timeoutMs, so hoisting it above the try turns a malformed stored
// definition into a synchronous throw before the try can catch anything.
test('a missing check object fails rather than throwing', async () => {
  const got = await runJsonCheck(undefined);
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a check with no target fails rather than throwing', async () => {
  const got = await runJsonCheck({ type: 'json', timeoutMs: 500 });
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
