import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentMailListener } from '../src/server/agentMailListener.js';
import { refusalText } from '../src/server/agentMailText.js';
import { createMailHarness, B, mark } from './helpers/agentMailHarness.js';

// The box-side `tmx` script (src/server/assets/tmuxifier-mail.sh) run by a real shell against
// the real listener and hub. The listener is box `o` (`orders`), so the script speaks as
// orders/main. On PATH: a fake `tmux` that answers only the exact session lookup the script
// must make, and a `curl` shim that logs its argv (one line per call) and execs the real curl,
// so a test can count requests and prove a message body never reaches curl's argv.
//
// TMX_TEST_SHELL picks the shell (default /bin/sh), e.g. TMX_TEST_SHELL='bash --posix' or
// TMX_TEST_SHELL='busybox sh'.

const SCRIPT = fileURLToPath(new URL('../src/server/assets/tmuxifier-mail.sh', import.meta.url));
const which = (tool) => execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', tool]).toString().trim();
// Resolved now: some tests run the script with a PATH that holds neither the shell nor curl.
const SHELL = (process.env.TMX_TEST_SHELL || '/bin/sh').split(' ').map((a, i) => (i === 0 ? which(a) : a));
const TRACE = fileURLToPath(new URL('./fixtures/claude-hook-trace.jsonl', import.meta.url));
const REAL_CURL = which('curl');
const UNREACHABLE = 'tmx: mail service unreachable, try again shortly\n';
const TAG_RE = /^\[tmuxifier-mail m-[a-z2-9]{8}\] /;

let h; let dir; let bin; let sock; let curlLog; let listener; let extra; let children;

function writeExe(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
}

beforeEach(async () => {
  h = await createMailHarness({ holdMs: 60_000 });
  // b may write to o as well, so a hook-wait on o/main can be sent mail.
  await h.setPolicy('o', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] });
  await h.setPolicy('b', { send: true, sendTo: ['o'], receive: true, receiveFrom: ['o'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmx-t-'));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  sock = path.join(dir, 's', 'sock');
  curlLog = path.join(dir, 'curl.log');
  writeExe(path.join(bin, 'tmux'), [
    '#!/bin/sh',
    // Only the exact lookup the brief names; anything else fails, as tmux outside a pane would.
    "[ \"$#\" = 5 ] && [ \"$1\" = display-message ] && [ \"$2\" = -p ] && [ \"$3\" = -t ] && [ \"$4\" = '%3' ] && [ \"$5\" = '#{session_name}' ] || exit 1",
    "printf '%s\\n' main",
    '',
  ].join('\n'));
  writeExe(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${curlLog}'\nexec '${REAL_CURL}' "$@"\n`);
  listener = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock });
  extra = [];
  children = [];
});

afterEach(async () => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  await Promise.all(children.map((c) => c.done));
  for (const l of [listener, ...extra]) await l.close();
  await h.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

function env(over = {}) {
  const e = {
    HOME: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX: '/tmp/tmux-0/default,1,0',
    TMUX_PANE: '%3',
    TMUXIFIER_MAIL_SOCK: sock,
    TMUXIFIER_MAIL_TEST_SLEEP: '0.05',
    ...over,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

// Starts the script; `done` resolves with { code, signal, stdout, stderr, ms }. Each child leads
// its own process group, so a test (and afterEach) can kill it together with its curl.
function start(args, { env: e = env(), stdin = '' } = {}) {
  const t0 = Date.now();
  const child = spawn(SHELL[0], [...SHELL.slice(1), SCRIPT, ...args], { env: e, detached: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => {}); // a path that never reads stdin
  child.stdin.end(stdin);
  child.done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: null, signal: null, stdout, stderr: `spawn failed: ${e.message}`, ms: 0 }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - t0 }));
  });
  children.push(child);
  return child;
}
const run = (args, opts) => start(args, opts).done;

const curlCalls = () => (fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean) : []);
const running = (child) => child.exitCode === null && child.signalCode === null;
const lockOf = () => path.join(dir, '.tmuxifier-mail', 'wait.3.lock');
const lockPid = () => { try { return fs.readFileSync(path.join(lockOf(), 'pid'), 'utf8').trim(); } catch { return null; } };

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threadOf = (stdout) => /Thread (t-[a-z2-9]{8})\./.exec(stdout)[1];
const listening = () => h.hub.listening('o').main ?? 0;

