import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailPolicyStore } from '../src/server/agentMailPolicyStore.js';
import { EMPTY_POLICY } from '../src/server/agentMailPolicy.js';

let dir, s;
const known = (...ids) => ({ knownIds: new Set(ids) });
const file = () => path.join(dir, 'agent-mail-policy.json');
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailpol-')); s = createAgentMailPolicyStore({ dataDir: dir }); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('agentMailPolicyStore', () => {
  test('set writes 0600 and get returns EMPTY_POLICY for an unknown box', async () => {
    expect(await s.get('nope')).toEqual(EMPTY_POLICY);
    await s.set('a', { send: true, sendTo: ['b'] }, known('a', 'b'));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).version).toBe(1);
    expect(await s.get('a')).toEqual({ send: true, sendTo: ['b'], receive: false, receiveFrom: [] });
  });
  test('mirror writes the counterpart entry of each list it names and never flips the other switch', async () => {
    const out = await s.set('a', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] }, { knownIds: new Set(['a', 'b']), mirror: { sendTo: ['b'], receiveFrom: ['b'] } });
    expect(out.b).toEqual({ send: false, sendTo: ['a'], receive: false, receiveFrom: ['a'] });
    expect(await s.get('b')).toEqual(out.b);
  });
  test('mirror is per list: ticked in sendTo only, the other box gains only receiveFrom', async () => {
    const out = await s.set('a', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] }, { knownIds: new Set(['a', 'b']), mirror: { sendTo: ['b'] } });
    expect(out.b).toEqual({ send: false, sendTo: [], receive: false, receiveFrom: ['a'] });
  });
  test('mirror is per list: ticked in receiveFrom only, the other box gains only sendTo', async () => {
    const out = await s.set('a', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] }, { knownIds: new Set(['a', 'b']), mirror: { sendTo: [], receiveFrom: ['b'] } });
    expect(out.b).toEqual({ send: false, sendTo: ['a'], receive: false, receiveFrom: [] });
  });
  test('mirror ignores ids that are not in the corresponding saved list', async () => {
    // c is in no list; b is named under receiveFrom but saved only in sendTo.
    const out = await s.set('a', { send: true, sendTo: ['b'] }, { knownIds: new Set(['a', 'b', 'c']), mirror: { sendTo: ['c'], receiveFrom: ['b'] } });
    expect(out.c).toBeUndefined();
    expect(out.b).toBeUndefined();
    const out2 = await s.set('a', { send: true, sendTo: ['b'] }, { knownIds: new Set(['a', 'b', 'c']), mirror: { sendTo: ['c', 'b'] } });
    expect(out2.c).toBeUndefined();
    expect(out2.b).toEqual({ send: false, sendTo: [], receive: false, receiveFrom: ['a'] });
  });
  test('removeBox deletes the entry and strips the id from every list', async () => {
    await s.set('a', { send: true, sendTo: ['b', 'c'] }, known('a', 'b', 'c'));
    await s.set('b', { receive: true, receiveFrom: ['a'] }, known('a', 'b', 'c'));
    await s.removeBox('b');
    expect(await s.get('b')).toEqual(EMPTY_POLICY);
    expect((await s.get('a')).sendTo).toEqual(['c']);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).boxes.b).toBeUndefined();
  });
  test('an id with no box behind it is dropped at the next write', async () => {
    await s.set('a', { sendTo: ['b'] }, known('a', 'b'));
    await s.set('b', { receive: true }, known('a', 'b'));
    await s.set('c', { send: true }, known('a', 'c'));
    const all = await s.all();
    expect(all.b).toBeUndefined();
    expect(all.a.sendTo).toEqual([]);
    expect(all.c.send).toBe(true);
  });
  test('a second store on the same dataDir reads what the first wrote', async () => {
    await s.set('a', { send: true, sendTo: ['b'] }, known('a', 'b'));
    const s2 = createAgentMailPolicyStore({ dataDir: dir });
    expect(await s2.get('a')).toEqual({ send: true, sendTo: ['b'], receive: false, receiveFrom: [] });
  });
  test('concurrent sets do not lose a write', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
    await Promise.all(ids.map((id) => s.set(id, { send: true }, known(...ids))));
    const all = await s.all();
    expect(Object.keys(all).sort()).toEqual([...ids].sort());
    const s2 = createAgentMailPolicyStore({ dataDir: dir });
    expect(Object.keys(await s2.all())).toHaveLength(12);
  });
  test('an invalid set rejects and leaves the store unchanged', async () => {
    await s.set('a', { send: true }, known('a'));
    await expect(s.set('a', { sendTo: ['zz'] }, known('a'))).rejects.toThrow('unknown box: zz');
    expect((await s.get('a')).send).toBe(true);
    await s.set('a', { send: false }, known('a')); // chain still usable
  });
  test('box ids __proto__ and constructor are ordinary keys', async () => {
    await s.set('__proto__', { send: true, sendTo: ['constructor'] }, known('__proto__', 'constructor'));
    const s2 = createAgentMailPolicyStore({ dataDir: dir });
    expect((await s2.get('__proto__')).sendTo).toEqual(['constructor']);
    expect(await s2.get('toString')).toEqual(EMPTY_POLICY);
  });
});
