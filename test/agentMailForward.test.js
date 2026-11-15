import { test, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAgentMailForward, ENSURE_REMOTE, REMOVE_REMOTE, verifyRemote } from '../src/server/agentMailForward.js';
import { createAgentMailListener } from '../src/server/agentMailListener.js';
import { createMailHarness } from './helpers/agentMailHarness.js';

// The forward keeper against a scripted ssh: `run` answers by argv shape from a small model of
// what OpenSSH was measured to do (spike 2, "The forward's lifecycle"), and records every call.
// The listener and the hub are real, and the verify call is a real HTTP request to the
// listener's socket, made only when the model says the box-side socket leads there.

const SSH = { controlDir: '/run/cm', sshConfigFile: '/etc/test-ssh-config' };

// host -> what is true on that box and its master.
//   pid      the master's pid, null when there is none
//   forward  the local socket path the master forwards to, null when none
//   file     a socket file exists at ~/.tmuxifier-mail/sock on the box
//   linked   that file is the live forward's listener (a deleted-and-recreated or stale file is not)
function createWorld() {
  const boxes = new Map();
  const calls = [];
  let nextPid = 4000;
  let gate = null;
  const world = {
    calls,
    add(host, over = {}) {
      const b = { pid: nextPid++, home: `/home/${host.split('.')[0]}`, tools: 'yes', forward: null, file: false, linked: false, curl: true, forwardFails: false, ...over };
      boxes.set(host, b);
      return b;
    },
    box: (host) => boxes.get(host),
    newMaster(host) { const b = boxes.get(host); b.pid = nextPid++; b.forward = null; b.linked = false; },
    // Makes every run wait until the returned release() is called.
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    throwing: false,
    // The calls since `from`, as short names.
    ops(from = 0) { return calls.slice(from).map((c) => c.op); },
    async run(argv, opts = {}) {
      if (world.throwing) throw new Error('spawn ssh ENOENT');
      if (gate) await gate;
      const o = argv.indexOf('-O');
      if (o !== -1) {
        const op = argv[o + 1];
        const host = argv.at(-1).replace(/^.*@/, '');
        const r = argv.indexOf('-R');
        const spec = r === -1 ? null : argv[r + 1];
        calls.push({ op, host, spec, argv, timeout: opts.timeout });
        const b = boxes.get(host);
        if (!b || !b.pid) return { code: 255, stdout: '', stderr: 'Control socket connect(/run/cm/x): No such file or directory\r\n' };
        if (op === 'check') return { code: 0, stdout: '', stderr: `Master running (pid=${b.pid})\r\n` };
        const [remote, local] = spec.split(':');
        expect(remote).toBe(`${b.home}/.tmuxifier-mail/sock`);
        if (op === 'cancel') {
          if (!b.forward) return { code: 255, stdout: '', stderr: 'mux_client_forward: forwarding request failed: port forwarding not found\r\n' };
          b.forward = null; b.linked = false; // the file stays behind
          return { code: 0, stdout: '', stderr: '' };
        }
        if (op === 'forward') {
          if (b.forwardFails) return { code: 255, stdout: '', stderr: 'mux_client_forward: forwarding request failed\r\n' };
          if (b.forward) return { code: 0, stdout: '', stderr: '' }; // already held: nothing done
          if (b.file) return { code: 255, stdout: '', stderr: `remote port forwarding failed for listen path ${remote}\r\n` };
          b.forward = local; b.file = true; b.linked = true;
          return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected control command ${op}`);
      }
      const remote = argv.at(-1);
      const host = argv.at(-2).replace(/^.*@/, '');
      const b = boxes.get(host);
      if (remote === ENSURE_REMOTE) {
        calls.push({ op: 'ensure', host, argv, timeout: opts.timeout });
        if (!b.pid) b.pid = nextPid++;
        b.file = false; b.linked = false;
        return { code: 0, stdout: b.ensureOut ?? `motd line\n__MAILHOME__ ${b.home}\n__MAILTOOLS__ ${b.tools}\n`, stderr: '' };
      }
      if (remote === REMOVE_REMOTE) {
        calls.push({ op: 'rm', host, argv, timeout: opts.timeout });
        b.file = false; b.linked = false;
        return { code: 0, stdout: '', stderr: '' };
      }
      const n = /n=([a-f0-9]{16})"$/.exec(remote)?.[1];
      if (n && remote === verifyRemote(n)) {
        calls.push({ op: 'verify', host, nonce: n, argv, timeout: opts.timeout });
        if (!b.curl || !b.file || !b.linked || !b.forward) return { code: 7, stdout: '', stderr: '' };
        const status = await ping(b.forward, n);
        return { code: status ? 0 : 7, stdout: status === 200 ? 'ok\n' : '', stderr: '' };
      }
      throw new Error(`unexpected remote command ${remote}`);
    },
  };
  return world;
}

// One GET over a unix socket; the status code, or null when nothing answered.
function ping(socketPath, n) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: `/v1/ping?n=${n}`, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const sockOf = (dataDir, id) => path.join(dataDir, 'mail', `${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}.sock`);

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

// o (orders) sends, b (billing) receives, c has no policy at all.
async function bench(opts = {}) {
  const h = await createMailHarness();
  const dataDir = opts.dataDir ?? fs.mkdtempSync('/tmp/tmx-u-');
  const world = createWorld();
  world.add('orders.example.com');
  world.add('billing.example.com');
  world.add('c.example.com');
  const boxes = [
    { id: 'o', label: 'orders', host: 'orders.example.com', user: 'me', sessionName: 'main' },
    { id: 'b', label: 'billing', host: 'billing.example.com', sessionName: 'main' },
    { id: 'c', label: 'third', host: 'c.example.com', sessionName: 'main' },
  ];
  const clock = { t: 1_000_000 };
  const up = { o: { reachable: true }, b: { reachable: true }, c: { reachable: true } };
  const fwd = createAgentMailForward({
    run: world.run,
    policyStore: h.policyStore,
    hub: h.hub,
    dataDir,
    sshOpts: SSH,
    now: () => clock.t,
    retryBaseMs: 1000,
    retryCapMs: 4000,
    ...opts.forward,
  });
  cleanups.push(async () => {
    await fwd.stopAll();
    await h.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { h, dataDir, world, boxes, clock, up, fwd };
}

test('a box with both switches off gets no listener and no ssh call', async () => {
  const { dataDir, world, boxes, fwd } = await bench();
  await fwd.sync([boxes[2]], { c: { reachable: true } });
  expect(world.calls).toEqual([]);
  expect(fwd.status('c')).toEqual({ state: 'off', installed: null, listening: 0 });
  expect(fs.existsSync(path.join(dataDir, 'mail'))).toBe(false);
  expect(fwd.status('nope')).toEqual({ state: 'off', installed: null, listening: 0 });
});

test('first sync on an enabled, reachable box: ensure, forward, verify, state up', async () => {
  const { h, dataDir, world, boxes, fwd } = await bench();
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops()).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify']);
  const [check, ensure, cancel, forward, verify] = world.calls;
  // Every command goes to the box's own master, through the configured ssh options.
  for (const c of world.calls) {
    expect(c.argv.slice(0, 2)).toEqual(['-F', SSH.sshConfigFile]);
    expect(c.argv).toContain('ControlPath=/run/cm/%C');
  }
  expect(check.argv.at(-1)).toBe('me@orders.example.com');
  expect(check.timeout).toBe(6000);
  expect(ensure.timeout).toBe(10000);
  expect(verify.timeout).toBe(10000);
  expect(ensure.argv.at(-1)).toBe(
    'mkdir -p "$HOME/.tmuxifier-mail" && chmod 700 "$HOME/.tmuxifier-mail" && rm -f "$HOME/.tmuxifier-mail/sock" && printf \'__MAILHOME__ %s\\n\' "$HOME" && if [ -x "$HOME/.tmuxifier-mail/tmx" ]; then echo \'__MAILTOOLS__ yes\'; else echo \'__MAILTOOLS__ no\'; fi',
  );
  const local = sockOf(dataDir, 'o');
  expect(forward.spec).toBe(`/home/orders/.tmuxifier-mail/sock:${local}`);
  expect(cancel.spec).toBe(forward.spec);
  expect(verify.argv.at(-1)).toBe(`curl -s -m 3 --unix-socket "$HOME/.tmuxifier-mail/sock" "http://mail/v1/ping?n=${verify.nonce}"`);
  expect(fwd.status('o')).toEqual({ state: 'up', installed: true, listening: 0 });
  // The listener is real, on its own 0600 socket in a 0700 directory.
  expect(fs.statSync(path.dirname(local)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(local).mode & 0o777).toBe(0o600);
  expect(await ping(local, 'abcdef0123456789')).toBe(200);
  // listening is the hub's count of connected waiters for that box.
  h.marks.o.main = { state: 'working', cause: 'prompt', ts: 1 };
  const ac = new AbortController();
  const held = h.hub.waitMail({ boxId: 'o', session: 'main' }, '%1', ac.signal);
  expect(fwd.status('o').listening).toBe(1);
  ac.abort();
  expect(await held).toEqual({ idle: true });
  expect(fwd.status('o').listening).toBe(0);
});

test('same master pid on the next sync: no ssh call beyond -O check', async () => {
  const { world, boxes, up, fwd } = await bench();
  await fwd.sync(boxes, up);
  const n = world.calls.length;
  await fwd.sync(boxes, up);
  await fwd.sync(boxes, up);
  expect(world.ops(n)).toEqual(['check', 'check', 'check', 'check']);
  expect(fwd.status('o').state).toBe('up');
  expect(fwd.status('b').state).toBe('up');
});

test('a new master pid runs ensure again', async () => {
  const { world, boxes, fwd } = await bench();
  const snap = { o: { reachable: true } };
  await fwd.sync([boxes[0]], snap);
  // The master is replaced: the old forward is gone and its file stays behind on the box.
  world.newMaster('orders.example.com');
  expect(world.box('orders.example.com').file).toBe(true);
  const n = world.calls.length;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify']);
  expect(fwd.status('o').state).toBe('up');
  const n2 = world.calls.length;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n2)).toEqual(['check']);
});

test('a forward the master already holds, with its file deleted (a restart over a live master), still comes up at once', async () => {
  const { world, boxes, dataDir, fwd } = await bench();
  // What a previous Tmuxifier process left: the master forwards the box socket to our path.
  const b = world.box('orders.example.com');
  Object.assign(b, { forward: sockOf(dataDir, 'o'), file: true, linked: true });
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops()).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify']);
  expect(fwd.status('o').state).toBe('up');
});

test('verification that never reaches the listener: cancel, state error "not verified", retry only after the delay', async () => {
  const { world, boxes, clock, fwd } = await bench();
  const snap = { o: { reachable: true } };
  world.box('orders.example.com').curl = false;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops()).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify', 'cancel']);
  expect(fwd.status('o')).toEqual({ state: 'error', error: 'not verified', installed: true, listening: 0 });
  expect(world.box('orders.example.com').forward).toBe(null);

  let n = world.calls.length;
  clock.t += 999;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual([]); // held off: not even a check
  clock.t += 1;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify', 'cancel']);

  // The delay doubles: 2 s now.
  n = world.calls.length;
  clock.t += 1999;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual([]);
  clock.t += 1;
  world.box('orders.example.com').curl = true;
  await fwd.sync([boxes[0]], snap);
  expect(fwd.status('o').state).toBe('up');
  expect(fwd.status('o').error).toBeUndefined();

  // Success resets it: the next failures wait 1 s, 2 s, 4 s, and the cap holds at 4 s.
  world.box('orders.example.com').curl = false;
  world.newMaster('orders.example.com');
  for (const delay of [1000, 2000, 4000, 4000]) {
    n = world.calls.length;
    await fwd.sync([boxes[0]], snap);
    expect(world.ops(n)).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify', 'cancel']);
    expect(fwd.status('o').error).toBe('not verified');
    n = world.calls.length;
    clock.t += delay - 1;
    await fwd.sync([boxes[0]], snap);
    expect(world.ops(n)).toEqual([]);
    clock.t += 1;
  }
});

test('a $HOME with a space or ".." is refused as "bad home" and nothing is forwarded', async () => {
  // The last two pass the home rule (at most 81 characters) but make a box path over the
  // forward's 101-character limit, which sshCommand.js refuses.
  for (const home of ['/home/my user', '/home/me/../root', 'relative/home', '/home/me;id', '/home/$(id)', `/${'a'.repeat(81)}`, `/${'a'.repeat(80)}`]) {
    const { world, boxes, fwd } = await bench();
    world.box('orders.example.com').home = home;
    await fwd.sync([boxes[0]], { o: { reachable: true } });
    expect(world.ops()).toEqual(['check', 'ensure']);
    expect(fwd.status('o')).toEqual({ state: 'error', error: 'bad home', installed: true, listening: 0 });
  }
  // The longest home that fits: 80 characters, a 101-character box path.
  const { world, boxes, fwd } = await bench();
  world.box('orders.example.com').home = `/${'a'.repeat(79)}`;
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(fwd.status('o').state).toBe('up');
});

test('a home line that is missing or given twice is "bad home"', async () => {
  const { world, boxes, clock, fwd } = await bench();
  const b = world.box('orders.example.com');
  for (const out of ['motd only\n', '__MAILHOME__ /home/a\n__MAILHOME__ /home/b\n__MAILTOOLS__ no\n', '__MAILHOME__\n']) {
    b.ensureOut = out;
    world.newMaster('orders.example.com');
    const n = world.calls.length;
    await fwd.sync([boxes[0]], { o: { reachable: true } });
    expect(world.ops(n)).toEqual(['check', 'ensure']);
    expect(fwd.status('o')).toMatchObject({ state: 'error', error: 'bad home' });
    clock.t += 10_000; // past the retry delay
  }
});

test('a data directory deep enough to exceed the socket limit: state error "socket path too long", other boxes still come up', async () => {
  // Every box's socket is <dataDir>/mail/<12 hex>.sock, so a deep data directory fails them
  // all the same way: nothing is created on disk, no ssh runs, and sync still resolves.
  const base = fs.mkdtempSync('/tmp/tmx-u-');
  const deep = path.join(base, 'd'.repeat(90));
  const { world, boxes, up, fwd } = await bench({ dataDir: deep });
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  await fwd.sync(boxes, up);
  expect(world.calls).toEqual([]);
  expect(fwd.status('o')).toEqual({ state: 'error', error: 'socket path too long', installed: null, listening: 0 });
  expect(fwd.status('b')).toEqual({ state: 'error', error: 'socket path too long', installed: null, listening: 0 });
  expect(fwd.status('c').state).toBe('off');
  expect(fs.existsSync(deep)).toBe(false);

  // One box's listener failing does not hold up another's: here only o's path is too long.
  const w2 = await bench({
    forward: {
      makeListener: (o) => createAgentMailListener({ ...o, socketPath: o.boxId === 'o' ? path.join(deep, 'mail', 'x.sock') : o.socketPath }),
    },
  });
  await w2.fwd.sync(w2.boxes, w2.up);
  expect(w2.fwd.status('o')).toMatchObject({ state: 'error', error: 'socket path too long' });
  expect(w2.fwd.status('b')).toEqual({ state: 'up', installed: true, listening: 0 });
  expect(w2.world.calls.filter((c) => c.host === 'orders.example.com')).toEqual([]);
});

test('switches turned off: cancel, remote rm, listener closed, state off', async () => {
  const { h, dataDir, world, boxes, up, fwd } = await bench();
  await fwd.sync(boxes, up);
  expect(fwd.status('o').state).toBe('up');
  const local = sockOf(dataDir, 'o');
  expect(fs.existsSync(local)).toBe(true);
  await h.setPolicy('o', { send: false });
  const n = world.calls.length;
  await fwd.sync(boxes, up);
  const mine = world.calls.slice(n).filter((c) => c.host === 'orders.example.com');
  expect(mine.map((c) => c.op)).toEqual(['cancel', 'rm']);
  expect(mine[0].spec).toBe(`/home/orders/.tmuxifier-mail/sock:${local}`);
  expect(world.box('orders.example.com')).toMatchObject({ forward: null, file: false });
  expect(fs.existsSync(local)).toBe(false);
  expect(await ping(local, 'abcdef0123456789')).toBe(null);
  expect(fwd.status('o')).toEqual({ state: 'off', installed: null, listening: 0 });
  // Once torn down, nothing more is sent for it.
  const n2 = world.calls.length;
  await fwd.sync(boxes, up);
  expect(world.calls.slice(n2).filter((c) => c.host === 'orders.example.com')).toEqual([]);

  // A box removed from the list is torn down the same way.
  const n3 = world.calls.length;
  await fwd.sync([boxes[0], boxes[2]], up);
  expect(world.ops(n3)).toEqual(['cancel', 'rm']);
  expect(world.calls[n3].host).toBe('billing.example.com');
  expect(fwd.status('b').state).toBe('off');
  expect(fs.existsSync(sockOf(dataDir, 'b'))).toBe(false);
});

test('an unreachable box keeps its listener and reads down', async () => {
  const { dataDir, world, boxes, fwd } = await bench();
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  const n = world.calls.length;
  await fwd.sync([boxes[0]], { o: { reachable: false } });
  await fwd.sync([boxes[0]], {});
  expect(world.ops(n)).toEqual([]);
  expect(fwd.status('o')).toEqual({ state: 'down', installed: true, listening: 0 });
  expect(await ping(sockOf(dataDir, 'o'), 'abcdef0123456789')).toBe(200);
  // Back on the same master: up again on the check alone.
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops(n)).toEqual(['check']);
  expect(fwd.status('o').state).toBe('up');
});

test('no master at the check: the ensure brings one up and its pid is recorded', async () => {
  const { world, boxes, fwd } = await bench();
  world.box('orders.example.com').pid = null;
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops()).toEqual(['check', 'ensure', 'cancel', 'forward', 'verify', 'check']);
  expect(fwd.status('o').state).toBe('up');
  const n = world.calls.length;
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops(n)).toEqual(['check']);
});

test('__MAILTOOLS__ no reports installed: false', async () => {
  const { world, boxes, fwd } = await bench();
  world.box('orders.example.com').tools = 'no';
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(fwd.status('o')).toEqual({ state: 'up', installed: false, listening: 0 });
});

test('a recheck runs the nonce call alone, is skipped after traffic, and repairs a failed one with a full ensure', async () => {
  const { dataDir, world, boxes, clock, fwd } = await bench({ forward: { recheckMs: 600000 } });
  const snap = { o: { reachable: true } };
  await fwd.sync([boxes[0]], snap);
  let n = world.calls.length;
  clock.t += 599999;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual(['check']);
  clock.t += 1;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n + 1)).toEqual(['check', 'verify']);

  // A request from the box since the last check proves the path: no verify, the clock restarts.
  await new Promise((r) => setTimeout(r, 5));
  expect(await ping(sockOf(dataDir, 'o'), 'abcdef0123456789')).toBe(200);
  n = world.calls.length;
  clock.t += 600000;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual(['check']);
  clock.t += 599999;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n + 1)).toEqual(['check']);

  // The file deleted on the box under the live master: the recheck fails and is repaired.
  Object.assign(world.box('orders.example.com'), { file: false, linked: false });
  n = world.calls.length;
  clock.t += 1;
  await fwd.sync([boxes[0]], snap);
  expect(world.ops(n)).toEqual(['check', 'verify', 'ensure', 'cancel', 'forward', 'verify']);
  expect(fwd.status('o').state).toBe('up');
});

test('changed connection fields are a new master: the old forward is cancelled, the new box ensured', async () => {
  const { world, boxes, dataDir, fwd } = await bench();
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  world.add('orders2.example.com', { home: '/home/orders' });
  const moved = { ...boxes[0], host: 'orders2.example.com' };
  const n = world.calls.length;
  await fwd.sync([moved], { o: { reachable: true } });
  expect(world.calls.slice(n).map((c) => `${c.op}@${c.host}`)).toEqual([
    'cancel@orders.example.com',
    'check@orders2.example.com', 'ensure@orders2.example.com', 'cancel@orders2.example.com',
    'forward@orders2.example.com', 'verify@orders2.example.com',
  ]);
  expect(world.box('orders.example.com').forward).toBe(null);
  expect(world.box('orders2.example.com').forward).toBe(sockOf(dataDir, 'o'));
  expect(fwd.status('o').state).toBe('up');
});

test('a sync that overlaps a running one is skipped; a throwing run never rejects sync', async () => {
  const { world, boxes, up, fwd } = await bench();
  const release = world.hold();
  const first = fwd.sync(boxes, up);
  const second = fwd.sync(boxes, up);
  await second; // resolves without waiting for the first
  release();
  await first;
  // Exactly one round per enabled box.
  expect(world.calls.filter((c) => c.op === 'check')).toHaveLength(2);
  expect(fwd.status('o').state).toBe('up');

  world.throwing = true;
  world.newMaster('orders.example.com');
  await expect(fwd.sync(boxes, up)).resolves.toBeUndefined();
  expect(fwd.status('o')).toMatchObject({ state: 'error', error: 'forward failed' });
  // A policy store that throws, and garbage input, do not reject either.
  const broken = createAgentMailForward({ run: world.run, policyStore: { all: async () => { throw new Error('disk'); } }, hub: { listening: () => ({}) }, dataDir: '/tmp', sshOpts: SSH });
  await expect(broken.sync(boxes, up)).resolves.toBeUndefined();
  await expect(fwd.sync(null, null)).resolves.toBeUndefined();
});

test('a forward the box refuses is "forward failed"; without a control dir nothing is attempted', async () => {
  const { world, boxes, fwd } = await bench();
  world.box('orders.example.com').forwardFails = true;
  await fwd.sync([boxes[0]], { o: { reachable: true } });
  expect(world.ops()).toEqual(['check', 'ensure', 'cancel', 'forward', 'cancel']);
  expect(fwd.status('o')).toMatchObject({ state: 'error', error: 'forward failed' });

  const w2 = await bench({ forward: { sshOpts: {} } });
  await w2.fwd.sync([w2.boxes[0]], { o: { reachable: true } });
  expect(w2.world.calls).toEqual([]);
  expect(w2.fwd.status('o')).toMatchObject({ state: 'error', error: 'forward failed' });
});

test('stopAll closes every listener and cancels nothing; a later sync does nothing', async () => {
  const { dataDir, world, boxes, up, fwd } = await bench();
  await fwd.sync(boxes, up);
  const n = world.calls.length;
  await fwd.stopAll();
  expect(world.calls.length).toBe(n);
  expect(world.box('orders.example.com').forward).toBe(sockOf(dataDir, 'o'));
  expect(fs.existsSync(sockOf(dataDir, 'o'))).toBe(false);
  expect(fs.existsSync(sockOf(dataDir, 'b'))).toBe(false);
  await fwd.sync(boxes, up);
  expect(world.calls.length).toBe(n);
});
