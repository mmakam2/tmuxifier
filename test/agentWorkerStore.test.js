import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentWorkerStore } from '../src/server/agentWorkerStore.js';
import { EMPTY_WORKERS } from '../src/server/agentWorkerRules.js';

let dir, s;
const file = () => path.join(dir, 'agent-workers.json');
const record = (name = 'billing', extra = {}) => ({
  projects: [{ name, dir: `/opt/${name}-api`, trust: false }],
  mailStart: false,
  max: 3,
  ...extra,
});
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-')); s = createAgentWorkerStore({ dataDir: dir }); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('agentWorkerStore', () => {
  test('get returns EMPTY_WORKERS for an unknown box', async () => {
    expect(await s.get('nope')).toEqual(EMPTY_WORKERS);
    expect(await s.all()).toEqual({});
  });

  test('set then get round-trips the normalized record, and a new store reads it back', async () => {
    const out = await s.set('a', { projects: [{ name: 'billing', dir: '/opt/billing-api', trust: true, extra: 'dropped' }], mailStart: true, max: 5, junk: 1 });
    const want = { projects: [{ name: 'billing', dir: '/opt/billing-api', trust: true }], mailStart: true, max: 5 };
    expect(out).toEqual(want);
    expect(await s.get('a')).toEqual(want);
    const s2 = createAgentWorkerStore({ dataDir: dir });
    expect(await s2.get('a')).toEqual(want);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, boxes: { a: want } });
  });

  test('the file is written 0600', async () => {
    await s.set('a', record());
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  test('returned records are copies: changing one changes neither the store nor the file', async () => {
    const out = await s.set('a', record());
    out.projects[0].dir = '/etc';
    out.projects.push({ name: 'x', dir: '/x', trust: true });
    out.max = 8;
    const got = await s.get('a');
    got.projects[0].name = 'changed';
    const all = await s.all();
    all.a.projects.length = 0;
    expect(await s.get('a')).toEqual(record());
    expect((await s.all()).a).toEqual(record());
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).boxes.a).toEqual(record());
  });

  test('an invalid set rejects with the rule message and leaves get and the file as they were', async () => {
    await s.set('a', record());
    const before = fs.readFileSync(file(), 'utf8');
    await expect(s.set('a', { projects: [{ name: 'billing', dir: '/x/../y' }] })).rejects.toThrow('bad directory for project billing');
    await expect(s.set('b', { max: 99 })).rejects.toThrow('max must be 1 to 8');
    expect(await s.get('a')).toEqual(record());
    expect(await s.get('b')).toEqual(EMPTY_WORKERS);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    await s.set('a', record('billing', { max: 4 })); // the chain is still usable
    expect((await s.get('a')).max).toBe(4);
  });

  test('a set whose write fails is not adopted in memory', async () => {
    await s.set('a', record());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'a file where the data directory should be');
    try {
      await expect(s.set('b', record('web'))).rejects.toThrow();
      expect(await s.get('b')).toEqual(EMPTY_WORKERS);
      expect(Object.keys(await s.all())).toEqual(['a']);
    } finally {
      fs.rmSync(dir, { force: true });
      fs.mkdirSync(dir);
    }
    await s.set('c', record('web')); // the chain is still usable, and 'a' was kept in memory
    expect(Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')).boxes).sort()).toEqual(['a', 'c']);
  });

  test('a rejected first set writes no file', async () => {
    await expect(s.set('a', { projects: 'nope' })).rejects.toThrow('projects must be an array');
    expect(fs.existsSync(file())).toBe(false);
  });

  test('overlapping sets for different boxes both land', async () => {
    await Promise.all([s.set('a', record('billing')), s.set('b', record('web', { max: 2 }))]);
    expect((await s.get('a')).projects[0].name).toBe('billing');
    expect((await s.get('b')).max).toBe(2);
    const s2 = createAgentWorkerStore({ dataDir: dir });
    expect(Object.keys(await s2.all()).sort()).toEqual(['a', 'b']);
  });

  test('many overlapping sets do not lose a write', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
    await Promise.all(ids.map((id) => s.set(id, record('billing', { max: 2 }))));
    expect(Object.keys(await s.all()).sort()).toEqual([...ids].sort());
    expect(Object.keys(await createAgentWorkerStore({ dataDir: dir }).all())).toHaveLength(12);
  });

  test('box ids __proto__ and constructor are ordinary keys', async () => {
    await s.set('__proto__', record('billing', { mailStart: true }));
    expect((await s.get('__proto__')).mailStart).toBe(true);
    expect(await s.get('constructor')).toEqual(EMPTY_WORKERS);
    expect(await s.get('toString')).toEqual(EMPTY_WORKERS);
    const s2 = createAgentWorkerStore({ dataDir: dir });
    expect((await s2.get('__proto__')).mailStart).toBe(true);
    expect(await s2.get('constructor')).toEqual(EMPTY_WORKERS);
    expect(Object.keys(await s2.all())).toEqual(['__proto__']);
    expect(Object.prototype.mailStart).toBeUndefined();
  });

  test('a stored entry that no longer passes the rules loads as absent', async () => {
    fs.writeFileSync(file(), JSON.stringify({
      version: 1,
      boxes: {
        bad: { projects: [{ name: 'billing', dir: '/x/../y', trust: true }], mailStart: true, max: 3 },
        huge: { projects: [], mailStart: true, max: 99 },
        junk: 'nope',
        nul: null,
        good: { projects: [{ name: 'billing', dir: '/opt/billing-api', trust: false }], mailStart: true, max: 2 },
      },
    }));
    const logged = [];
    const saved = console.error;
    console.error = (...a) => { logged.push(a.join(' ')); };
    try {
      expect(await s.get('bad')).toEqual(EMPTY_WORKERS);
    } finally {
      console.error = saved;
    }
    // One line per dropped entry, naming the box and the rule: the next write deletes it for good.
    expect(logged).toEqual([
      '[tmuxifier] agent workers: dropped the stored settings of box "bad": bad directory for project billing',
      '[tmuxifier] agent workers: dropped the stored settings of box "huge": max must be 1 to 8',
      '[tmuxifier] agent workers: dropped the stored settings of box "junk": workers must be an object',
      '[tmuxifier] agent workers: dropped the stored settings of box "nul": workers must be an object',
    ]);
    expect(await s.get('huge')).toEqual(EMPTY_WORKERS);
    expect(await s.get('junk')).toEqual(EMPTY_WORKERS);
    expect(await s.get('nul')).toEqual(EMPTY_WORKERS);
    expect(await s.get('good')).toEqual({ projects: [{ name: 'billing', dir: '/opt/billing-api', trust: false }], mailStart: true, max: 2 });
    expect(Object.keys(await s.all())).toEqual(['good']);
  });

  test('removeBox drops the entry, from memory and from the file', async () => {
    await s.set('a', record());
    await s.set('b', record('web'));
    await s.removeBox('a');
    expect(await s.get('a')).toEqual(EMPTY_WORKERS);
    expect((await s.get('b')).projects[0].name).toBe('web');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).boxes).toEqual({ b: record('web') });
    await s.removeBox('never-existed'); // no throw
  });

  test('a corrupt file is quarantined and reads as empty', async () => {
    fs.writeFileSync(file(), '{ not json');
    const quiet = createAgentWorkerStore({ dataDir: dir });
    const errors = [];
    const orig = console.error;
    console.error = (m) => errors.push(m);
    try {
      expect(await quiet.get('a')).toEqual(EMPTY_WORKERS);
    } finally { console.error = orig; }
    expect(errors).toHaveLength(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('agent-workers.json.corrupt-'))).toBe(true);
  });
});
