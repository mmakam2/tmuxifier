import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentMailListener } from '../src/server/agentMailListener.js';
import { refusalText } from '../src/server/agentMailText.js';
import { createMailHarness, O, B, mark } from './helpers/agentMailHarness.js';

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
const LOST = (check) => `tmx: the connection was lost before an answer came back, so the message may or may not have been sent; do not send it again without checking (${check})\n`;

let h; let dir; let bin; let sock; let curlLog; let listener; let extra; let children; let hookGroups;

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
  hookGroups = [];
});

afterEach(async () => {
  // The hook wrappers a fake Claude Code started lead their own sessions: kill those groups too.
  for (const g of hookGroups) {
    for (const f of fs.existsSync(g.dir) ? fs.readdirSync(g.dir).filter((n) => n.endsWith('.pid')) : []) {
      try { process.kill(-Number(fs.readFileSync(path.join(g.dir, f), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
  }
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

// A stand-in for Claude Code that runs hooks the way the real one does (recorded live, Claude
// Code 2.1.325): each hook command through `/bin/sh -c` in a new session (so a dash `-c`
// wrapper sits between it and the waiter and outlives Claude Code when Claude Code is
// killed), stdin and stderr piped. It starts one `hook-wait` at once and one more per line
// written to its stdin, records hook n's wrapper pid in <dir>/<n>.pid and, if it is still
// alive itself, the hook's exit as <dir>/<n>.json ({ code, signal, err }). It never exits on
// its own: a test kills it. The hook command comes in the environment, not in its argv, so its
// own command line does not name hook-wait (Claude Code's does not). A line `n` instead starts
// a nested Claude Code as its child (as a `claude -p` run from the Bash tool would be), which
// starts its own hook-wait and records under <dir>/n/ the same way.
const FAKE_CLAUDE = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [out] = process.argv.slice(1);
const cmd = process.env.FAKE_HOOK_CMD;
let n = 0;
const hook = () => {
  const i = ++n;
  const c = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
  c.stdin.end();
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  fs.writeFileSync(out + '/' + i + '.pid', String(c.pid));
  c.on('close', (code, signal) => fs.writeFileSync(out + '/' + i + '.json', JSON.stringify({ code, signal, err })));
};
hook();
process.stdin.on('data', (d) => {
  for (const ch of String(d)) {
    if (ch === '\\n') hook();
    if (ch === 'n') {
      fs.mkdirSync(out + '/n');
      spawn(process.execPath, ['-e', process.env.FAKE_CLAUDE_SRC, out + '/n'], { stdio: ['pipe', 'ignore', 'inherit'] });
    }
  }
});
`;

// execs: the hook command starts with `exec`, as a `sh -c` that execs its command (bash -c
// does) runs it, so the waiter's own parent is Claude Code.
function underClaude({ env: e = env(), execs = false } = {}) {
  const out = fs.mkdtempSync(path.join(dir, 'claude-'));
  const cmd = `${execs ? 'exec ' : ''}${SHELL.map((a) => `'${a}'`).join(' ')} '${SCRIPT}' hook-wait`;
  const claude = spawn(process.execPath, ['-e', FAKE_CLAUDE, out], { env: { ...e, FAKE_HOOK_CMD: cmd, FAKE_CLAUDE_SRC: FAKE_CLAUDE }, detached: true, stdio: ['pipe', 'ignore', 'inherit'] });
  claude.done = new Promise((resolve) => claude.on('close', resolve));
  children.push(claude);
  hookGroups.push({ dir: out }, { dir: path.join(out, 'n') });
  const resultIn = (d) => (i = 1) => { try { return JSON.parse(fs.readFileSync(path.join(d, `${i}.json`), 'utf8')); } catch { return null; } };
  return {
    claude,
    spawnHook: () => claude.stdin.write('\n'),
    spawnNested: () => claude.stdin.write('n'),
    result: resultIn(out),
    nestedResult: resultIn(path.join(out, 'n')),
  };
}
const lockClaude = () => { try { return fs.readFileSync(path.join(lockOf(), 'claude'), 'utf8').trim(); } catch { return null; } };
const isAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

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

// The listener in front of a hub whose `name` call runs for real and then never answers: the
// listener is closed under it (so the connection drops after the request went out) and a fresh,
// ordinary listener opens on the same path at once, so a retry would go through.
function dropAfter(name) {
  const wrapped = { ...h.hub };
  let dropped = false;
  wrapped[name] = async (...args) => {
    const out = await h.hub[name](...args);
    if (dropped) return out;
    dropped = true;
    const gone = listener;
    void (async () => {
      await gone.close();
      const again = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock });
      extra.push(again);
      await again.listen();
    })();
    return new Promise(() => {});
  };
  listener = createAgentMailListener({ hub: wrapped, boxId: 'o', socketPath: sock });
}

describe('tmx: a connection lost after the request went out', () => {
  test('a send is not retried: exit 3 with the warning, and exactly one thread exists', async () => {
    dropAfter('send');
    await listener.listen();
    const r = await run(['send', 'billing', 'only once']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(LOST('ask the operator, or look for an answer with "tmx inbox"'));
    expect(h.store.threads()).toHaveLength(1);
    expect(h.store.threads()[0].messages.map((m) => m.body)).toEqual(['only once']);
    expect(curlCalls()).toHaveLength(1);
    await until(() => extra.length === 1);
    expect((await run(['inbox'])).code).toBe(0); // the reopened listener was there for a retry
    expect(h.store.threads()).toHaveLength(1);
  });

  test('a reply is not retried: exit 3 with the warning, and the thread holds it once', async () => {
    const s = await h.hub.send(O, 'billing', 'question');
    dropAfter('reply');
    await listener.listen();
    const r = await run(['reply', s.threadId, 'answer once']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(LOST(`run "tmx read ${s.threadId}"`));
    expect(h.store.thread(s.threadId).messages.map((m) => m.body)).toEqual(['question', 'answer once']);
    expect(curlCalls()).toHaveLength(1);
  });

  test('a send or reply that times out after connecting is not called retryable: exit 3 with the warning, sent once', async () => {
    // The hub takes the request and the answer never comes, as through a stalled ssh forward.
    const wrapped = { ...h.hub };
    for (const name of ['send', 'reply']) {
      wrapped[name] = async (...args) => { await h.hub[name](...args); return new Promise(() => {}); };
    }
    listener = createAgentMailListener({ hub: wrapped, boxId: 'o', socketPath: sock });
    await listener.listen();
    const fast = env({ TMUXIFIER_MAIL_TEST_MAX_TIME: '0.5' });
    const r = await run(['send', 'billing', 'only once'], { env: fast });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(LOST('ask the operator, or look for an answer with "tmx inbox"'));
    expect(h.store.threads()).toHaveLength(1);
    const id = h.store.threads()[0].id;
    const r2 = await run(['reply', id, 'answer once'], { env: fast });
    expect(r2.code).toBe(3);
    expect(r2.stderr).toBe(LOST(`run "tmx read ${id}"`));
    expect(h.store.thread(id).messages.map((m) => m.body)).toEqual(['only once', 'answer once']);
    expect(curlCalls()).toHaveLength(2);
  });

  test('a read is retried and answered by the listener that came back', async () => {
    dropAfter('inbox');
    await listener.listen();
    const r = await run(['inbox']);
    expect(r).toMatchObject({ code: 0, stdout: 'inbox empty\n', stderr: '' });
    expect(curlCalls().length).toBeGreaterThanOrEqual(2);
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

  test('stray shell diagnostics never reach the wake text', async () => {
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => fs.existsSync(path.join(lockOf(), 'pid')) && curlCalls().length >= 2);
    // A directory where the waiter writes its status code: each turn's redirect now fails, and
    // the shell says so on stderr, as would any failed redirect or sleep in the lock directory.
    const calls = curlCalls().length;
    await until(() => {
      try {
        fs.rmSync(path.join(lockOf(), 'code'), { force: true }); // the waiter rewrites it each turn
        fs.mkdirSync(path.join(lockOf(), 'code'));
        return true;
      } catch { return false; }
    });
    await sleep(300);
    expect(curlCalls().length).toBeLessThanOrEqual(calls + 1); // the failing turns never ran curl
    fs.rmdirSync(path.join(lockOf(), 'code'));
    await listener.listen();
    await h.hub.send(B, 'orders', 'clean wake');
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(TAG_RE);
    expect(r.stderr.endsWith('\n\nclean wake\n')).toBe(true);
    expect(r.stderr.split('[tmuxifier-mail ')).toHaveLength(2);
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

  test('a waiter whose lock was taken over by a live waiter stands down at its next turn and leaves the lock alone', async () => {
    await listener.listen();
    const w = start(['hook-wait']);
    await until(() => listening() === 1);
    // A live process that reads as a waiter (its command line names hook-wait) took the lock.
    const other = spawn('/bin/sh', ['-c', 'sleep 30', 'hook-wait'], { detached: true });
    other.done = new Promise((r) => other.on('close', r));
    children.push(other);
    fs.writeFileSync(path.join(lockOf(), 'pid'), `${other.pid}\n`);
    await listener.close(); // the held wait is answered 204, so the loop turns
    const r = await w.done;
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(lockPid()).toBe(String(other.pid));
    expect(running(other)).toBe(true);
  });

  test('a waiter whose lock names a dead waiter, or has lost its pid, reclaims it at its next turn', async () => {
    const hub = h.makeHub({ holdMs: 200 });
    const short = createAgentMailListener({ hub, boxId: 'o', socketPath: sock });
    extra.push(short);
    await short.listen();
    h.marks.o.main = mark('ready');
    const w = start(['hook-wait']);
    await until(() => lockPid() === String(w.pid));
    fs.writeFileSync(path.join(lockOf(), 'pid'), '999999\n');
    await until(() => lockPid() === String(w.pid));
    fs.rmSync(path.join(lockOf(), 'pid'));
    await until(() => lockPid() === String(w.pid));
    expect(running(w)).toBe(true);
    await until(() => (hub.listening('o').main ?? 0) === 1);
    await hub.send(B, 'orders', 'still here');
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stderr.endsWith('\n\nstill here\n')).toBe(true);
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

describe('tmx: hook-wait follows its Claude Code', () => {
  test('a waiter whose Claude Code is killed exits by itself at its next turn and frees the lock', async () => {
    const hub = h.makeHub({ holdMs: 300 });
    const short = createAgentMailListener({ hub, boxId: 'o', socketPath: sock });
    extra.push(short);
    await short.listen();
    const a = underClaude();
    await until(() => lockPid() !== null && lockClaude() !== null);
    expect(lockClaude()).toBe(String(a.claude.pid)); // Claude Code, not the sh -c wrapper
    const waiter = lockPid();
    const turns = curlCalls().length;
    await until(() => curlCalls().length >= turns + 3); // several holds answered 204: still the same waiter
    expect(lockPid()).toBe(waiter);
    expect(isAlive(waiter)).toBe(true);

    a.claude.kill('SIGKILL'); // the waiter and its wrapper get no signal
    await a.claude.done;
    await until(() => !isAlive(waiter) && !fs.existsSync(lockOf()), 3000);
    expect(fs.readdirSync(path.join(dir, '.tmuxifier-mail'))).toEqual([]);
    expect(hub.listening('o').main ?? 0).toBe(0);
  });

  test('when the hook shell execs the command, the waiter follows its own parent', async () => {
    const hub = h.makeHub({ holdMs: 300 });
    const short = createAgentMailListener({ hub, boxId: 'o', socketPath: sock });
    extra.push(short);
    await short.listen();
    const a = underClaude({ execs: true });
    await until(() => lockPid() !== null && lockClaude() !== null);
    expect(lockClaude()).toBe(String(a.claude.pid));
    const waiter = lockPid();
    a.claude.kill('SIGKILL');
    await a.claude.done;
    await until(() => !isAlive(waiter) && !fs.existsSync(lockOf()), 3000);
  });

  test('a waiter under a new Claude Code takes the lock from a live one; the old one stands down; mail goes to the new', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const a = underClaude();
    await until(() => listening() === 1 && lockClaude() === String(a.claude.pid));
    const first = lockPid();
    const b = underClaude();
    await until(() => lockClaude() === String(b.claude.pid));
    expect(lockPid()).not.toBe(first);
    await until(() => a.result() !== null);
    expect(a.result()).toEqual({ code: 0, signal: null, err: '' }); // stood down, lock untouched
    expect(lockClaude()).toBe(String(b.claude.pid));
    await until(() => listening() === 1);
    expect((await h.hub.send(B, 'orders', 'for the new session')).ok).toBe(true);
    await until(() => b.result() !== null);
    expect(b.result().code).toBe(2);
    expect(b.result().err).toMatch(TAG_RE);
    expect(b.result().err.endsWith('\n\nfor the new session\n')).toBe(true);
    expect(fs.existsSync(lockOf())).toBe(false);
  });

  test('a waiter of a Claude Code nested under the owner\'s stands down and leaves the owner alone', async () => {
    await listener.listen();
    h.marks.o.main = mark('ready');
    const a = underClaude();
    await until(() => listening() === 1 && lockClaude() === String(a.claude.pid));
    const first = lockPid();
    a.spawnNested();
    await until(() => a.nestedResult() !== null);
    expect(a.nestedResult()).toEqual({ code: 0, signal: null, err: '' });
    expect(lockPid()).toBe(first);
    expect(lockClaude()).toBe(String(a.claude.pid));
    expect(a.result()).toBe(null);
    expect(listening()).toBe(1);
    // Mail for the pane still wakes the outer Claude Code.
    expect((await h.hub.send(B, 'orders', 'for the outer session')).ok).toBe(true);
    await until(() => a.result() !== null);
    expect(a.result().code).toBe(2);
    expect(a.result().err.endsWith('\n\nfor the outer session\n')).toBe(true);
  });

  test('a waiter exiting while its successor sits between mkdir and its pid write leaves the successor\'s lock alone', async () => {
    await listener.listen();
    const a = underClaude();
    await until(() => listening() === 1 && lockClaude() === String(a.claude.pid));
    const first = lockPid();
    // The successor, under another Claude Code, pauses right after its mkdir.
    const b = underClaude({ env: env({ TMUXIFIER_MAIL_TEST_CLAIM_PAUSE: '1' }) });
    await until(() => fs.existsSync(lockOf()) && lockPid() === null);
    process.kill(Number(first), 'SIGTERM'); // the old owner exits through its cleanup now
    await until(() => !isAlive(first));
    expect(fs.existsSync(lockOf())).toBe(true);
    await until(() => lockPid() !== null && lockPid() !== first);
    expect(lockClaude()).toBe(String(b.claude.pid));
    await until(() => listening() === 1);
    expect(b.result()).toBe(null);
  });

  test('a successor whose new directory a dying predecessor\'s cleanup deletes reclaims it; one waiter remains and a wake reaches it', async () => {
    const hub = h.makeHub({ holdMs: 1000 });
    const short = createAgentMailListener({ hub, boxId: 'o', socketPath: sock });
    extra.push(short);
    await short.listen();
    h.marks.o.main = mark('ready');
    // A's cleanup pauses between its "the lock names me" check and its delete.
    const a = underClaude({ env: env({ TMUXIFIER_MAIL_TEST_CLEANUP_PAUSE: '2' }) });
    await until(() => lockPid() !== null && lockClaude() === String(a.claude.pid));
    const first = lockPid();
    process.kill(Number(first), 'SIGTERM'); // A's cleanup checks the lock, then pauses
    await sleep(300);
    expect(isAlive(first)).toBe(true);
    // B, under another Claude Code, takes the lock over while A is paused.
    const b = underClaude();
    await until(() => lockClaude() === String(b.claude.pid) && lockPid() !== first);
    const second = lockPid();
    // A wakes up and deletes B's directory.
    await until(() => !fs.existsSync(lockOf()), 3000);
    await until(() => !isAlive(first));
    // B reclaims it at its next lock check.
    await until(() => lockPid() === second && lockClaude() === String(b.claude.pid), 3000);
    await until(() => (hub.listening('o').main ?? 0) === 1);
    expect(b.result()).toBe(null);
    expect(a.result()).toEqual({ code: 143, signal: null, err: '' });
    await hub.send(B, 'orders', 'after the reclaim');
    await until(() => b.result() !== null);
    expect(b.result().code).toBe(2);
    expect(b.result().err.endsWith('\n\nafter the reclaim\n')).toBe(true);
  });

  test('a second waiter of the same Claude Code stands down and leaves the first one alone', async () => {
    await listener.listen();
    const a = underClaude();
    await until(() => listening() === 1 && lockClaude() !== null);
    const first = lockPid();
    a.spawnHook();
    await until(() => a.result(2) !== null);
    expect(a.result(2)).toEqual({ code: 0, signal: null, err: '' });
    expect(lockPid()).toBe(first);
    expect(a.result(1)).toBe(null);
    expect(listening()).toBe(1);
  });

  test('with no readable /proc the waiter has no Claude pid and behaves as before', async () => {
    const hub = h.makeHub({ holdMs: 300 });
    const short = createAgentMailListener({ hub, boxId: 'o', socketPath: sock });
    extra.push(short);
    await short.listen();
    const e = env({ TMUXIFIER_MAIL_TEST_NO_PROC: '1' });
    const a = underClaude({ env: e });
    await until(() => lockPid() !== null);
    expect(lockClaude()).toBe(null);
    const waiter = lockPid();
    a.claude.kill('SIGKILL');
    await a.claude.done;
    const turns = curlCalls().length;
    await until(() => curlCalls().length >= turns + 3); // turns go on: nothing tells it Claude Code is gone
    expect(isAlive(waiter)).toBe(true);
    expect(lockPid()).toBe(waiter);
    // A waiter under another Claude Code finds a live owner and stands down, as before.
    const b = underClaude({ env: e });
    await until(() => b.result() !== null);
    expect(b.result()).toEqual({ code: 0, signal: null, err: '' });
    expect(lockPid()).toBe(waiter);
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
