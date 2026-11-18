import { test, expect, describe, vi, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Registering the mail hooks on OpenCode, one directory instance at a time (agent messaging spec
// §6.10, rulings R13, R6). OpenCode 2.3.0 sets the plugin up once per project directory in one
// server process (test/fixtures/README-opencode-2.3-event-trace.md F5): `ctx.session.synthetic` is
// process-wide, but `tool.execute.before`, `shell.create.before` and `permission.evaluate` fire only
// in the instance whose directory owns the session (fixture lines 935-937 vs 981-983). So the
// plugin keeps every live ctx, registers the three hooks on each (one pane tagger and one permission
// handler per ctx), posts a wake through the ctx of the session's directory, and hands the list over
// to the next core.

const ASSET = '../src/server/assets/tmuxifier-opencode-agent.js';
const KEY = Symbol.for('tmuxifier.opencode-agent');
const TRACE = fileURLToPath(new URL('./fixtures/opencode-2.3-event-trace.jsonl', import.meta.url));
const traceLine = (n) => JSON.parse(readFileSync(TRACE, 'utf8').split('\n')[n - 1]);
// Fresh copies of the recorded hook payloads, so each test can mutate its own.
const recorded = (n) => structuredClone(traceLine(n).input);

const tmps = [];
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'oc-registry-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  const core = globalThis[KEY];
  if (core) {
    try { core.abort(); } catch { /* best effort */ }
    delete globalThis[KEY];
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const HOOKS = [['tool', 'execute.before'], ['shell', 'create.before'], ['permission', 'evaluate']];

// An OpenCode 2.3.0 ctx for one directory: `hook` records registrations (each disposable),
// `fire(name, payload)` runs the live callbacks of that hook name the way OpenCode does,
// `session.synthetic` is a spy, and the event stream is fed by push() and ends on abort.
function ocCtx(dir, { version = '2.3.0', synthetic = true } = {}) {
  const regs = []; // { domain, name, cb, disposed }
  const queue = [];
  let wake = null;
  const domain = (d) => ({
    hook: vi.fn(async (name, cb) => {
      const reg = { domain: d, name, cb, disposed: false };
      regs.push(reg);
      return { dispose: vi.fn(async () => { reg.disposed = true; }) };
    }),
  });
  const ctx = {
    app: { name: 'cli', version, channel: 'latest' },
    location: { directory: dir, project: { id: 'p', directory: dir, canonical: dir } },
    tool: domain('tool'),
    shell: domain('shell'),
    permission: domain('permission'),
    session: synthetic
      ? { synthetic: vi.fn(async (input) => ({ id: `msg_${path.basename(dir)}`, sessionID: input.sessionID, type: 'synthetic' })) }
      : { list: async () => [] },
    regs,
    live: (name) => regs.filter((r) => r.name === name && !r.disposed),
    fire(name, payload) {
      for (const r of ctx.live(name)) r.cb(payload);
      return payload;
    },
    signal: null,
    push(e) { queue.push(e); if (wake) wake(); },
    event: {
      async *subscribe({ signal }) {
        ctx.signal = signal;
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }); });
          wake = null;
        }
      },
    },
  };
  return ctx;
}
const liveCounts = (ctx) => HOOKS.map(([, name]) => ctx.live(name).length);

// A stand-in for the current core: the session -> pane and session -> directory answers.
function fakeCore(panes = {}, dirs = {}) {
  return {
    paneOfSession: (sid) => panes[sid] ?? null,
    dirOfSession: (sid) => dirs[sid] ?? null,
  };
}
const noRules = { hasBashRules: () => false };

// A shell call announced, its shell created, its permission evaluated: the three hooks of one
// command, in the order and shapes OpenCode 2.3.0 fires them (fixture 46-48, 1371).
function runCommand(ctx, sessionID, command, id, effect = 'ask') {
  const tool = { ...recorded(46), sessionID, id, input: { command } };
  const shell = { ...recorded(47), command };
  const evaluation = { ...recorded(1371), sessionID, resources: [command], source: { ...recorded(1371).source, id }, effect };
  ctx.fire('execute.before', tool);
  ctx.fire('create.before', shell);
  ctx.fire('evaluate', evaluation);
  return { env: shell.env, effect: evaluation.effect };
}

describe('the version gate', () => {
  test('OPENCODE_MAIL_MIN is 2.3.0, and the recorded ctx.app passes it', async () => {
    const { OPENCODE_MAIL_MIN, mailCapable } = await import(ASSET);
    expect(OPENCODE_MAIL_MIN).toBe('2.3.0');
    const app = traceLine(1).app;
    expect(app).toEqual({ name: 'cli', version: '2.3.0', channel: 'latest' });
    expect(mailCapable({ app, session: { synthetic() {} } })).toBe(true);
  });

  test('2.2.6 is off; 2.3.0, 2.3.1, 2.10.1 and 3.0.0 are on (numeric, not string order); garbage is off', async () => {
    const { mailCapable } = await import(ASSET);
    const ctx = (version) => ({ app: { version }, session: { synthetic() {} } });
    for (const v of ['2.3.0', '2.3.1', '2.10.1', '3.0.0', '10.0.0']) expect(mailCapable(ctx(v)), v).toBe(true);
    for (const v of ['2.2.6', '2.2.99', '1.99.99', '0.0.0']) expect(mailCapable(ctx(v)), v).toBe(false);
    for (const v of ['garbage', '', 'v2.3.0', '2.3.0-beta.1', '2..3', ' 2.3.0', '2.3.0\n', 2.3, null, undefined, {}, '9'.repeat(400)]) {
      expect(mailCapable(ctx(v)), String(v)).toBe(false);
    }
  });

  test('a semver pre-release counts as below its own numbers only; a build suffix is ignored', async () => {
    const { mailCapable } = await import(ASSET);
    const ctx = (version) => ({ app: { version }, session: { synthetic() {} } });
    for (const v of ['2.3.1-beta', '2.4.0-rc.1', '3.0.0-alpha.2', '2.3.0+build.7', '2.3.1-beta+abc']) expect(mailCapable(ctx(v)), v).toBe(true);
    for (const v of ['2.3.0-beta', '2.3.0-rc.1+abc', '2.2.9-rc', '2.3.0-', '2.3.0-be ta', '2.3.0-beta\n', `2.3.1-${'x'.repeat(65)}`]) expect(mailCapable(ctx(v)), v).toBe(false);
  });

  test('a ctx without session.synthetic, without app, or with throwing getters is off', async () => {
    const { mailCapable } = await import(ASSET);
    expect(mailCapable({ app: { version: '2.3.0' }, session: {} })).toBe(false);
    expect(mailCapable({ app: { version: '2.3.0' } })).toBe(false);
    expect(mailCapable({ session: { synthetic() {} } })).toBe(false);
    expect(mailCapable(undefined)).toBe(false);
    const throwing = { get app() { throw new Error('no'); }, session: { synthetic() {} } };
    expect(mailCapable(throwing)).toBe(false);
  });
});

