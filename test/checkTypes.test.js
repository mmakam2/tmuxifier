// test/checkTypes.test.js
import { test, expect } from 'vitest';
import { assertCheckInput, CHECK_TYPES, SEVERITIES } from '../src/server/checkTypes.js';

const base = { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } };

test('a minimal http check normalizes with defaults applied', () => {
  expect(assertCheckInput(base)).toEqual({
    label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' },
    assert: {}, intervalSec: 60, timeoutMs: 10000, severity: 'warning',
    failuresBeforeNotify: 3, enabled: true,
  });
});

test('every supported type is accepted', () => {
  expect(CHECK_TYPES).toEqual(['http', 'tcp', 'json', 'exec', 'heartbeat']);
});

test('an unknown type is refused', () => {
  expect(() => assertCheckInput({ ...base, type: 'carrier-pigeon' })).toThrow(/type/);
});

test('a blank label is refused', () => {
  expect(() => assertCheckInput({ ...base, label: '   ' })).toThrow(/label/);
});

test('an http check without a url is refused', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'http', target: {} })).toThrow(/url/);
});

test('a non-http(s) url is refused so a check can never reach file: or a unix socket', () => {
  expect(() => assertCheckInput({ ...base, target: { url: 'file:///etc/passwd' } })).toThrow(/http/);
});

test('an exec check requires a boxId and a command', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'exec', target: { boxId: 'b1' } })).toThrow(/command/);
  expect(assertCheckInput({ label: 'x', type: 'exec', target: { boxId: 'b1', command: 'true' } }).target)
    .toEqual({ boxId: 'b1', command: 'true' });
});

test('a tcp check requires host and a port in range', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h' } })).toThrow(/port/);
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 70000 } })).toThrow(/port/);
});

test('tcp also requires host on its own, not just a port', () => {
  // The brief's own test only ever supplies host and omits port; a host check
  // that silently no-ops (or a t.host.trim() call with nothing behind it) would
  // still throw *something*, but never a message naming the actual problem.
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { port: 5432 } })).toThrow(/host/);
});

test('tcp port 65536 -- one past the valid maximum -- is refused, not just 70000', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 65536 } })).toThrow(/port/);
});

test('a heartbeat check requires a positive window', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'heartbeat', target: {} })).toThrow(/windowSec/);
  expect(assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 3600 } }).target.windowSec).toBe(3600);
});

test('interval and timeout are clamped to sane bounds rather than trusted', () => {
  expect(assertCheckInput({ ...base, intervalSec: 1 }).intervalSec).toBe(10);
  expect(assertCheckInput({ ...base, intervalSec: 999999 }).intervalSec).toBe(86400);
  expect(assertCheckInput({ ...base, timeoutMs: 5 }).timeoutMs).toBe(1000);
});

test('an unknown severity is refused rather than silently defaulted', () => {
  expect(() => assertCheckInput({ ...base, severity: 'apocalyptic' })).toThrow(/severity/);
});

test('an empty-string severity is refused, not coerced to the default the way `||` would', () => {
  // severity: undefined is the *only* case that defaults; '' is falsy but not
  // undefined, so a `s.severity || 'warning'` default (instead of an
  // `=== undefined` check) would silently accept it as if it were absent.
  expect(() => assertCheckInput({ ...base, severity: '' })).toThrow(/severity/);
});

// --- Additional tests closing gaps left by the brief's 12: each of these
// fails against a plausible broken implementation that still passes every
// test above (a field checked for one type but not another, a clamp bound
// enforced on only one side, a `||`/`??` mix-up on zero, a stripped `.trim()`,
// an `id` that leaks through from caller input).

