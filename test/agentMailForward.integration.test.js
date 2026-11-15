import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupLocalBox } from './helpers/localBox.js';
import { createMailHarness } from './helpers/agentMailHarness.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { buildProbeArgv, buildControlCheckArgv, shSingleQuote } from '../src/server/sshCommand.js';
import { createStatusChecker } from '../src/server/status.js';
import { createAgentMailForward } from '../src/server/agentMailForward.js';

// The forward against a real sshd, a real ControlMaster and the box's real login shell, and the
// whole feature end to end through it: tmx on the box -> ~/.tmuxifier-mail/sock -> the master's
// -R forward -> the per-box listener -> the hub, and back to a box-side hook-wait.
//
// tmx finds its session with `tmux display-message -t "$TMUX_PANE"`, so it runs over ssh with
// TMUX and TMUX_PANE set to a real pane of the fixture's own tmux server (TMUX_TMPDIR is private
// to the fixture), not typed into a pane with send-keys: that gives each run its own exit code,
// stdout and stderr, exactly, with no prompt or rc file in the loop, while the session lookup is
// still tmux's own answer for a real pane.

const ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-mail.sh', import.meta.url));

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};

// `second`: a second box record for the SAME machine under another ssh name (as the e2e setup's
// aliases are), with both switches on: same HostName, port and user, so one ControlMaster.
async function harness(forwardOptions = {}, { second = false } = {}) {
  const lb = await setupLocalBox();
  if (second) {
    const opts = fs.readFileSync(lb.sshConfigFile, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('Host ')).join('\n');
    fs.appendFileSync(lb.sshConfigFile, `\nHost tmuxifierlocal-b\n${opts}\n`);
  }
  const controlDir = path.join(lb.tmp, 'cm');
  fs.mkdirSync(controlDir, { mode: 0o700 });
  const sshOpts = { sshConfigFile: lb.sshConfigFile, controlDir, controlPersist: 60 };
  const run = (argv, o = {}) => sshRun(argv, { env: lb.env, ...o });
  const remote = (cmd, timeout = 10000) => run(buildProbeArgv(lb.box, cmd, sshOpts), { timeout });
  const dataDir = fs.mkdtempSync('/tmp/tmx-m-');
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: 'a' };
  const box2 = second ? { id: 'b2', label: 'local-again', host: 'tmuxifierlocal-b', sessionName: 'a' } : null;
  const allBoxes = second ? [box, box2] : [box];

  // tmx installed where setup puts it; sessions a and b each "running an agent" (a session-wide
  // marker, idle), on real tmux sessions of the fixture's server.
  const mailDir = path.join(lb.home, '.tmuxifier-mail');
  fs.mkdirSync(mailDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(ASSET, path.join(mailDir, 'tmx'));
  fs.chmodSync(path.join(mailDir, 'tmx'), 0o755);
  const markDir = path.join(lb.home, '.tmuxifier-agent');
  fs.mkdirSync(markDir, { recursive: true });
  const epoch = Math.floor(Date.now() / 1000);
  for (const s of ['a', 'b']) fs.writeFileSync(path.join(markDir, s), `${s}:ready:${epoch}:stop\n`);
  const panes = {};
  let tmuxEnv = null;
  for (const s of ['a', 'b']) {
    expect((await remote(`tmux new-session -d -s ${s}`)).code).toBe(0);
    const out = (await remote(`tmux display-message -p -t '=${s}:' '#{pane_id} #{socket_path},#{pid},0'`)).stdout.trim();
    const [pane, env] = out.split(' ');
    expect(pane).toMatch(/^%\d+$/);
    expect(env).toMatch(/^\/[A-Za-z0-9_./-]+,\d+,0$/);
    panes[s] = pane;
    tmuxEnv = env;
  }

  // The backend's view of the box's agents comes from a real status probe.
  let marks = null;
  const h = await createMailHarness(
    { marksOf: (id) => (id === 'b1' || id === 'b2' ? marks : null) },
    { boxes: allBoxes, policies: second ? { b1: { send: true, receive: true }, b2: { send: true, receive: true } } : { b1: { send: true, receive: true } } },
  );
  const checker = createStatusChecker({ run: (argv) => run(argv), ...sshOpts });
  const refreshMarks = async () => {
    const r = await checker.checkAgents(box);
    marks = r?.agentMarks ?? null;
    h.hub.boxChanged('b1');
    return marks;
  };
  expect(await refreshMarks()).toMatchObject({ a: { state: 'ready' }, b: { state: 'ready' } });

  const makeForward = (hub = h.hub) => createAgentMailForward({
    run, policyStore: h.policyStore, hub, dataDir, sshOpts, retryBaseMs: 100, retryCapMs: 1000, ...forwardOptions,
  });
  const forwards = [makeForward()];
  const fwd = forwards[0];
  const snapshot = { b1: { reachable: true }, b2: { reachable: true } };
  const sync = (f = fwd) => f.sync(allBoxes, snapshot);

  // tmx on the box, inside session `s`. Short sleeps and curl times keep the retries quick.
  const tmx = (s, args, { timeout = 30000, input } = {}) => {
    const cmd = `TMUX=${shSingleQuote(tmuxEnv)} TMUX_PANE=${shSingleQuote(panes[s])} TMUXIFIER_MAIL_TEST_SLEEP=0.2 TMUXIFIER_MAIL_TEST_MAX_TIME=5 `
      + `sh "$HOME/.tmuxifier-mail/tmx" ${args.map(shSingleQuote).join(' ')}`;
    const argv = buildProbeArgv(lb.box, cmd, sshOpts);
    return input === undefined ? run(argv, { timeout }) : sshRunStdin(argv, input, { env: lb.env, timeout });
  };
  const masterPid = async () => /pid=(\d+)/.exec((await run(buildControlCheckArgv(lb.box, sshOpts), { timeout: 6000 })).stderr)?.[1] ?? null;
  const boxSock = path.join(mailDir, 'sock');

  teardown = async () => {
    for (const f of forwards) await f.stopAll();
    try { await remote('tmux kill-server', 5000); } catch { /* none */ }
    try { await run(['-F', lb.sshConfigFile, '-o', `ControlPath=${path.join(controlDir, '%C')}`, '-O', 'exit', lb.box.host]); } catch { /* no master */ }
    await lb.cleanup();
    await h.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { lb, h, box, box2, snapshot, fwd, forwards, makeForward, sync, tmx, remote, refreshMarks, masterPid, boxSock, dataDir };
}

test('forward comes up on a live master and a box-side tmx send reaches the hub', async () => {
  const { h, fwd, sync, tmx, boxSock } = await harness();
  await sync();
  expect(fwd.status('b1')).toEqual({ state: 'up', installed: true, listening: 0 });
  expect(fs.lstatSync(boxSock).isSocket()).toBe(true);
  expect(fs.statSync(path.dirname(boxSock)).mode & 0o777).toBe(0o700);

  const sent = await tmx('a', ['send', './b', 'please check the orders table']);
  expect(sent.stderr).toBe('');
  expect(sent.code).toBe(0);
  const id = /Thread (t-[a-z2-9]{8})\./.exec(sent.stdout)?.[1];
  expect(id).toBeTruthy();
  // The listener named the box; the session is tmux's answer for the pane tmx ran in.
  const t = h.store.thread(id);
  expect(t.starter).toEqual({ boxId: 'b1', session: 'a' });
  expect(t.peer).toEqual({ boxId: 'b1', session: 'b' });
  expect(t.messages.map((m) => m.body)).toEqual(['please check the orders table']);
}, 60000);

test('end to end: a box-side hook-wait for session b exits 2 with the tagged text after a send from session a', async () => {
  const { h, fwd, sync, tmx } = await harness();
  await sync();
  const waiting = tmx('b', ['hook-wait'], { timeout: 45000 });
  // The waiter's held request came through the forward: the backend sees b listening.
  expect(await until(() => fwd.status('b1').listening === 1, 10000)).toBe(true);

  const sent = await tmx('a', ['send', './b', 'run the nightly report']);
  expect(sent.code).toBe(0);
  const woke = await waiting;
  expect(woke.code).toBe(2);
  expect(woke.stdout).toBe('');
  const tag = /^\[tmuxifier-mail (m-[a-z2-9]{8})\]/.exec(woke.stderr);
  expect(tag).toBeTruthy();
  expect(woke.stderr).toContain('run the nightly report');
  const id = /Thread (t-[a-z2-9]{8})\./.exec(sent.stdout)[1];
  expect(h.store.thread(id).messages[0]).toMatchObject({ id: tag[1], state: 'handed' });

  // The prompt hook on b confirms it, through the same socket, and prints nothing.
  const acked = await tmx('b', ['hook-ack'], { input: JSON.stringify({ prompt: woke.stderr }) });
  expect(acked).toMatchObject({ code: 0, stdout: '', stderr: '' });
  expect(h.store.thread(id).messages[0].state).toBe('delivered');
}, 90000);

test('master killed and replaced: the stale socket file is removed and the forward returns', async () => {
  const { fwd, sync, tmx, refreshMarks, masterPid, boxSock } = await harness();
  await sync();
  const pid = await masterPid();
  expect(pid).toMatch(/^\d+$/);
  const before = fs.lstatSync(boxSock).ino;

  process.kill(Number(pid), 'SIGKILL');
  expect(await until(async () => (await masterPid()) === null, 5000)).toBe(true);
  // The file stays behind on the box and leads nowhere.
  expect(fs.lstatSync(boxSock).isSocket()).toBe(true);
  const dead = await tmx('a', ['who']);
  expect(dead.code).toBe(3);

  // The next sweep's probe brings up a new master; the next sync finds its new pid.
  expect(await refreshMarks()).toBeTruthy();
  const pid2 = await masterPid();
  expect(pid2).toMatch(/^\d+$/);
  expect(pid2).not.toBe(pid);
  await sync();
  expect(fwd.status('b1').state).toBe('up');
  expect(fs.lstatSync(boxSock).ino).not.toBe(before);
  const who = await tmx('a', ['who']);
  expect(who.code).toBe(0);
  expect(who.stdout).toMatch(/\bb\b/);
}, 90000);

test('socket file deleted under a live master: the recheck repairs it', async () => {
  const { fwd, sync, tmx, masterPid, boxSock } = await harness({ recheckMs: 0 });
  await sync();
  const pid = await masterPid();
  fs.unlinkSync(boxSock);
  expect((await tmx('a', ['who'])).code).toBe(3);

  await sync();
  expect(await masterPid()).toBe(pid); // same master, repaired in place
  expect(fwd.status('b1').state).toBe('up');
  expect(fs.lstatSync(boxSock).isSocket()).toBe(true);
  expect((await tmx('a', ['who'])).code).toBe(0);
}, 90000);

test('listener closed and reopened (a Tmuxifier restart): a waiting hook-wait still receives queued mail', async () => {
  const { h, fwd, forwards, makeForward, sync, tmx, masterPid } = await harness();
  await sync();
  const pid = await masterPid();
  const waiting = tmx('b', ['hook-wait'], { timeout: 60000 });
  expect(await until(() => fwd.status('b1').listening === 1, 10000)).toBe(true);

  // The backend stops: its listener goes, the forward and the master stay.
  await fwd.stopAll();
  // While it is down, mail for b is queued by the next process's hub.
  const hub2 = h.makeHub();
  const sent = await hub2.send({ boxId: 'b1', session: 'a' }, './b', 'sent while you were away');
  expect(sent.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 1000)); // the waiter keeps retrying meanwhile

  // The next process: a new hub, a new listener on the same path, and its first sync, over the
  // master the previous process made the forward on.
  const fwd2 = makeForward(hub2);
  forwards.push(fwd2);
  await sync(fwd2);
  expect(fwd2.status('b1').state).toBe('up');
  expect(await masterPid()).toBe(pid);
  const woke = await waiting;
  expect(woke.code).toBe(2);
  expect(woke.stderr).toMatch(/^\[tmuxifier-mail m-[a-z2-9]{8}\]/);
  expect(woke.stderr).toContain('sent while you were away');
}, 90000);