describe('createRegistry', () => {
  test('add registers the three hooks once on a ctx; a second add of the same ctx registers nothing', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const live = new Map([[a.location.directory, a]]);
    const reg = createRegistry({ live, mail: true, current: () => fakeCore(), rules: noRules });
    reg.add(a);
    reg.add(a);
    await flush(0);
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    expect(a.regs.map((r) => `${r.domain}.${r.name}`).sort()).toEqual(['permission.evaluate', 'shell.create.before', 'tool.execute.before']);
  });

  test('addAll registers on every live ctx; mail off registers nothing anywhere', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const live = new Map([[a.location.directory, a], [b.location.directory, b]]);
    createRegistry({ live, mail: true, current: () => fakeCore(), rules: noRules }).addAll();
    await flush(0);
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    expect(liveCounts(b)).toEqual([1, 1, 1]);

    const c = ocCtx('/home/user/proj3');
    createRegistry({ live: new Map([['/home/user/proj3', c]]), mail: false, current: () => fakeCore(), rules: noRules }).addAll();
    await flush(0);
    expect(c.regs).toEqual([]);
  });

  test('each ctx tags its own session\'s shell with its pane (recorded payloads, fixture 935-937 and 981-983)', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const sa = recorded(935).sessionID;
    const sb = recorded(981).sessionID;
    const core = fakeCore({ [sa]: '%0', [sb]: '%1' }, { [sa]: '/home/user/proj', [sb]: '/home/user/proj2' });
    const live = new Map([[a.location.directory, a], [b.location.directory, b]]);
    createRegistry({ live, mail: true, current: () => core, rules: noRules }).addAll();
    await flush(0);

    a.fire('execute.before', recorded(935));
    const shellA = a.fire('create.before', recorded(936));
    b.fire('execute.before', recorded(981));
    const shellB = b.fire('create.before', recorded(982));
    expect(shellA.env.TMUXIFIER_MAIL_PANE).toBe('%0');
    expect(shellB.env.TMUXIFIER_MAIL_PANE).toBe('%1');
    // The recorded evaluations already read `allow` (the recording's own rule): left as they are.
    const evA = a.fire('evaluate', recorded(937));
    expect(evA.effect).toBe('allow');
  });

  test('the pane and the directory come from the CURRENT core, read at call time', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const holder = { core: fakeCore({ ses_a: '%3' }, { ses_a: '/home/user/proj' }) };
    createRegistry({ live: new Map([['/home/user/proj', a]]), mail: true, current: () => holder.core, rules: noRules }).addAll();
    await flush(0);
    expect(runCommand(a, 'ses_a', 'tmx who', 'call_1').env.TMUXIFIER_MAIL_PANE).toBe('%3');
    holder.core = fakeCore({ ses_a: '%7' }, {}); // handed over: another pane, no directory known
    const r = runCommand(a, 'ses_a', 'tmx who', 'call_2');
    expect(r.env.TMUXIFIER_MAIL_PANE).toBe('%7');
    expect(r.effect).toBe('ask'); // an unknown directory counts as rules
    holder.core = undefined; // no core at all: fail closed, never throw
    const r2 = runCommand(a, 'ses_a', 'tmx who', 'call_3');
    expect(r2.env.TMUXIFIER_MAIL_PANE).toBe('none');
    expect(r2.effect).toBe('ask');
  });

  test('the permission handler allows plain tmx without rules and leaves ask with them', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const core = fakeCore({ ses_a: '%3' }, { ses_a: '/home/user/proj' });
    let rules = false;
    createRegistry({ live: new Map([['/home/user/proj', a]]), mail: true, current: () => core, rules: { hasBashRules: () => rules } }).addAll();
    await flush(0);
    expect(runCommand(a, 'ses_a', 'tmx who', 'call_1').effect).toBe('allow');
    expect(runCommand(a, 'ses_a', 'tmx who; id', 'call_2').effect).toBe('ask');
    rules = true;
    expect(runCommand(a, 'ses_a', 'tmx who', 'call_3').effect).toBe('ask');
  });

  test('synthetic goes through the hooked ctx of the session\'s directory; an unknown directory falls back to any live one', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const core = fakeCore({}, { ses_b: '/home/user/proj2' });
    const reg = createRegistry({ live: new Map([['/home/user/proj', a], ['/home/user/proj2', b]]), mail: true, current: () => core, rules: noRules });
    reg.addAll();
    await reg.settled();
    await flush(0);
    const input = { sessionID: 'ses_b', text: 'hi', delivery: 'queue', resume: true, metadata: { tmuxifierMail: 'm-aaaaaaaa' } };
    await expect(reg.synthetic(input)).resolves.toEqual({ id: 'msg_proj2', sessionID: 'ses_b', type: 'synthetic' });
    expect(b.session.synthetic).toHaveBeenCalledWith(input);
    expect(b.session.synthetic.mock.contexts[0]).toBe(b.session); // called as OpenCode's method
    expect(a.session.synthetic).not.toHaveBeenCalled();
    await expect(reg.synthetic({ sessionID: 'ses_unknown' })).resolves.toMatchObject({ id: 'msg_proj' });
    expect(a.session.synthetic).toHaveBeenCalledTimes(1);
  });

  test('R33: a known directory that is not hooked (not live, a rejected hook(), not settled, removed) makes synthetic reject, never fall back', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const bad = ocCtx('/home/user/bad');
    bad.permission.hook = async () => { throw new Error('refused'); };
    const slow = ocCtx('/home/user/slow');
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowHook = slow.shell.hook;
    slow.shell.hook = async (...args) => { await gate; return slowHook(...args); };
    const core = fakeCore({}, { ses_x: '/elsewhere', ses_bad: '/home/user/bad', ses_slow: '/home/user/slow', ses_a: '/home/user/proj' });
    const live = new Map([['/home/user/proj', a], ['/home/user/bad', bad], ['/home/user/slow', slow]]);
    const reg = createRegistry({ live, mail: true, current: () => core, rules: noRules });
    reg.addAll();
    await flush(10);
    expect(reg.isHooked('/home/user/proj')).toBe(true);
    expect(reg.isHooked('/home/user/bad')).toBe(false);
    expect(reg.isHooked('/home/user/slow')).toBe(false);
    expect(reg.isHooked('/elsewhere')).toBe(false);
    for (const sid of ['ses_x', 'ses_bad', 'ses_slow']) await expect(reg.synthetic({ sessionID: sid }), sid).rejects.toThrow();
    for (const c of [a, bad, slow]) expect(c.session.synthetic).not.toHaveBeenCalled();
    release();
    await reg.settled();
    await flush(0);
    expect(reg.isHooked('/home/user/slow')).toBe(true);
    await expect(reg.synthetic({ sessionID: 'ses_slow' })).resolves.toMatchObject({ id: 'msg_slow' });
    reg.remove(a);
    expect(reg.isHooked('/home/user/proj')).toBe(false);
    await expect(reg.synthetic({ sessionID: 'ses_a' })).rejects.toThrow();
    reg.dispose();
    expect(reg.isHooked('/home/user/slow')).toBe(false);
  });

  test('synthetic skips a ctx that cannot post for an unknown directory, and with none left it rejects (never throws)', async () => {
    const { createRegistry } = await import(ASSET);
    const old = ocCtx('/home/user/proj', { synthetic: false });
    const b = ocCtx('/home/user/proj2');
    const core = fakeCore({}, { ses_a: '/home/user/proj' });
    const reg = createRegistry({ live: new Map([['/home/user/proj', old], ['/home/user/proj2', b]]), mail: true, current: () => core, rules: noRules });
    reg.addAll();
    await reg.settled();
    await flush(0);
    await expect(reg.synthetic({ sessionID: 'ses_unknown' })).resolves.toMatchObject({ id: 'msg_proj2' });
    await expect(reg.synthetic({ sessionID: 'ses_a' })).rejects.toThrow(); // its own ctx cannot post: no fallback
    const none = createRegistry({ live: new Map(), mail: true, current: () => core, rules: noRules });
    let p;
    expect(() => { p = none.synthetic({ sessionID: 'ses_a' }); }).not.toThrow();
    await expect(p).rejects.toThrow();
    const throwing = ocCtx('/home/user/proj');
    throwing.session.synthetic = () => { throw new Error('sync throw'); };
    const t = createRegistry({ live: new Map([['/home/user/proj', throwing]]), mail: true, current: () => core, rules: noRules });
    t.addAll();
    await t.settled();
    await flush(0);
    let q;
    expect(() => { q = t.synthetic({ sessionID: 'ses_a' }); }).not.toThrow();
    await expect(q).rejects.toThrow('sync throw');
  });

  test('R32: a hand-over keeps each ctx\'s tagger, so a call announced before it is never tagged with a call announced after it', async () => {
    const { createRegistry } = await import(ASSET);
    // The reviewer's sequence: S1 (%1) and S2 (%2) in /p; S1 announces `tmx who`, a hand-over,
    // S2 announces the same `tmx who`, then S1's shell is created.
    const ctx = ocCtx('/p');
    const live = new Map([['/p', ctx]]);
    const core = fakeCore({ s1: '%1', s2: '%2' }, { s1: '/p', s2: '/p' });
    const strict = { hasBashRules: () => true };
    const r1 = createRegistry({ live, mail: true, current: () => core, rules: strict });
    r1.addAll();
    await flush(5);
    ctx.fire('execute.before', { tool: 'shell', sessionID: 's1', id: 'c1', input: { command: 'tmx who' } });
    const r2 = createRegistry({ live, mail: true, pieces: r1.pieces, current: () => core, rules: strict });
    r2.addAll();
    await r2.settled();
    r1.dispose();
    await flush(5);
    expect(liveCounts(ctx)).toEqual([1, 1, 1]);
    ctx.fire('execute.before', { tool: 'shell', sessionID: 's2', id: 'c2', input: { command: 'tmx who' } });
    const s1shell = ctx.fire('create.before', { command: 'tmx who', env: {} });
    // Two pending calls, one text, two panes: neither shell can be told apart (fail closed).
    expect(s1shell.env.TMUXIFIER_MAIL_PANE).toBe('none');
    expect(ctx.fire('create.before', { command: 'tmx who', env: {} }).env.TMUXIFIER_MAIL_PANE).toBe('none');
  });

  test('R32: while two registries overlap on a ctx, every hook fires twice and still acts once', async () => {
    const { createRegistry } = await import(ASSET);
    const ctx = ocCtx('/p');
    const live = new Map([['/p', ctx]]);
    const core = fakeCore({ s1: '%1', s2: '%2' }, { s1: '/p', s2: '/p' });
    const r1 = createRegistry({ live, mail: true, current: () => core, rules: noRules });
    r1.addAll();
    await flush(5);
    ctx.fire('execute.before', { tool: 'shell', sessionID: 's1', id: 'c1', input: { command: 'tmx who' } });
    const r2 = createRegistry({ live, mail: true, pieces: r1.pieces, current: () => core, rules: noRules });
    r2.addAll();
    await r2.settled(); // r1 not disposed yet: the overlap
    expect(liveCounts(ctx)).toEqual([2, 2, 2]);
    ctx.fire('execute.before', { tool: 'shell', sessionID: 's2', id: 'c2', input: { command: 'tmx who' } });
    const s1shell = ctx.fire('create.before', { command: 'tmx who', env: {} });
    expect(s1shell.env.TMUXIFIER_MAIL_PANE).toBe('none'); // never overwritten by the second callback
    // A lone call during the overlap: tagged once with its pane, allowed once.
    ctx.fire('create.before', { command: 'tmx who', env: {} }); // drain the second record
    const r = runCommand(ctx, 's1', 'tmx inbox', 'c3');
    expect(r.env.TMUXIFIER_MAIL_PANE).toBe('%1');
    expect(r.effect).toBe('allow');
  });

  test('dispose disposes every registration; remove(ctx) only that ctx\'s; a disposed registry adds nothing', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const reg = createRegistry({ live: new Map([['/home/user/proj', a], ['/home/user/proj2', b]]), mail: true, current: () => fakeCore(), rules: noRules });
    reg.addAll();
    reg.remove(a); // before the registrations even resolved
    await flush(0);
    expect(liveCounts(a)).toEqual([0, 0, 0]);
    expect(liveCounts(b)).toEqual([1, 1, 1]);
    reg.dispose();
    await flush(0);
    expect(liveCounts(b)).toEqual([0, 0, 0]);
    reg.add(b);
    reg.addAll();
    await flush(0);
    expect(b.regs).toHaveLength(3);
  });

  test('nothing reaches OpenCode: throwing hook(), rejecting registrations and disposes, throwing core answers', async () => {
    const { createRegistry } = await import(ASSET);
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = ocCtx('/home/user/proj');
      a.tool.hook = () => { throw new Error('sync'); };
      a.shell.hook = async () => { throw new Error('async'); };
      a.permission.hook = async (name, cb) => { a.regs.push({ name, cb, disposed: false }); return { dispose: async () => { throw new Error('dispose'); } }; };
      const b = { location: { directory: '/x' } }; // no domains at all
      const core = {
        paneOfSession: () => { throw new Error('pane'); },
        dirOfSession: () => { throw new Error('dir'); },
      };
      const reg = createRegistry({ live: new Map([['/home/user/proj', a], ['/x', b]]), mail: true, current: () => core, rules: noRules });
      expect(() => reg.addAll()).not.toThrow();
      await flush(0);
      const ev = { ...recorded(1371), source: { type: 'tool', id: 'call_z' } };
      expect(() => a.fire('evaluate', ev)).not.toThrow();
      expect(ev.effect).toBe('ask');
      expect(() => reg.dispose()).not.toThrow();
      expect(() => reg.remove(a)).not.toThrow();
      await flush(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the entry point', () => {
  // HOME, PATH (a fake tmux printing $TMUXIFIER_FAKE_PANES) and no OpenCode config in the
  // environment, so the default export's own defaults are what runs.
  function fakeEnv() {
    const home = tmp();
    const bin = tmp();
    const panesFile = path.join(bin, 'panes.txt');
    writeFileSync(panesFile, '');
    writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1 $2 $3 $4" = "-u list-panes -a -F" ] || exit 2\ncat "$TMUXIFIER_FAKE_PANES"\n');
    chmodSync(path.join(bin, 'tmux'), 0o755);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('TMUXIFIER_FAKE_PANES', panesFile);
    for (const k of ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']) vi.stubEnv(k, '');
    return { home, setPanes: (text) => writeFileSync(panesFile, text) };
  }
  // The box's mail listener on ~/.tmuxifier-mail/sock: answers every wait 204 (idle) and counts them.
  async function mailListener(home) {
    mkdirSync(path.join(home, '.tmuxifier-mail'), { recursive: true });
    const requests = [];
    const server = http.createServer((req, res) => { requests.push(req.url); res.statusCode = 204; res.end(); });
    await new Promise((r) => server.listen(path.join(home, '.tmuxifier-mail', 'sock'), r));
    return { requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  }
  const row = (session, cmd, p, id) => `${session}\t1\t1\t${cmd}\t${p}\t${id}\n`;
  let evN = 0;
  const ev = (type, data, dir, createdMs = Date.now() + 10_000) => ({
    id: `e${++evN}`, type, created: createdMs, data, ...(dir ? { location: { directory: dir } } : {}),
  });

  test('two setups: the hooks are on both ctxs exactly once, and a third setup keeps it that way', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const c = ocCtx('/home/user/proj3');
    await mod.default.setup(a);
    await flush(0);
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    await mod.default.setup(b);
    await flush(0);
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    expect(liveCounts(b)).toEqual([1, 1, 1]);
    // The first core's registration on `a` was disposed and the second core's made.
    expect(a.regs).toHaveLength(6);
    expect(a.regs.slice(0, 3).every((r) => r.disposed)).toBe(true);
    const cleanupC = await mod.default.setup(c);
    await flush(0);
    for (const ctx of [a, b, c]) expect(liveCounts(ctx)).toEqual([1, 1, 1]);
    expect([...globalThis[KEY].live.keys()]).toEqual(['/home/user/proj', '/home/user/proj2', '/home/user/proj3']);
    await cleanupC();
  });

  test('a setup for a directory already listed replaces that ctx; a cleaned-up ctx leaves the list and loses its hooks', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    const a1 = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const cleanupA1 = await mod.default.setup(a1);
    const cleanupB = await mod.default.setup(b);
    const a2 = ocCtx('/home/user/proj'); // the same directory set up again (a reload)
    const cleanupA2 = await mod.default.setup(a2);
    await flush(0);
    expect(liveCounts(a1)).toEqual([0, 0, 0]);
    expect(liveCounts(a2)).toEqual([1, 1, 1]);
    expect(globalThis[KEY].live.get('/home/user/proj')).toBe(a2);

    await cleanupB(); // not the owner: the core stays, only `b` goes
    await flush(0);
    expect(liveCounts(b)).toEqual([0, 0, 0]);
    expect([...globalThis[KEY].live.values()]).toEqual([a2]);
    const c = ocCtx('/home/user/proj3');
    const cleanupC = await mod.default.setup(c);
    await flush(0);
    expect(liveCounts(b)).toEqual([0, 0, 0]);
    expect(b.regs).toHaveLength(6); // registered by two cores, never by the third
    expect(liveCounts(a2)).toEqual([1, 1, 1]);
    await cleanupA1(); // a stale ctx's cleanup changes nothing for the ctx that replaced it
    await flush(0);
    expect(liveCounts(a2)).toEqual([1, 1, 1]);
    const coreC = globalThis[KEY];
    await cleanupC(); // the owner, with a2 still live: a new core attached to a2 (R33)
    await flush(0);
    const coreA2 = globalThis[KEY];
    expect(coreA2).not.toBe(coreC);
    expect(coreA2.attachedCtx).toBe(a2);
    expect(a2.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(true);
    expect(liveCounts(c)).toEqual([0, 0, 0]);
    expect(liveCounts(a2)).toEqual([1, 1, 1]);
    expect([...coreA2.live.values()]).toEqual([a2]);
    await cleanupA2(); // the last one: everything stops
    await flush(0);
    expect(liveCounts(a2)).toEqual([0, 0, 0]);
    expect(globalThis[KEY]).toBeUndefined();
  });

  test('OpenCode 2.2.6, or a ctx without session.synthetic: no hook, no mail part, no wait; markers still written', async () => {
    const mod = await import(ASSET);
    for (const opts of [{ version: '2.2.6' }, { synthetic: false }, { version: 'garbage' }, {}]) {
      const env = fakeEnv();
      env.setPanes(row('web', 'opencode', '/home/user/proj', '%1'));
      const listener = await mailListener(env.home);
      const ctx = ocCtx('/home/user/proj', opts);
      const cleanup = await mod.default.setup(ctx);
      const core = globalThis[KEY];
      await vi.waitFor(() => expect(readFileSync(path.join(env.home, '.tmuxifier-agent', 'web'), 'utf8')).toMatch(/^web:ready:\d+:start\n$/));
      ctx.push(ev('session.created', { sessionID: 'ses_a' }, '/home/user/proj'));
      ctx.push(ev('session.inbox.enqueued', { sessionID: 'ses_a', inboxID: 'i1', item: { type: 'user' } }, '/home/user/proj'));
      // The operator's turn runs and ends: the session reads ready, the moment a wait is armed.
      ctx.push(ev('session.execution.started', { sessionID: 'ses_a' }));
      ctx.push(ev('session.execution.succeeded', { sessionID: 'ses_a' }, null, Date.now() + 11_000));
      await vi.waitFor(() => expect(core.paneOfSession('ses_a')).toBe('%1')); // the target exists
      await flush(100);
      const label = JSON.stringify(opts);
      if (Object.keys(opts).length === 0) {
        // The control: a 2.3.0 ctx with synthetic does register and does wait.
        expect(core.mailState, label).not.toBeNull();
        expect(ctx.regs.length, label).toBe(3);
        expect(listener.requests.some((u) => u.startsWith('/v1/wait?')), label).toBe(true);
      } else {
        expect(core.mailState, label).toBeNull();
        expect(ctx.regs, label).toEqual([]);
        expect(listener.requests, label).toEqual([]);
      }
      await cleanup();
      await listener.close();
    }
  });

  test('one ctx below the minimum keeps mail off for the whole core, even next to a 2.3.0 one', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    const old = ocCtx('/home/user/proj', { version: '2.2.6' });
    const cur = ocCtx('/home/user/proj2');
    await mod.default.setup(old);
    await mod.default.setup(cur);
    await flush(0);
    expect(globalThis[KEY].mailState).toBeNull();
    expect(cur.regs).toEqual([]);
    expect(old.regs).toEqual([]);
  });

  test('a capable core has the mail part, and its wake goes through the session\'s directory ctx', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    await mod.default.setup(a);
    await mod.default.setup(b);
    const core = globalThis[KEY];
    expect(core.mailState).not.toBeNull();
    b.push(ev('session.created', { sessionID: 'ses_b' }, '/home/user/proj2'));
    await vi.waitFor(() => expect(core.dirOfSession('ses_b')).toBe('/home/user/proj2'));
    await expect(core.registry.synthetic({ sessionID: 'ses_b', text: 't' })).resolves.toMatchObject({ id: 'msg_proj2' });
    expect(a.session.synthetic).not.toHaveBeenCalled();
  });

  test('R32 through the entry point: a setup for another directory between a call\'s announcement and its shell keeps the tagger', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    vi.stubEnv('PATH', tmp()); // no tmux: the cores sweep nothing, the test sets the panes
    const p = ocCtx('/p');
    await mod.default.setup(p);
    await flush(5);
    const fake = (core) => {
      core.paneOfSession = (sid) => ({ s1: '%1', s2: '%2' })[sid] ?? null;
      core.dirOfSession = () => '/p';
    };
    fake(globalThis[KEY]);
    p.fire('execute.before', { tool: 'shell', sessionID: 's1', id: 'c1', input: { command: 'tmx who' } });
    const q = ocCtx('/q');
    const cleanupQ = await mod.default.setup(q); // the hand-over, while s1's shell waits
    fake(globalThis[KEY]);
    await flush(5);
    expect(liveCounts(p)).toEqual([1, 1, 1]);
    p.fire('execute.before', { tool: 'shell', sessionID: 's2', id: 'c2', input: { command: 'tmx who' } });
    expect(p.fire('create.before', { command: 'tmx who', env: {} }).env.TMUXIFIER_MAIL_PANE).toBe('none');
    await cleanupQ();
  });

  test('R34: the old core\'s hooks are disposed only after the new core\'s settled (an overlap, never a gap)', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    vi.stubEnv('PATH', tmp());
    const a = ocCtx('/home/user/proj');
    await mod.default.setup(a);
    await flush(5);
    let release;
    const gate = new Promise((r) => { release = r; });
    const realHook = a.tool.hook;
    a.tool.hook = async (...args) => { await gate; return realHook(...args); };
    const b = ocCtx('/home/user/proj2');
    const cleanupB = await mod.default.setup(b);
    await flush(20);
    // The new registration on `a` is pending: the old one is still in place.
    expect(a.live('execute.before')).toHaveLength(1);
    expect(a.regs.filter((r) => r.name === 'execute.before')[0].disposed).toBe(false);
    release();
    await flush(20);
    const tools = a.regs.filter((r) => r.name === 'execute.before');
    expect(tools).toHaveLength(2);
    expect(tools[0].disposed).toBe(true);
    expect(tools[1].disposed).toBe(false);
    await cleanupB();
  });

  test('R33: a directory whose hook() was refused gets no wait and no wake; a hooked one beside it does', async () => {
    const mod = await import(ASSET);
    const env = fakeEnv();
    const root = tmp();
    const good = path.join(root, 'good');
    const bad = path.join(root, 'bad');
    mkdirSync(good);
    mkdirSync(bad);
    env.setPanes(row('web', 'opencode', good, '%4') + row('dev', 'opencode', bad, '%9'));
    const listener = await mailListener(env.home);
    const g = ocCtx(good);
    const x = ocCtx(bad);
    x.shell.hook = async () => { throw new Error('refused'); };
    await mod.default.setup(g);
    const cleanupX = await mod.default.setup(x);
    const core = globalThis[KEY];
    x.push(ev('session.created', { sessionID: 'ses_g' }, good));
    x.push(ev('session.created', { sessionID: 'ses_x' }, bad));
    x.push(ev('session.inbox.enqueued', { sessionID: 'ses_g', inboxID: 'i1', item: { type: 'user' } }, good));
    x.push(ev('session.inbox.enqueued', { sessionID: 'ses_x', inboxID: 'i2', item: { type: 'user' } }, bad));
    for (const sid of ['ses_g', 'ses_x']) {
      x.push(ev('session.execution.started', { sessionID: sid }));
      x.push(ev('session.execution.succeeded', { sessionID: sid }, null, Date.now() + 11_000));
    }
    await vi.waitFor(() => {
      expect(core.paneOfSession('ses_g')).toBe('%4');
      expect(core.paneOfSession('ses_x')).toBe('%9'); // a target all the same
    });
    await vi.waitFor(() => expect(listener.requests.some((u) => u.includes('session=web'))).toBe(true));
    await flush(100);
    expect(core.registry.isHooked(good)).toBe(true);
    expect(core.registry.isHooked(bad)).toBe(false);
    expect(listener.requests.filter((u) => u.includes('session=dev'))).toEqual([]);
    await expect(core.registry.synthetic({ sessionID: 'ses_x', text: 't' })).rejects.toThrow();
    expect(x.session.synthetic).not.toHaveBeenCalled();
    expect(g.session.synthetic).not.toHaveBeenCalled(); // no fallback for a known directory
    await cleanupX();
    await listener.close();
  });

  test('R33: a target skipped while its directory\'s hooks were pending gets its wait as soon as they settle, without a new sweep', async () => {
    const mod = await import(ASSET);
    const env = fakeEnv();
    const root = tmp();
    const good = path.join(root, 'good');
    mkdirSync(good);
    env.setPanes(row('web', 'opencode', good, '%4'));
    const listener = await mailListener(env.home);
    const g = ocCtx(good);
    let release;
    const gate = new Promise((r) => { release = r; });
    const realHook = g.shell.hook;
    g.shell.hook = async (...args) => { await gate; return realHook(...args); };
    const cleanup = await mod.default.setup(g);
    const core = globalThis[KEY];
    g.push(ev('session.created', { sessionID: 'ses_g' }, good));
    g.push(ev('session.inbox.enqueued', { sessionID: 'ses_g', inboxID: 'i1', item: { type: 'user' } }, good));
    g.push(ev('session.execution.started', { sessionID: 'ses_g' }));
    g.push(ev('session.execution.succeeded', { sessionID: 'ses_g' }, null, Date.now() + 11_000));
    await vi.waitFor(() => expect(core.paneOfSession('ses_g')).toBe('%4'));
    await flush(150);
    expect(core.registry.isHooked(good)).toBe(false);
    expect(listener.requests).toEqual([]);
    release();
    await vi.waitFor(() => expect(listener.requests.some((u) => u.includes('session=web'))).toBe(true));
    await cleanup();
    await listener.close();
  });

  test('R33: past LIVE_MAX the oldest directory is dropped: its hooks go, it is not hooked, its session gets no wake', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    vi.stubEnv('PATH', tmp());
    const ctxs = [];
    for (let i = 0; i < 65; i++) {
      const c = ocCtx(`/home/user/p${i}`);
      ctxs.push(c);
      await mod.default.setup(c);
    }
    await flush(50);
    const core = globalThis[KEY];
    expect(core.live.size).toBe(64);
    expect(core.live.has('/home/user/p0')).toBe(false);
    expect(liveCounts(ctxs[0])).toEqual([0, 0, 0]);
    expect(liveCounts(ctxs[1])).toEqual([1, 1, 1]);
    expect(core.registry.isHooked('/home/user/p0')).toBe(false);
    expect(core.registry.isHooked('/home/user/p1')).toBe(true);
    ctxs[64].push(ev('session.created', { sessionID: 'ses_0' }, '/home/user/p0'));
    ctxs[64].push(ev('session.created', { sessionID: 'ses_1' }, '/home/user/p1'));
    await vi.waitFor(() => expect(core.dirOfSession('ses_1')).toBe('/home/user/p1'));
    await expect(core.registry.synthetic({ sessionID: 'ses_0' })).rejects.toThrow();
    await expect(core.registry.synthetic({ sessionID: 'ses_1' })).resolves.toMatchObject({ id: 'msg_p1' });
    for (const c of ctxs) if (c !== ctxs[1]) expect(c.session.synthetic).not.toHaveBeenCalled();
  });

  test('R33: the attached ctx\'s cleanup with others live hands over to the newest remaining one, mail still on', async () => {
    const mod = await import(ASSET);
    fakeEnv();
    vi.stubEnv('PATH', tmp());
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const c = ocCtx('/home/user/proj3');
    const cleanupA = await mod.default.setup(a);
    await mod.default.setup(b);
    const cleanupC = await mod.default.setup(c);
    c.push(ev('session.created', { sessionID: 'ses_a' }, '/home/user/proj'));
    const coreC = globalThis[KEY];
    await vi.waitFor(() => expect(coreC.dirOfSession('ses_a')).toBe('/home/user/proj'));
    await cleanupC();
    await flush(20);
    const next = globalThis[KEY];
    expect(next).not.toBe(coreC);
    expect(next.attachedCtx).toBe(b); // the newest remaining
    expect(b.signal?.aborted).toBe(false);
    expect(next.state.sessions).toBe(coreC.state.sessions); // a hand-over: the reducer goes on
    expect(next.mailState).not.toBeNull();
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    expect(liveCounts(b)).toEqual([1, 1, 1]);
    expect(liveCounts(c)).toEqual([0, 0, 0]);
    await expect(next.registry.synthetic({ sessionID: 'ses_a' })).resolves.toMatchObject({ id: 'msg_proj' });
    await cleanupA(); // not attached: only `a` goes
    await flush(20);
    expect(globalThis[KEY]).toBe(next);
    expect(liveCounts(a)).toEqual([0, 0, 0]);
  });

  test('end to end: two directories, a session in each, plain `tmx who` tagged with its own pane, allowed without rules, left `ask` under a project bash rule', async () => {
    const mod = await import(ASSET);
    const env = fakeEnv();
    const root = tmp();
    const proj1 = path.join(root, 'proj1');
    const proj2 = path.join(root, 'proj2');
    mkdirSync(proj1);
    mkdirSync(proj2);
    env.setPanes(row('web', 'opencode', proj1, '%4') + row('dev', 'opencode', proj2, '%9'));
    const a = ocCtx(proj1);
    const b = ocCtx(proj2);
    const cleanupA = await mod.default.setup(a);
    const cleanupB = await mod.default.setup(b);
    // b is the last setup: its subscription feeds the core (every instance sees every event).
    b.push(ev('session.created', { sessionID: 'ses_one' }, proj1));
    b.push(ev('session.created', { sessionID: 'ses_two' }, proj2));
    b.push(ev('session.inbox.enqueued', { sessionID: 'ses_one', inboxID: 'i1', item: { type: 'user' } }, proj1));
    b.push(ev('session.inbox.enqueued', { sessionID: 'ses_two', inboxID: 'i2', item: { type: 'user' } }, proj2));
    for (const sid of ['ses_one', 'ses_two']) b.push(ev('session.execution.started', { sessionID: sid }));
    const core = globalThis[KEY];
    await vi.waitFor(() => {
      expect(core.paneOfSession('ses_one')).toBe('%4');
      expect(core.paneOfSession('ses_two')).toBe('%9');
    });

    const one = runCommand(a, 'ses_one', 'tmx who', 'call_one');
    const two = runCommand(b, 'ses_two', 'tmx who', 'call_two');
    expect(one.env.TMUXIFIER_MAIL_PANE).toBe('%4');
    expect(two.env.TMUXIFIER_MAIL_PANE).toBe('%9');
    expect(one.env.TMUX_PANE).toBe('%0'); // OpenCode's own env is kept
    expect(one.effect).toBe('allow');
    expect(two.effect).toBe('allow');

    // The operator writes a bash rule into proj2's config: proj2's next tmx asks, proj1's does not.
    writeFileSync(path.join(proj2, 'opencode.json'), JSON.stringify({ permission: { bash: { '*': 'ask' } } }));
    const two2 = runCommand(b, 'ses_two', 'tmx who', 'call_two2');
    const one2 = runCommand(a, 'ses_one', 'tmx who', 'call_one2');
    expect(two2.effect).toBe('ask');
    expect(two2.env.TMUXIFIER_MAIL_PANE).toBe('%9');
    expect(one2.effect).toBe('allow');
    await cleanupA();
    await cleanupB();
  });
});