test('every CHECK_TYPES entry actually validates and normalizes, not just the ones the brief happened to exercise', () => {
  // json needs both url and path -- neither field is optional for it.
  expect(() => assertCheckInput({ label: 'x', type: 'json', target: { path: '$.ok' } })).toThrow(/url/);
  expect(() => assertCheckInput({ label: 'x', type: 'json', target: { url: 'https://api.example.com/health' } }))
    .toThrow(/path/);
  expect(assertCheckInput({
    label: 'x', type: 'json', target: { url: 'https://api.example.com/health', path: '$.ok' },
  }).target).toEqual({ url: 'https://api.example.com/health', path: '$.ok' });
});

test('exec also requires boxId on its own, not just command', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'exec', target: { command: 'true' } })).toThrow(/boxId/);
});

test('tcp port range is enforced at both edges, not just the upper one the brief tests', () => {
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 0 } })).toThrow(/port/);
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: -1 } })).toThrow(/port/);
  expect(() => assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 80.5 } })).toThrow(/port/);
});

test('tcp port boundaries 1 and 65535 are accepted exactly, not clamped away', () => {
  expect(assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 1 } }).target.port).toBe(1);
  expect(assertCheckInput({ label: 'x', type: 'tcp', target: { host: 'h', port: 65535 } }).target.port).toBe(65535);
});

test('heartbeat rejects a zero or negative window, not merely a missing one', () => {
  // target: {} above only exercises the Number.isInteger(NaN) branch of the OR;
  // these pin the `windowSec < 1` branch, which a NaN-only test never reaches.
  expect(() => assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 0 } })).toThrow(/windowSec/);
  expect(() => assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: -5 } })).toThrow(/windowSec/);
});

test('heartbeat rejects a fractional window, not just non-numeric or non-positive ones', () => {
  // The 0/-5 cases above and the missing-windowSec case both fail Number.isFinite
  // too, so they can't distinguish Number.isInteger from a weakened
  // Number.isFinite swap. A fractional, finite, positive value is the only
  // input that tells the two predicates apart.
  expect(() => assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 10.5 } })).toThrow(/windowSec/);
});

test('heartbeat graceSec defaults to 0 and is clamped independently of windowSec', () => {
  expect(assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 3600 } }).target)
    .toEqual({ windowSec: 3600, graceSec: 0 });
  expect(assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 3600, graceSec: -5 } }).target.graceSec)
    .toBe(0);
  expect(assertCheckInput({ label: 'x', type: 'heartbeat', target: { windowSec: 3600, graceSec: 999999 } }).target.graceSec)
    .toBe(86400);
});

test('a plain http:// url is accepted, not only https://', () => {
  expect(assertCheckInput({ ...base, target: { url: 'http://192.168.1.10:8080/status' } }).target)
    .toEqual({ url: 'http://192.168.1.10:8080/status' });
});

test('an ftp url is refused the same way file: is, so the allowlist is http(s)-only, not merely file-excluding', () => {
  expect(() => assertCheckInput({ ...base, target: { url: 'ftp://example.com/file' } })).toThrow(/http/);
});

test('a whitespace-only url is refused, not just a missing one', () => {
  expect(() => assertCheckInput({ ...base, target: { url: '   ' } })).toThrow(/url/);
});

test('a missing or blank url is refused by its own explicit check, not merely by new URL() rejecting it downstream', () => {
  // Both a missing url and new URL("") throw *some* url-flavored error, so a
  // loose /url/ regex can't tell "the explicit guard ran" from "the guard was
  // deleted and the URL constructor happened to fail anyway". Pinning the exact
  // message closes that gap.
  expect(() => assertCheckInput({ label: 'x', type: 'http', target: {} })).toThrow('target.url is required');
  expect(() => assertCheckInput({ ...base, target: { url: '   ' } })).toThrow('target.url is required');
});

test('a malformed url string is refused rather than reaching the executor unparsed', () => {
  expect(() => assertCheckInput({ ...base, target: { url: 'not a url' } })).toThrow(/url/);
});

