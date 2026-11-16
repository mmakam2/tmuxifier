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

  test('synthetic goes through the ctx of the session\'s directory, else any live one', async () => {
    const { createRegistry } = await import(ASSET);
    const a = ocCtx('/home/user/proj');
    const b = ocCtx('/home/user/proj2');
    const core = fakeCore({}, { ses_b: '/home/user/proj2', ses_x: '/elsewhere' });
    const reg = createRegistry({ live: new Map([['/home/user/proj', a], ['/home/user/proj2', b]]), mail: true, current: () => core, rules: noRules });
    const input = { sessionID: 'ses_b', text: 'hi', delivery: 'queue', resume: true, metadata: { tmuxifierMail: 'm-aaaaaaaa' } };
    await expect(reg.synthetic(input)).resolves.toEqual({ id: 'msg_proj2', sessionID: 'ses_b', type: 'synthetic' });
    expect(b.session.synthetic).toHaveBeenCalledWith(input);
    expect(b.session.synthetic.mock.contexts[0]).toBe(b.session); // called as OpenCode's method
    expect(a.session.synthetic).not.toHaveBeenCalled();
    await expect(reg.synthetic({ sessionID: 'ses_x' })).resolves.toMatchObject({ id: 'msg_proj' });
    await expect(reg.synthetic({ sessionID: 'ses_unknown' })).resolves.toMatchObject({ id: 'msg_proj' });
    expect(a.session.synthetic).toHaveBeenCalledTimes(2);
  });

  test('synthetic skips a ctx that cannot post, and with none left it rejects (never throws)', async () => {
    const { createRegistry } = await import(ASSET);
    const old = ocCtx('/home/user/proj', { synthetic: false });
    const b = ocCtx('/home/user/proj2');
    const core = fakeCore({}, { ses_a: '/home/user/proj' });
    const reg = createRegistry({ live: new Map([['/home/user/proj', old], ['/home/user/proj2', b]]), mail: true, current: () => core, rules: noRules });
    await expect(reg.synthetic({ sessionID: 'ses_a' })).resolves.toMatchObject({ id: 'msg_proj2' });
    const none = createRegistry({ live: new Map(), mail: true, current: () => core, rules: noRules });
    let p;
    expect(() => { p = none.synthetic({ sessionID: 'ses_a' }); }).not.toThrow();
    await expect(p).rejects.toThrow();
    const throwing = ocCtx('/home/user/proj');
    throwing.session.synthetic = () => { throw new Error('sync throw'); };
    const t = createRegistry({ live: new Map([['/home/user/proj', throwing]]), mail: true, current: () => core, rules: noRules });
    let q;
    expect(() => { q = t.synthetic({ sessionID: 'ses_a' }); }).not.toThrow();
    await expect(q).rejects.toThrow('sync throw');
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
    writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1 $2 $3" = "list-panes -a -F" ] || exit 2\ncat "$TMUXIFIER_FAKE_PANES"\n');
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
    await mod.default.setup(a2);
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
    await cleanupC(); // the owner: everything stops
    await flush(0);
    for (const ctx of [a2, c]) expect(liveCounts(ctx)).toEqual([0, 0, 0]);
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