test('switches off: the socket file is gone from the box', async () => {
  const { h, fwd, sync, tmx, boxSock, dataDir } = await harness();
  await sync();
  expect(fs.existsSync(boxSock)).toBe(true);
  expect(fs.readdirSync(path.join(dataDir, 'mail'))).toHaveLength(1);

  await h.setPolicy('b1', { send: false, receive: false });
  await sync();
  expect(fwd.status('b1')).toEqual({ state: 'off', installed: null, listening: 0 });
  expect(fs.existsSync(boxSock)).toBe(false);
  expect(fs.readdirSync(path.join(dataDir, 'mail'))).toEqual([]);
  expect((await tmx('a', ['who'])).code).toBe(3);
}, 60000);

test('two box records for one machine (two ssh names, one master): the first holds the socket, the second is refused naming it', async () => {
  const { h, fwd, sync, tmx, masterPid, boxSock, dataDir } = await harness({}, { second: true });
  await sync();
  expect(fwd.status('b1')).toEqual({ state: 'up', installed: true, listening: 0 });
  expect(fwd.status('b2')).toEqual({ state: 'error', error: 'shares a connection with local', installed: null, listening: 0 });
  // Really one master for both names (the premise), and only the holder has a listener.
  const pid = await masterPid();
  expect(pid).toMatch(/^\d+$/);
  expect(fs.readdirSync(path.join(dataDir, 'mail'))).toHaveLength(1);

  // A box-side request through the socket is the first box's: a thread started by tmx is b1's.
  const send = async (text) => {
    const sent = await tmx('a', ['send', './b', text]);
    expect(sent.stderr).toBe('');
    expect(sent.code).toBe(0);
    return h.store.thread(/Thread (t-[a-z2-9]{8})\./.exec(sent.stdout)[1]);
  };
  expect((await send('first')).starter).toEqual({ boxId: 'b1', session: 'a' });

  // Three more syncs: still the first box's, still working, the second still refused.
  for (let i = 0; i < 3; i++) await sync();
  expect(fwd.status('b1').state).toBe('up');
  expect(fwd.status('b2')).toMatchObject({ state: 'error', error: 'shares a connection with local' });
  expect(fs.lstatSync(boxSock).isSocket()).toBe(true);
  expect((await send('still there')).starter).toEqual({ boxId: 'b1', session: 'a' });
}, 90000);