test('clamped numeric fields hold their exact min and max boundary values unchanged', () => {
  expect(assertCheckInput({ ...base, intervalSec: 10 }).intervalSec).toBe(10);
  expect(assertCheckInput({ ...base, intervalSec: 86400 }).intervalSec).toBe(86400);
  expect(assertCheckInput({ ...base, timeoutMs: 1000 }).timeoutMs).toBe(1000);
  expect(assertCheckInput({ ...base, timeoutMs: 120000 }).timeoutMs).toBe(120000);
  expect(assertCheckInput({ ...base, failuresBeforeNotify: 1 }).failuresBeforeNotify).toBe(1);
  expect(assertCheckInput({ ...base, failuresBeforeNotify: 1000 }).failuresBeforeNotify).toBe(1000);
});

test('zero clamps to the lower bound rather than falling back to the default the way `||` would', () => {
  expect(assertCheckInput({ ...base, intervalSec: 0 }).intervalSec).toBe(10);
  expect(assertCheckInput({ ...base, timeoutMs: 0 }).timeoutMs).toBe(1000);
  expect(assertCheckInput({ ...base, failuresBeforeNotify: 0 }).failuresBeforeNotify).toBe(1);
});

test('a negative interval clamps to the lower bound, not the upper one', () => {
  expect(assertCheckInput({ ...base, intervalSec: -100 }).intervalSec).toBe(10);
});

test('a fractional numeric field truncates rather than rounds', () => {
  expect(assertCheckInput({ ...base, intervalSec: 60.9 }).intervalSec).toBe(60);
});

test('every declared severity is accepted, not only the default', () => {
  expect(assertCheckInput({ ...base, severity: 'critical' }).severity).toBe('critical');
  expect(assertCheckInput({ ...base, severity: 'info' }).severity).toBe('info');
  expect(SEVERITIES).toEqual(['critical', 'warning', 'info']);
});

test('enabled: false is preserved, not coerced true by a careless default fallback', () => {
  expect(assertCheckInput({ ...base, enabled: false }).enabled).toBe(false);
});

test('enabled is normalized to a strict boolean, not passed through as whatever truthy/falsy value arrived', () => {
  // enabled: false alone can't tell a dropped `!!` apart from a correct
  // `=== undefined` ternary, since !!false === false either way. A non-boolean
  // falsy/truthy value is what actually exercises the coercion.
  expect(assertCheckInput({ ...base, enabled: 0 }).enabled).toBe(false);
  expect(assertCheckInput({ ...base, enabled: 1 }).enabled).toBe(true);
});

test('a caller-supplied assert object is carried through unchanged', () => {
  expect(assertCheckInput({ ...base, assert: { statusCode: 200 } }).assert).toEqual({ statusCode: 200 });
});

test('assert is defensively copied, not the same reference the caller passed in', () => {
  // toEqual above is deep-equality only, so it can't tell a copy apart from the
  // original object -- a store (Task 5) that freezes or later mutates its own
  // copy must not be able to reach back into the caller's object, or vice versa.
  const input = { statusCode: 200 };
  const out = assertCheckInput({ ...base, assert: input });
  expect(out.assert).not.toBe(input);
});

test('label, host, command, boxId, and path are trimmed, not merely checked for non-blankness', () => {
  expect(assertCheckInput({ ...base, label: '  Invoice app  ' }).label).toBe('Invoice app');
  expect(assertCheckInput({ label: 'x', type: 'tcp', target: { host: '  h  ', port: 1 } }).target.host).toBe('h');
  expect(assertCheckInput({ label: 'x', type: 'exec', target: { boxId: '  b1  ', command: '  true  ' } }).target)
    .toEqual({ boxId: 'b1', command: 'true' });
});

test('a caller-supplied id (or any other unknown field) never survives into the normalized output', () => {
  // The store (Task 5) mints the id; a check spec that smuggles one in must not
  // have it echoed back, or a stored check could collide with / impersonate another.
  expect(assertCheckInput({ ...base, id: 'evil-id', extra: 'nope' })).not.toHaveProperty('id');
  expect(assertCheckInput({ ...base, id: 'evil-id', extra: 'nope' })).not.toHaveProperty('extra');
});