// A real recorded UserPromptSubmit payload with `prompt` set the way spike 1 recorded a wake.
function wakePayload(wake) {
  const line = fs.readFileSync(TRACE, 'utf8').split('\n').find((l) => l.includes('"hook_event_name":"UserPromptSubmit"'));
  const payload = JSON.parse(line);
  payload.prompt = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${wake}\n</system-reminder>`;
  return JSON.stringify(payload);
}

describe('tmx: user commands', () => {
  test('send prints the thread id and exits 0', async () => {
    await listener.listen();
    const r = await run(['send', 'billing', 'hello there']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Sent\. Thread t-[a-z2-9]{8}\./);
    expect(r.stderr).toBe('');
    const t = h.store.thread(threadOf(r.stdout));
    expect(t.starter).toEqual({ boxId: 'o', session: 'main' });
    expect(t.peer).toEqual({ boxId: 'b', session: 'main' });
    expect(t.messages[0].body).toBe('hello there');
    // The body went to curl on stdin, never as an argument.
    const calls = curlCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('hello there');
    expect(calls[0]).toContain('body@-');
  });

  test('send reads the body from stdin when no text argument is given, including quotes, $(…) and newlines verbatim', async () => {
    await listener.listen();
    const pwned = path.join(dir, 'pwned');
    const body = `He said "hi" and 'bye' \\ back\nrun $(touch ${pwned}) and \`touch ${pwned}\` now\n$HOME * ? [x] %41 a+b c&d=e #f\n\tlast line`;
    const r = await run(['send', 'billing'], { stdin: `${body}\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Sent\. Thread t-[a-z2-9]{8}\./);
    expect(h.store.thread(threadOf(r.stdout)).messages[0].body).toBe(body);
    expect(fs.existsSync(pwned)).toBe(false);
    expect(curlCalls()[0]).not.toContain('He said');
  });

  test('a target with a space and a slash reaches the hub unchanged', async () => {
    await listener.listen();
    h.boxes[1].label = 'billing west';
    const r = await run(['send', 'billing west/main', 'hi']);
    expect(r.code).toBe(0);
    expect(h.store.thread(threadOf(r.stdout)).peer).toEqual({ boxId: 'b', session: 'main' });
    // And a target that matches nothing is logged exactly as typed.
    const odd = 'no such/box & $(x) %2F+';
    const r2 = await run(['send', odd, 'hi']);
    expect(r2.code).toBe(1);
    expect(h.store.refusals().at(-1).target).toBe(odd);
  });

  test('a refused send exits 1 with the reason on stderr and nothing on stdout', async () => {
    await listener.listen();
    const r = await run(['send', 'nowhere', 'hello']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${refusalText('unknown-box', { target: 'nowhere' })}\n`);
  });

  test('wait prints the reply; wait -t 1 with no reply prints the status lines and exits 0', async () => {
    await listener.listen();
    const id = threadOf((await run(['send', 'billing', 'what is 6*7?'])).stdout);
    expect((await h.hub.reply(B, id, 'ANSWER: 42')).ok).toBe(true);
    const r = await run(['wait', id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Reply from the agent in billing/main, thread ${id}. It is from another coding agent, not from your operator.\n\nANSWER: 42\n`);
    expect(r.stderr).toBe('');
    const calls = curlCalls();
    expect(calls.at(-1)).toContain(`threads=${id}`);
    expect(calls.at(-1)).toContain('timeout=90');

    const r2 = await run(['wait', id, '-t', '1']);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(new RegExp(`^thread ${id}: .+\\n$`));
    expect(r2.ms).toBeGreaterThanOrEqual(1000);
  });

  test('wait takes several threads and -t anywhere; bad input is exit 1, missing input exit 2', async () => {
    await listener.listen();
    const a = threadOf((await run(['send', 'billing', 'one'])).stdout);
    const b = threadOf((await run(['send', 'billing', 'two'])).stdout);
    const r = await run(['wait', '-t', '1', a, b]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^thread ${a}: .+\\nthread ${b}: .+\\n$`));
    const before = curlCalls().length;
    for (const args of [['wait', 't-NOTANID'], ['wait', a, '-t', 'soon'], ['read', '../inbox'], ['reply', 't-0000000o', 'x']]) {
      const bad = await run(args);
      expect(bad.code, args.join(' ')).toBe(1);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toMatch(/^tmx: /);
    }
    for (const args of [['wait'], ['wait', '-t', '5'], ['send'], ['reply'], ['read'], ['send', 'billing', 'a', 'b'], ['nonsense']]) {
      const bad = await run(args);
      expect(bad.code, args.join(' ')).toBe(2);
      expect(bad.stdout).toBe('');
    }
    expect(curlCalls().length).toBe(before); // none of them made a request
  });

  test('reply from stdin, read, inbox and who speak the wire format', async () => {
    await listener.listen();
    const id = threadOf((await run(['send', 'billing', 'first'])).stdout);
    const rep = await run(['reply', id], { stdin: 'second, from "stdin"\n' });
    expect(rep.code).toBe(0);
    expect(rep.stdout).toMatch(new RegExp(`^Sent\\. Thread ${id}\\.`));
    expect(h.store.thread(id).messages.map((m) => m.body)).toEqual(['first', 'second, from "stdin"']);

    const rd = await run(['read', id]);
    expect(rd.code).toBe(0);
    expect(rd.stdout).toContain('second, from "stdin"');

    await h.hub.reply(B, id, 'from billing');
    const ib = await run(['inbox']);
    expect(ib.code).toBe(0);
    expect(ib.stdout).toContain(`thread ${id}`);
    expect(ib.stdout).toContain('from billing');
    expect((await run(['inbox'])).stdout).toBe('inbox empty\n');

    h.boxes.push({ id: 'x', label: 'Spare Box', sessionName: 'main' });
    h.marks.x = { main: mark('ready') };
    await h.setPolicy('o', { send: true, sendTo: ['b', 'x'], receive: true, receiveFrom: ['b'] });
    await h.setPolicy('x', { receive: true, receiveFrom: ['o'] });
    const who = await run(['who']);
    expect(who.code).toBe(0);
    expect(who.stdout).toBe('billing/main  working, not listening\nSpare Box/main  idle, not listening\n');
    const one = await run(['who', 'spare box']); // the box name matched without regard to case
    expect(one.code).toBe(0);
    expect(one.stdout).toBe('Spare Box/main  idle, not listening\n');
    const none = await run(['who', 'billing west']);
    expect(none.code).toBe(0);
    expect(none.stdout).toMatch(/^nobody: /);
  });

  test('help, no argument and an unknown command print the usage to stderr and exit 2', async () => {
    for (const args of [[], ['help']]) {
      const r = await run(args, { env: env({ TMUX: undefined, TMUX_PANE: undefined }) });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      const lines = r.stderr.split('\n').filter((l) => /^\s*tmx \S/.test(l));
      expect(lines.map((l) => l.trim().split(/\s+/)[1])).toEqual(['who', 'send', 'reply', 'wait', 'read', 'inbox']);
    }
    expect(curlCalls()).toEqual([]);
  });

  test('outside tmux a user command exits 2 with the hint', async () => {
    await listener.listen();
    for (const over of [{ TMUX: undefined, TMUX_PANE: undefined }, { TMUX_PANE: undefined }, { TMUX_PANE: '%3; rm -rf /' }, { TMUX_PANE: '%4' }]) {
      const r = await run(['send', 'billing', 'hi'], { env: env(over) });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('tmx: run this inside a tmux session\n');
    }
    expect(curlCalls()).toEqual([]);
  });

  test('socket missing: exits 3 after retries', async () => {
    const r = await run(['send', 'billing', 'hi'], { env: env({ TMUXIFIER_MAIL_SOCK: path.join(dir, 'nothing-here') }) });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(UNREACHABLE);
    expect(curlCalls()).toHaveLength(5);
  });

  test('a listener that stays busy (503) is unreachable too; one that comes back in time is used', async () => {
    const busy = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock, maxOpen: 0 });
    extra.push(busy);
    await busy.listen();
    const r = await run(['inbox']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe(UNREACHABLE);
    expect(curlCalls()).toHaveLength(5);
    await busy.close();

    // Down at first, up before the attempts run out.
    fs.rmSync(curlLog);
    const child = start(['send', 'billing', 'late but fine'], { env: env({ TMUXIFIER_MAIL_TEST_SLEEP: '0.3' }) });
    await until(() => curlCalls().length >= 1);
    await listener.listen();
    const r2 = await child.done;
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/^Sent\. Thread t-/);
    expect(curlCalls().length).toBeGreaterThan(1);
  });
});