test('a restart over the live master whose holder is now second in the list: the first claims, cancels the stale entry, and its socket works', async () => {
  const { h, box, box2, snapshot, fwd, forwards, makeForward, tmx, masterPid } = await harness({}, { second: true });
  // The previous process: the second record held the master.
  await fwd.sync([box2, box], snapshot);
  expect(fwd.status('b2').state).toBe('up');
  expect(fwd.status('b1')).toMatchObject({ state: 'error', error: 'shares a connection with local-again' });
  const pid = await masterPid();
  await fwd.stopAll(); // a restart: listeners closed, the master and its forward entry live on

  const fwd2 = makeForward();
  forwards.push(fwd2);
  await fwd2.sync([box, box2], snapshot);
  expect(await masterPid()).toBe(pid);
  expect(fwd2.status('b1')).toEqual({ state: 'up', installed: true, listening: 0 });
  expect(fwd2.status('b2')).toMatchObject({ state: 'error', error: 'shares a connection with local' });
  const sent = await tmx('a', ['send', './b', 'after the restart']);
  expect(sent.code).toBe(0);
  expect(h.store.thread(/Thread (t-[a-z2-9]{8})\./.exec(sent.stdout)[1]).starter).toEqual({ boxId: 'b1', session: 'a' });
}, 90000);
