import { test, expect } from 'vitest';
import { CHECK_TYPES } from '../src/server/checkTypes.js';
import { checkFieldsFor, checkFormPayload, IMPLEMENTED_TYPES } from '../src/web/checkForm.ts';

test('each type declares exactly the target fields it needs', () => {
  expect(checkFieldsFor('http').map((f) => f.name)).toEqual(['url']);
  expect(checkFieldsFor('tcp').map((f) => f.name)).toEqual(['host', 'port']);
  expect(checkFieldsFor('json').map((f) => f.name)).toEqual(['url', 'path']);
  expect(checkFieldsFor('exec').map((f) => f.name)).toEqual(['boxId', 'command']);
  expect(checkFieldsFor('heartbeat').map((f) => f.name)).toEqual(['windowSec', 'graceSec']);
});

test('an unknown type yields no fields rather than throwing', () => {
  expect(checkFieldsFor('nope')).toEqual([]);
});

test('the payload nests target fields and coerces numbers', () => {
  const values = {
    label: 'Invoice app', type: 'tcp', severity: 'critical', intervalSec: '30',
    timeoutMs: '5000', failuresBeforeNotify: '2', enabled: true,
    host: '192.168.1.10', port: '443', secret: '',
  };
  expect(checkFormPayload(values)).toEqual({
    label: 'Invoice app', type: 'tcp', severity: 'critical',
    intervalSec: 30, timeoutMs: 5000, failuresBeforeNotify: 2, enabled: true,
    target: { host: '192.168.1.10', port: 443 },
  });
});

test('a blank secret is omitted so an edit never clears the stored one', () => {
  const payload = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h', secret: '   ' });
  expect('secret' in payload).toBe(false);
});

test('a supplied secret is included', () => {
  const payload = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h', secret: 'tok' });
  expect(payload.secret).toBe('tok');
});

// The server's assertCheckInput resets `assert` to {} for any spec that omits
// it, and no form field edits assertions — so a payload that dropped `assert`
// would make an edit of an unrelated field (a label typo, a longer interval)
// silently erase a stored body marker, status range, or JSON comparison,
// downgrading the check to a bare reachability probe that still reports green.
test('an existing assert is carried through so an edit does not erase it', () => {
  const payload = checkFormPayload({
    label: 'x', type: 'http', url: 'https://example.com/h', assert: { bodyIncludes: 'OK' },
  });
  expect(payload.assert).toEqual({ bodyIncludes: 'OK' });
});

test('an absent assert stays absent rather than becoming a junk value', () => {
  const payload = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h' });
  expect('assert' in payload).toBe(false);
});

// The form must never offer a type the dispatcher has no executor for: the
// server would accept the definition (CHECK_TYPES already lists all five), then
// every run would return "no executor for type ...", which folds into a firing
// alert. The operator would be paged about our own missing code. These two
// tests are the guard rail for the slices that add the remaining executors —
// same idea as provisionTools.test.js locking the tool ids to the server's.
test('every offered type is one the server would accept', () => {
  expect(IMPLEMENTED_TYPES.length).toBeGreaterThan(0);
  for (const type of IMPLEMENTED_TYPES) expect(CHECK_TYPES).toContain(type);
});

test('every offered type has target fields to render', () => {
  for (const type of IMPLEMENTED_TYPES) expect(checkFieldsFor(type).length).toBeGreaterThan(0);
});

// Certificate trust reaches the payload only for the types that speak TLS, so a
// tcp/exec/heartbeat check never carries a trust mode that means nothing for it.
test('a tls mode is sent for http and json checks', () => {
  const p = checkFormPayload({ label: 'x', type: 'http', url: 'https://example.com/h', tlsMode: 'insecure' });
  expect(p.tlsMode).toBe('insecure');
});

test('a tls mode is not sent for types that never speak TLS', () => {
  const p = checkFormPayload({ label: 'x', type: 'tcp', host: '192.168.1.10', port: '443', tlsMode: 'insecure' });
  expect('tlsMode' in p).toBe(false);
});

test('a pinned fingerprint is carried, and a blank one is omitted', () => {
  const pinned = checkFormPayload({
    label: 'x', type: 'json', url: 'https://example.com/h', path: 'a', tlsMode: 'pin', fingerprint256: ' AA:BB ',
  });
  expect(pinned.fingerprint256).toBe('AA:BB');
  const blank = checkFormPayload({
    label: 'x', type: 'json', url: 'https://example.com/h', path: 'a', tlsMode: 'ca', fingerprint256: '   ',
  });
  expect('fingerprint256' in blank).toBe(false);
});

test('the offered tls modes match the server list', async () => {
  const { TLS_MODES: serverModes } = await import('../src/server/checkTypes.js');
  const { TLS_MODES } = await import('../src/web/checkForm.ts');
  expect([...TLS_MODES]).toEqual(serverModes);
});