describe('tmx: hook-wait', () => {
  test('hook-wait exits 2 with the tagged text on stderr when mail is handed', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    expect(lockPid()).toBe(String(w.pid));
    expect((await h.hub.send(B, 'orders', 'ping from billing')).ok).toBe(true);
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(TAG_RE);
    expect(r.stderr).toContain('Message from the agent in billing/main');
    expect(r.stderr.endsWith('\n\nping from billing\n')).toBe(true);
    expect(curlCalls().at(-1)).toContain('pane=%3');
    expect(fs.existsSync(lockOf())).toBe(false); // lock removed, nothing left behind
    expect(fs.readdirSync(path.join(dir, '.tmuxifier-mail'))).toEqual([]);
  });

  test('hook-wait keeps retrying while the listener is down and delivers once it is back', async () => {
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => curlCalls().length >= 3); // asked, failed, backed off, asked again...
    expect(running(w)).toBe(true);
    expect((await h.hub.send(B, 'orders', 'queued while down')).ok).toBe(true);
    await sleep(100);
    expect(running(w)).toBe(true);
    await listener.listen();
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(TAG_RE);
    expect(r.stderr).toContain('queued while down');
  });

  test('hook-wait survives the listener closing and a new one opening on the same path', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    await listener.close(); // its held wait is answered 204; the next asks find no socket
    await until(() => curlCalls().length >= 3);
    expect(running(w)).toBe(true);
    const again = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock });
    extra.push(again);
    await again.listen();
    await until(() => listening() === 1);
    await h.hub.send(B, 'orders', 'after the restart');
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('after the restart');
  });

  test('a second hook-wait for the same pane exits 0 at once; after the first dies its lock is taken over', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const first = start(['hook-wait']);
    await until(() => listening() === 1);
    const second = await run(['hook-wait']);
    expect(second).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(running(first)).toBe(true);
    expect(lockPid()).toBe(String(first.pid));
    expect(listening()).toBe(1);

    process.kill(-first.pid, 'SIGKILL'); // no trap runs: the lock stays behind with a dead pid
    await first.done;
    await until(() => listening() === 0);
    expect(lockPid()).toBe(String(first.pid));

    const third = start(['hook-wait']);
    await until(() => listening() === 1);
    expect(lockPid()).toBe(String(third.pid));
    await h.hub.send(B, 'orders', 'for the new waiter');
    const r = await third.done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('for the new waiter');
  });

  test('a lock held by a live process that is not a waiter, or with no pid, is taken over', async () => {
    await listener.listen();
    const other = spawn('sleep', ['30'], { detached: true });
    other.done = new Promise((r) => other.on('close', r));
    children.push(other);
    fs.mkdirSync(lockOf(), { recursive: true });
    fs.writeFileSync(path.join(lockOf(), 'pid'), `${other.pid}\n`);
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    expect(lockPid()).toBe(String(w.pid));
    expect(running(other)).toBe(true); // never signalled
    process.kill(-w.pid, 'SIGKILL');
    await w.done;
    await until(() => listening() === 0);

    fs.rmSync(lockOf(), { recursive: true });
    fs.mkdirSync(lockOf()); // a lock directory whose owner never wrote its pid
    const w2 = start(['hook-wait']);
    await until(() => listening() === 1);
    expect(lockPid()).toBe(String(w2.pid));
  });

  test('a waiter whose lock was taken over stands down at its next turn and leaves the lock alone', async () => {
    await listener.listen();
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    fs.writeFileSync(path.join(lockOf(), 'pid'), '999999\n'); // another waiter thought it dead
    await listener.close(); // the held wait is answered 204, so the loop turns
    const r = await w.done;
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(lockPid()).toBe('999999');
  });

  test('hook-wait exits promptly on SIGTERM, ends its request and removes its lock', async () => {
    await listener.listen();
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    const t0 = Date.now();
    process.kill(w.pid, 'SIGTERM'); // the shell only, as a parent would: its curl must go too
    const r = await w.done;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(fs.existsSync(lockOf())).toBe(false);
    await until(() => listening() === 0);
  });

  test('hook-wait outside tmux exits 0 silently', async () => {
    await listener.listen();
    for (const over of [{ TMUX: undefined, TMUX_PANE: undefined }, { TMUX_PANE: '%x' }, { TMUX_PANE: '%4' }]) {
      const r = await run(['hook-wait'], { env: env(over) });
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(curlCalls()).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.tmuxifier-mail'))).toBe(false);
  });
});