describe('registration edge cases (issue #18)', () => {
  // Timers the test runs by hand.
  function manualTimers() {
    const t = { list: [] };
    t.setTimeout = (fn, ms) => { const h = { fn, ms, unref() {} }; t.list.push(h); return h; };
    t.clearTimeout = (h) => { t.list = t.list.filter((x) => x !== h); };
    t.runAll = () => { const due = t.list.splice(0); for (const h of due) h.fn(); return due.map((h) => h.ms); };
    return t;
  }

  test('a refused registration gives back the others and is retried, 30 s doubling; it hooks once OpenCode accepts', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    let refuse = 2;
    const realHook = a.permission.hook;
    a.permission.hook = async (...args) => { if (refuse > 0) { refuse -= 1; throw new Error('refused'); } return realHook(...args); };
    const timers = manualTimers();
    const settledCalls = [];
    const reg = createRegistry({ live: new Map([['/home/user/proj', a]]), mail: true, current: () => fakeCore(), rules: noRules, onSettled: () => settledCalls.push(1), ...timers });
    reg.addAll();
    await flush(5);
    expect(reg.isHooked('/home/user/proj')).toBe(false);
    expect(liveCounts(a)).toEqual([0, 0, 0]); // the two that worked were given back
    expect(timers.runAll()).toEqual([30000]);
    await flush(5);
    expect(reg.isHooked('/home/user/proj')).toBe(false);
    expect(timers.runAll()).toEqual([60000]);
    await flush(5);
    expect(reg.isHooked('/home/user/proj')).toBe(true);
    expect(liveCounts(a)).toEqual([1, 1, 1]);
    expect(settledCalls).toHaveLength(1);
    expect(timers.list).toEqual([]);
  });

  test('a ctx refused every time is tried five times in all, then left alone; a dead or removed ctx is not retried', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    a.tool.hook = vi.fn(async () => { throw new Error('refused'); });
    const timers = manualTimers();
    const live = new Map([['/home/user/proj', a]]);
    const reg = createRegistry({ live, mail: true, current: () => fakeCore(), rules: noRules, ...timers });
    reg.addAll();
    const delays = [];
    for (let i = 0; i < 6; i++) {
      await flush(5);
      delays.push(...timers.runAll());
    }
    expect(delays).toEqual([30000, 60000, 120000, 240000]);
    expect(a.tool.hook).toHaveBeenCalledTimes(5);

    const b = ocCtx('/home/user/proj2');
    b.tool.hook = vi.fn(async () => { throw new Error('refused'); });
    live.set('/home/user/proj2', b);
    reg.add(b);
    await flush(5);
    live.delete('/home/user/proj2'); // its cleanup ran
    timers.runAll();
    await flush(5);
    expect(b.tool.hook).toHaveBeenCalledTimes(1);

    const c = ocCtx('/home/user/proj3');
    c.tool.hook = vi.fn(async () => { throw new Error('refused'); });
    live.set('/home/user/proj3', c);
    reg.add(c);
    await flush(5);
    expect(timers.list).toHaveLength(1);
    reg.remove(c);
    expect(timers.list).toEqual([]);
    reg.add(ocCtx('/x')); // unrelated; dispose clears any retry
    reg.dispose();
    expect(timers.list).toEqual([]);
  });

  test('remove(ctx) of a hooked ctx has the core re-check its targets at once; of an unhooked one it does not', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    b.tool.hook = async () => { throw new Error('refused'); };
    const calls = [];
    const reg = createRegistry({ live: new Map([['/home/user/proj', a], ['/home/user/proj2', b]]), mail: true, current: () => fakeCore(), rules: noRules, onSettled: () => calls.push('sync'), setTimeout: () => null, clearTimeout: () => {} });
    reg.addAll();
    await flush(5);
    expect(calls).toEqual(['sync']); // a settled
    reg.remove(b);
    expect(calls).toEqual(['sync']);
    reg.remove(a);
    expect(calls).toEqual(['sync', 'sync']);
    reg.remove(a);
    expect(calls).toEqual(['sync', 'sync']);
  });

  test('disposeAfter: a next registry that never settles still has the old one disposed after waitMs', async () => {
    const { disposeAfter } = await import(ASSET);
    const timers = manualTimers();
    const old = { dispose: vi.fn() };
    disposeAfter({ registry: old }, { settled: () => new Promise(() => {}) }, { waitMs: 10000, ...timers });
    await flush(5);
    expect(old.dispose).not.toHaveBeenCalled();
    expect(timers.list.map((h) => h.ms)).toEqual([10000]);
    timers.runAll();
    expect(old.dispose).toHaveBeenCalledTimes(1);

    const old2 = { dispose: vi.fn() };
    disposeAfter({ registry: old2 }, { settled: () => Promise.resolve() }, { waitMs: 10000, ...timers });
    await flush(5);
    expect(old2.dispose).toHaveBeenCalledTimes(1);
    expect(timers.list).toEqual([]); // the cap was cleared
    timers.runAll();
    expect(old2.dispose).toHaveBeenCalledTimes(1);
  });

  test('takeOver: a createCore that throws leaves the previous core running and untouched', async () => {
    const { takeOver } = await import(ASSET);
    const prev = { abort: vi.fn(), registry: { dispose: vi.fn() }, written: new Map([['main', 'x']]) };
    expect(() => takeOver(prev, { home: 42 })).toThrow();
    expect(prev.abort).not.toHaveBeenCalled();
    expect(prev.registry.dispose).not.toHaveBeenCalled();
    const next = takeOver(prev, { home: tmp(), setInterval: () => null, clearInterval: () => {}, listPanes: async () => '' });
    expect(prev.abort).toHaveBeenCalledTimes(1);
    expect(next.written).toBe(prev.written);
    next.abort();
  });
});
