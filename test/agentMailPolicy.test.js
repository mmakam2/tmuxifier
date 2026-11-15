import { describe, expect, test } from 'vitest';
import { EMPTY_POLICY, normalizePolicy, isEnabled, mayStart } from '../src/server/agentMailPolicy.js';

const P = (o) => ({ send: false, sendTo: [], receive: false, receiveFrom: [], ...o });

describe('mayStart', () => {
  test('cross-box start needs all four', () => {
    const on = { a: P({ send: true, sendTo: ['b'] }), b: P({ receive: true, receiveFrom: ['a'] }) };
    expect(mayStart(on, 'a', 'b')).toEqual({ ok: true });
    expect(mayStart(on, 'b', 'a')).toEqual({ ok: false, code: 'send-off' });
    expect(mayStart({ ...on, a: { ...on.a, sendTo: [] } }, 'a', 'b')).toEqual({ ok: false, code: 'not-in-send-list' });
    expect(mayStart({ ...on, b: { ...on.b, receive: false } }, 'a', 'b')).toEqual({ ok: false, code: 'receive-off' });
    expect(mayStart({ ...on, b: { ...on.b, receiveFrom: [] } }, 'a', 'b')).toEqual({ ok: false, code: 'not-in-receive-list' });
  });
  test('a switch on with an empty list means nobody', () => {
    const on = { a: P({ send: true }), b: P({ receive: true }) };
    expect(mayStart(on, 'a', 'b')).toEqual({ ok: false, code: 'not-in-send-list' });
    const on2 = { a: P({ send: true, sendTo: ['b'] }), b: P({ receive: true }) };
    expect(mayStart(on2, 'a', 'b')).toEqual({ ok: false, code: 'not-in-receive-list' });
  });
  test('same box needs both switches and no list entry', () => {
    expect(mayStart({ a: P({ send: true, receive: true }) }, 'a', 'a')).toEqual({ ok: true });
    expect(mayStart({ a: P({ send: true }) }, 'a', 'a')).toEqual({ ok: false, code: 'receive-off' });
    expect(mayStart({ a: P({ receive: true }) }, 'a', 'a')).toEqual({ ok: false, code: 'send-off' });
  });
  test('a box with no entry is off', () => {
    expect(mayStart({}, 'a', 'b').ok).toBe(false);
    expect(mayStart({}, 'a', 'b').code).toBe('send-off');
  });
  test('a box id named __proto__ or constructor is an ordinary key', () => {
    expect(mayStart({}, '__proto__', 'constructor')).toEqual({ ok: false, code: 'send-off' });
    const pol = Object.create(null);
    pol.__proto__ = P({ send: true, sendTo: ['constructor'] });
    pol.constructor = P({ receive: true, receiveFrom: ['__proto__'] });
    expect(mayStart(pol, '__proto__', 'constructor')).toEqual({ ok: true });
  });
});

describe('normalizePolicy', () => {
  const ctx = { selfId: 'a', knownIds: new Set(['a', 'b', 'c']) };
  test('drops self, dedupes, rejects unknown ids and non-arrays, truthy strings are not true', () => {
    expect(normalizePolicy({ send: true, sendTo: ['b', 'a', 'b', 'c'], receive: 'true', receiveFrom: [] }, ctx))
      .toEqual({ send: true, sendTo: ['b', 'c'], receive: false, receiveFrom: [] });
    expect(() => normalizePolicy({ sendTo: ['zzz'] }, ctx)).toThrow('unknown box: zzz');
    expect(() => normalizePolicy({ sendTo: 'b' }, ctx)).toThrow();
    expect(() => normalizePolicy({ receiveFrom: [5] }, ctx)).toThrow();
    expect(() => normalizePolicy(null, ctx)).toThrow();
    expect(normalizePolicy({}, ctx)).toEqual(EMPTY_POLICY);
  });
  test('over 200 entries is refused', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
    expect(() => normalizePolicy({ sendTo: ids }, { selfId: 'a', knownIds: new Set(ids) })).toThrow('too many boxes');
  });
  test('a box id named __proto__ or constructor is an ordinary key', () => {
    const k = { selfId: 'a', knownIds: new Set(['a', '__proto__', 'constructor']) };
    const out = normalizePolicy({ send: true, sendTo: ['__proto__', 'constructor'] }, k);
    expect(out.sendTo).toEqual(['__proto__', 'constructor']);
    expect(() => normalizePolicy({ sendTo: ['toString'] }, k)).toThrow('unknown box: toString');
  });
  test('EMPTY_POLICY is frozen; isEnabled', () => {
    expect(Object.isFrozen(EMPTY_POLICY)).toBe(true);
    expect(isEnabled(EMPTY_POLICY)).toBe(false);
    expect(isEnabled(P({ receive: true }))).toBe(true);
  });
});