describe('tmx: hook-ack', () => {
  test('hook-ack confirms the tagged id from a real UserPromptSubmit payload and prints nothing', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    const sent = await h.hub.send(B, 'orders', 'confirm me');
    const wake = (await w.done).stderr;
    const msg = () => h.store.thread(sent.threadId).messages[0];
    expect(msg().state).toBe('handed');
    const id = /^\[tmuxifier-mail (m-[a-z2-9]{8})\]/.exec(wake)[1];

    const before = curlCalls().length;
    const r = await run(['hook-ack'], { stdin: wakePayload(wake) });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(msg().state).toBe('delivered');
    const acks = curlCalls().slice(before);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toContain(`m=${id}`);

    // The same tag twice is one request; a second confirmation (now a 404) is still silent.
    const twice = wakePayload(`${wake}\nquoted again: [tmuxifier-mail ${id}]`);
    const r2 = await run(['hook-ack'], { stdin: twice });
    expect(r2).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(curlCalls().length - before).toBe(2);
  });

  test('hook-ack on an ordinary prompt makes no request and exits 0', async () => {
    await listener.listen();
    const line = fs.readFileSync(TRACE, 'utf8').split('\n').find((l) => l.includes('"hook_event_name":"UserPromptSubmit"'));
    for (const stdin of [line, '', '[tmuxifier-mail m-short]', 'mentions [tmuxifier-mail without an id']) {
      const r = await run(['hook-ack'], { stdin });
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(curlCalls()).toEqual([]);
  });

  test('hook-ack exits 0 with no output when the socket is unreachable', async () => {
    const wake = '[tmuxifier-mail m-abcdefgh] Message from the agent in billing/main, thread t-abcdefgh.';
    const r = await run(['hook-ack'], { stdin: wakePayload(wake), env: env({ TMUXIFIER_MAIL_SOCK: path.join(dir, 'nothing-here') }) });
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(curlCalls()).toHaveLength(1);

    // No curl at all, and outside tmux: still silent and 0.
    const bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    fs.copyFileSync(path.join(bin, 'tmux'), path.join(bare, 'tmux'));
    fs.chmodSync(path.join(bare, 'tmux'), 0o755);
    for (const tool of ['cat', 'grep', 'sed', 'sort', 'sleep', 'mkdir', 'rm', 'rmdir']) {
      fs.symlinkSync(which(tool), path.join(bare, tool));
    }
    const r2 = await run(['hook-ack'], { stdin: wakePayload(wake), env: env({ PATH: bare }) });
    expect(r2).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const r3 = await run(['hook-ack'], { stdin: wakePayload(wake), env: env({ TMUX: undefined, TMUX_PANE: undefined }) });
    expect(r3).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(curlCalls()).toHaveLength(1);

    // A curl that talks on both streams and fails: none of it gets through.
    const noisy = path.join(dir, 'noisy');
    fs.mkdirSync(noisy);
    writeExe(path.join(noisy, 'curl'), "#!/bin/sh\necho 'curl: (7) out' ; echo 'curl: (7) err' >&2\nexit 7\n");
    const r4 = await run(['hook-ack'], { stdin: wakePayload(wake), env: env({ PATH: `${noisy}:${bin}:/usr/bin:/bin` }) });
    expect(r4).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
