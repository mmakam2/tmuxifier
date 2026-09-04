# Claude Code Voice Mic Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code's built-in voice mode work on a headless box by linking the operator's browser microphone to the box's default ALSA capture device, behind the pane header's existing 🎤 button.

**Architecture:** The setup job's new `voice-link` phase installs a user-level ALSA config on the box (`default` = plug → file plugin reading a FIFO → null slave) plus the FIFO. A new `/voice-link` WebSocket carries 16 kHz S16 mono frames from the browser to a `voiceLinks.js` manager, which pipes them into a box-side Python writer over the ControlMaster. The 🎤 button classifies the pane at press time through the existing `classifyPaneState`: a Claude pane links, anything else dictates through whisper.cpp as today.

**Tech Stack:** Node 20 ESM + Fastify + `@fastify/websocket` (server), TypeScript + xterm.js + Vite (web), vitest (unit/integration), Playwright (e2e), POSIX sh + python3 on the box, alsa-lib's `plug`/`file`/`null` PCM plugins.

**Spec:** `docs/superpowers/specs/2026-09-04-claude-voice-mic-link-design.md`

## Global Constraints

- ESM everywhere, Node 20+, no new server dependency (`ws` is already a dependency).
- Pipe contract: **16 kHz, S16_LE, mono**; browser frames are **640 bytes = 20 ms**.
- FIFO path on every target: `$HOME/.tmuxifier-voice/mic`, dir mode 700, FIFO mode 600.
- ALSA config marker line, verbatim: `# tmuxifier-voice-link`. Never rewrite a `~/.asoundrc` without it.
- One link per box, newest wins. Close codes: `1008` setting-up/auth, `4001 superseded`, `4002 not-set-up`, `4003 writer-failed`, `4004 stalled`, `1001` going away (shutdown).
- Readiness: `ready` text frame after the writer stays alive **300 ms**. Stall close after **3 s** without a frame. Writer killed **3 s** after stdin ends (its silence tail is 2.5 s). Frame cap **8 KB**, rate cap **64 KB/s**. Client cap **30 min** linked.
- Writer exit code **3** = box not set up. Writer program: python3, `cat` fallback. **No single quote anywhere inside the Python program** (it rides inside a single-quoted shell string).
- No user or box data is ever interpolated into a remote script; `session` goes through `SESSION_NAME_RE`, boxes through `assertBoxSafe` (inside `buildProbeArgv`).
- TDD: failing test first. Tests use real code over fakes at the seams (`run`/`runStdin`/`pipe`, `makeRecorder`, injected `probe`/`openLink`).
- Conventional commits. Public repo: placeholders only (`192.168.1.10`, `example.com`) in anything committed.
- **Never run `npm run build` in `/root/tmuxifier` itself** — the live service serves that checkout's `dist/`. Work in a git worktree (`superpowers:using-git-worktrees`), and never commit a `node_modules` symlink from it. `npm run typecheck` and `npx vitest run <file>` are safe anywhere.
- Remote scripts run under the box's login shell (often zsh): no reliance on word splitting.

## File structure

Server (`src/server/`):
- `sshRun.js` — modify: add `sshPipe(argv, { env, cmd })`, the streaming-stdin primitive.
- `voiceWriter.js` — create: `WRITER_PROGRAM` (Python text), `buildVoiceWriterRemote()`, `WRITER_EXIT_NOT_SET_UP`.
- `voiceLinks.js` — create: `createVoiceLinks({ openSink, … })`, the one-link-per-box manager.
- `claudeVoiceLink.js` — create: `buildVoiceLinkInstallScript()` + `createVoiceLinkPusher({ runStdin })` (twin of `claudeAgentHooks.js`).
- `boxActions.js` — modify: `pipe` dep, `openAudioSink(box)`, `paneKind(box, session)`, `alsa-utils` in the `claude` tool block.
- `localShellActions.js` — modify: `pipe` dep, `openAudioSink()`, `installVoiceLink()`.
- `tmuxInject.js` — modify: export `paneKindVia(runScript, session)` and `paneKindLocal(session)`.
- `setupManager.js` — modify: `pushVoiceLink` dep, `voice-link` phase, `voiceLink` in `summary()`.
- `server.js` — modify: `/voice-link` WebSocket, `POST /api/boxes/:id/pane-kind`, `voiceLink` on `PATCH /api/local-shell`, permissions-policy `microphone=(self)` always.
- `index.js` — modify: wire the pusher, the manager, the not-found prefix, the shutdown hook.

Web (`src/web/`):
- `pcmStream.ts` — create: stateful resampler + framer (`createPcmStream`).
- `voicePress.ts` — create: pure press/verdict/release reducer (`reducePress`).
- `voiceLink.ts` — create: `/voice-link` client (`openVoiceLink`, `voiceLinkUrl`, `closeReason`).
- `voiceRecorder.ts` — modify: `stream(sink)` mode.
- `voiceUi.ts` — modify: controller rebuilt around the reducer; `VoiceHost.session`/`hint`; `blur()`; `refreshHint()`.
- `api.ts` — modify: `paneKind(boxId, session?)`.
- `terminal.ts`, `main.ts` — modify: thread `voiceSession`/`voiceHint`, `refreshHint` on poll.
- `style.css` — modify: `data-state='live'` (desktop + touch-bar restatement).

Tests: `test/sshPipe.test.js`, `test/voiceWriter.test.js`, `test/voiceLinks.test.js`, `test/voiceLinkRoute.test.js`, `test/voiceLink.integration.test.js`, `test/claudeVoiceLink.test.js`, `test/paneKindRoute.test.js`, `test/pcmStream.test.js`, `test/voicePress.test.js`, `test/voiceLinkClient.test.js`, `test/e2e/voiceLink.spec.ts`, plus edits to `test/setupManager.test.js`, `test/localShellActions.test.js`, `test/voiceUi.test.js`, `test/e2e/touchBar.spec.ts`, `test/e2e/global-setup.js`.

Docs: `docs/terminal.md`, `docs/boxes-and-setup.md`, `README.md`, `DESIGN.md`, `CLAUDE.md`, `AGENTS.md`.

---

### Task 1: `sshPipe` — the streaming-stdin ssh primitive

**Files:**
- Modify: `src/server/sshRun.js` (append after `sshStream`, ~line 85)
- Test: `test/sshPipe.test.js` (create)

**Interfaces:**
- Produces: `sshPipe(argv, { env = process.env, cmd = 'ssh' } = {}) → { stdin: Writable, done: Promise<{ code: number, stderr: string }>, kill(): void }`. `done` resolves on child `close`; `kill()` SIGKILLs and `done` then resolves with a non-zero code. `cmd` is test-only injection (`/bin/sh`), exactly as in `sshRunStdin`.

- [ ] **Step 1: Write the failing test**

```js
// test/sshPipe.test.js
import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshPipe } from '../src/server/sshRun.js';

test('sshPipe streams stdin chunks to the child and resolves its exit code on close', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshpipe-'));
  const out = path.join(dir, 'out');
  const h = sshPipe(['-c', 'cat > "$1"; exit 7', 'sh', out], { cmd: '/bin/sh' });
  h.stdin.write(Buffer.from('abc'));
  await new Promise((r) => setTimeout(r, 50));
  h.stdin.write(Buffer.from('def'));
  h.stdin.end();
  const res = await h.done;
  expect(res.code).toBe(7);
  expect(await fs.readFile(out, 'utf8')).toBe('abcdef');
});

test('sshPipe captures stderr and kill() settles done with a non-zero code', async () => {
  const h = sshPipe(['-c', 'echo oops >&2; cat > /dev/null'], { cmd: '/bin/sh' });
  await new Promise((r) => setTimeout(r, 100));
  h.kill();
  const res = await h.done;
  expect(res.code).not.toBe(0);
  expect(res.stderr).toContain('oops');
});

test('sshPipe never throws when the child exits before stdin is consumed', async () => {
  const h = sshPipe(['-c', 'exit 3'], { cmd: '/bin/sh' });
  await h.done;
  expect(() => { h.stdin.write(Buffer.alloc(4096)); h.stdin.end(); }).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sshPipe.test.js`
Expected: FAIL — `sshPipe` is not exported.

- [ ] **Step 3: Implement `sshPipe`**

Append to `src/server/sshRun.js`:

```js
// Long-lived stdin ssh: the caller writes to `stdin` for as long as it likes
// (a voice link's audio frames) and ends it when done. stdout is ignored;
// stderr is kept (capped) for the failure message. `done` resolves { code,
// stderr } on `close`; kill() SIGKILLs and `done` then settles non-zero. The
// stdin error handler matters: a child that exits before reading (writer
// refused the box) EPIPEs the next write, which must not throw. `cmd` is
// test-only injection (/bin/sh), as in sshRunStdin.
const PIPE_STDERR_CAP = 4096;

export function sshPipe(argv, { env = process.env, cmd = 'ssh' } = {}) {
  const child = spawn(cmd, argv, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  const errDec = new StringDecoder('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < PIPE_STDERR_CAP) stderr += errDec.write(d); });
  let settled = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const finish = (code) => { if (settled) return; settled = true; settle({ code, stderr }); };
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  child.stdin.on('error', () => {});
  return {
    stdin: child.stdin,
    done,
    kill: () => { try { child.kill('SIGKILL'); } catch {} },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sshPipe.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/sshRun.js test/sshPipe.test.js
git commit -m "feat(ssh): sshPipe, a streaming-stdin ssh handle for long-lived remote writers"
```

---

### Task 2: The box-side voice writer program

**Files:**
- Create: `src/server/voiceWriter.js`
- Test: `test/voiceWriter.test.js` (create)

**Interfaces:**
- Produces: `WRITER_PROGRAM` (string, the Python text), `WRITER_EXIT_NOT_SET_UP = 3`, `VOICE_FIFO_REL = '.tmuxifier-voice/mic'`, `buildVoiceWriterRemote() → string` (the remote command: python3 when present, else `cat`). Consumed by Task 3 (`boxActions.openAudioSink`, `localShellActions.openAudioSink`).

- [ ] **Step 1: Write the failing test**

```js
// test/voiceWriter.test.js
import { test, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceWriterRemote, WRITER_PROGRAM, WRITER_EXIT_NOT_SET_UP, VOICE_FIFO_REL } from '../src/server/voiceWriter.js';

const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Runs the remote command the way the box's login shell would, with HOME
// pointed at a temp dir. Returns the child so tests can stream stdin.
function runWriter(home) {
  return spawn('/bin/sh', ['-c', buildVoiceWriterRemote()], { env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'] });
}
const exitOf = (child) => new Promise((r) => child.on('close', (c) => r(c)));
async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-'));
  return dir;
}
async function fifoIn(dir) {
  const d = path.join(dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  const f = path.join(d, 'mic');
  execFileSync('mkfifo', ['-m', '600', f]);
  return f;
}
// Non-blocking read of everything currently in the FIFO.
function drain(fd) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') break; throw e; }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

test('the Python program contains no single quote and the remote interpolates nothing but $HOME', () => {
  expect(WRITER_PROGRAM).not.toContain("'");
  const remote = buildVoiceWriterRemote();
  expect(remote).toContain(`exec python3 -c '${WRITER_PROGRAM}'`);
  expect(remote).toContain(`"$HOME/${VOICE_FIFO_REL}"`);
  expect(remote.match(/\$\{?[A-Za-z_]/g)).toEqual(['$HOME', '$HOME']);
  expect(WRITER_EXIT_NOT_SET_UP).toBe(3);
});

test('exits 3 at once when the FIFO does not exist', async () => {
  const dir = await home();
  const child = runWriter(dir);
  child.stdin.end(Buffer.alloc(100));
  const t0 = Date.now();
  expect(await exitOf(child)).toBe(3);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test.skipIf(!hasPython)('never blocks without a reader, keeps at most 4 KB, and exits 0 after stdin ends', async () => {
  const dir = await home();
  const fifo = await fifoIn(dir);
  const child = runWriter(dir);
  child.stdin.end(Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i & 0xff)));
  const t0 = Date.now();
  expect(await exitOf(child)).toBe(0);
  // The 2.5 s silence tail is the only thing that takes time.
  expect(Date.now() - t0).toBeLessThan(5000);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  const kept = drain(fd);
  fsSync.closeSync(fd);
  expect(kept.length).toBeLessThanOrEqual(4096);
  expect(kept.length % 2).toBe(0);
});

test.skipIf(!hasPython)('keeps S16 alignment across odd-length chunks and drops, then tails 2.5 s of zeros', async () => {
  const dir = await home();
  const fifo = await fifoIn(dir);
  const child = runWriter(dir);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  // A 16-bit ramp: every sample the reader sees must be a ramp value.
  const N = 20000;
  const ramp = Buffer.alloc(N * 2);
  for (let i = 0; i < N; i++) ramp.writeInt16LE(i % 32768, i * 2);
  const sizes = [1, 3, 7, 4095, 5, 4093, 2, 9];
  let pos = 0, k = 0;
  const got = [];
  while (pos < ramp.length) {
    const n = sizes[k++ % sizes.length];
    child.stdin.write(ramp.subarray(pos, pos + n)); pos += n;
    await new Promise((r) => setTimeout(r, 2));
    got.push(drain(fd));
  }
  child.stdin.end();
  const t0 = Date.now();
  // Read until EOF (the writer's tail, then its exit).
  for (;;) {
    let n = 0;
    const buf = Buffer.alloc(65536);
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code !== 'EAGAIN') throw e; await new Promise((r) => setTimeout(r, 10)); continue; }
    if (n === 0) break;
    got.push(Buffer.from(buf.subarray(0, n)));
  }
  const tailMs = Date.now() - t0;
  fsSync.closeSync(fd);
  expect(await exitOf(child)).toBe(0);
  const all = Buffer.concat(got);
  expect(all.length % 2).toBe(0);
  const vals = [];
  for (let i = 0; i < all.length; i += 2) vals.push(all.readInt16LE(i));
  // Strip the zero tail, then every step must be a forward ramp step (a
  // half-sample drift would scramble the values).
  let end = vals.length;
  while (end > 0 && vals[end - 1] === 0) end--;
  const zeros = vals.length - end;
  for (let i = 1; i < end; i++) expect(vals[i] - vals[i - 1]).toBeGreaterThanOrEqual(0);
  expect(zeros).toBeGreaterThanOrEqual(320 * 100);   // ≥ 2 s of the 2.5 s tail reached the reader
  expect(tailMs).toBeGreaterThan(2000);
  expect(tailMs).toBeLessThan(4000);
}, 30000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceWriter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the writer module**

```js
// src/server/voiceWriter.js
//
// The box-side end of a voice link (spec 2026-09-04): a small program that
// takes 16 kHz S16 mono audio on stdin and keeps the FIFO behind the box's
// ALSA `default` capture device (see claudeVoiceLink.js) supplied with it.
//
// Three rules, each learned against alsa-lib's file plugin:
//  - Open the FIFO O_RDWR: a plain O_WRONLY open blocks until a reader exists,
//    and closing the last writer hands a mid-recording reader a bare EOF,
//    which the plugin turns into a stale-buffer spin.
//  - Shrink the pipe to 4 KB (~128 ms) and write non-blocking, dropping when
//    full: audio is real-time, so anything nobody read is worthless, and this
//    is what keeps Claude from hearing seconds of stale room noise when it
//    opens the device long after the link was armed.
//  - Only ever write or drop even-length runs, so a drop cannot shift the
//    S16 sample alignment for everything after it. Writes are ≤ PIPE_BUF and
//    therefore atomic.
// On stdin EOF it feeds 2.5 s of paced silence — past Claude Code's 2.0 s
// silence-detection window — so a recording in flight ends on silence
// rather than EOF, then exits 0. Exit 3 = the FIFO is missing (box never set
// up), which voiceLinks.js maps to close code 4002.
//
// The program text rides inside a single-quoted shell string, so it must
// never contain a single quote (pinned by test/voiceWriter.test.js), and it
// interpolates nothing: the FIFO path is derived on the box from $HOME.

export const VOICE_FIFO_REL = '.tmuxifier-voice/mic';
export const WRITER_EXIT_NOT_SET_UP = 3;

export const WRITER_PROGRAM = [
  'import fcntl, os, stat, sys, time',
  'p = os.path.join(os.path.expanduser("~"), ".tmuxifier-voice", "mic")',
  'try:',
  '    if not stat.S_ISFIFO(os.stat(p).st_mode):',
  '        sys.exit(3)',
  'except OSError:',
  '    sys.exit(3)',
  'fd = os.open(p, os.O_RDWR | os.O_NONBLOCK)',
  'try:',
  '    fcntl.fcntl(fd, getattr(fcntl, "F_SETPIPE_SZ", 1031), 4096)',
  'except OSError:',
  '    pass',
  'src = sys.stdin.buffer',
  'carry = b""',
  'while True:',
  '    chunk = src.read1(4096)',
  '    if not chunk:',
  '        break',
  '    buf = carry + chunk',
  '    even = len(buf) & ~1',
  '    carry = buf[even:]',
  '    out = buf[:even]',
  '    while out:',
  '        try:',
  '            n = os.write(fd, out[:4096])',
  '        except BlockingIOError:',
  '            break',
  '        out = out[n:]',
  'zeros = bytes(640)',
  't = time.monotonic()',
  'for _ in range(125):',
  '    try:',
  '        os.write(fd, zeros)',
  '    except BlockingIOError:',
  '        pass',
  '    t += 0.02',
  '    d = t - time.monotonic()',
  '    if d > 0:',
  '        time.sleep(d)',
  'sys.exit(0)',
].join('\n');

// The remote command. python3 is on every Debian/Ubuntu template; the `cat`
// fallback (Alpine, minimal images) works but can carry up to the pipe's
// default 64 KB of stale audio and blocks its channel while nobody reads —
// documented as degraded. The FIFO check comes first on that path so a box
// that was never set up still exits 3 rather than blocking in open().
export function buildVoiceWriterRemote() {
  return [
    'if command -v python3 >/dev/null 2>&1; then',
    `  exec python3 -c '${WRITER_PROGRAM}'`,
    'else',
    `  [ -p "$HOME/${VOICE_FIFO_REL}" ] || exit ${WRITER_EXIT_NOT_SET_UP}`,
    `  exec cat > "$HOME/${VOICE_FIFO_REL}"`,
    'fi',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/voiceWriter.test.js`
Expected: PASS (4 tests; the two python-backed ones skip only where python3 is absent).

- [ ] **Step 5: Commit**

```bash
git add src/server/voiceWriter.js test/voiceWriter.test.js
git commit -m "feat(voice): box-side voice-link writer program (O_RDWR FIFO, drop-when-full, silence tail)"
```

---

### Task 3: `openAudioSink` on boxActions and localShellActions

**Files:**
- Modify: `src/server/boxActions.js` (deps at line 557; add a method beside `execScriptStdin`, ~line 648)
- Modify: `src/server/localShellActions.js` (factory at line 66)
- Test: `test/boxActionsAudioSink.test.js` (create); `test/localShellActions.test.js` (append)

**Interfaces:**
- Consumes: `sshPipe` (Task 1), `buildVoiceWriterRemote` (Task 2).
- Produces: `createBoxActions({ …, pipe = null })` gains `openAudioSink(box) → sshPipe handle` (throws `Error('audio sink not supported')` when `pipe` is unwired). `createLocalShellActions({ …, pipe = sshPipe })` gains `openAudioSink() → sshPipe handle` spawned as `/bin/sh -c <remote>` with the factory's `env`. Consumed by Task 5 (index.js `openSink`).

- [ ] **Step 1: Write the failing tests**

```js
// test/boxActionsAudioSink.test.js
import { test, expect } from 'vitest';
import { createBoxActions } from '../src/server/boxActions.js';
import { buildVoiceWriterRemote } from '../src/server/voiceWriter.js';

const BOX = { id: 'b1', host: '192.168.1.10', user: 'root', sessionName: 'web' };

test('openAudioSink builds the probe argv around the writer remote and returns the pipe handle', () => {
  const calls = [];
  const handle = { stdin: {}, done: Promise.resolve({ code: 0 }), kill() {} };
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), pipe: (argv) => { calls.push(argv); return handle; }, controlDir: '/tmp/cm' });
  expect(actions.openAudioSink(BOX)).toBe(handle);
  expect(calls).toHaveLength(1);
  const argv = calls[0];
  expect(argv[0]).toBe('ssh');
  expect(argv[argv.length - 1]).toBe(buildVoiceWriterRemote());
  expect(argv.join(' ')).toContain('root@192.168.1.10');
  expect(argv.join(' ')).toContain('BatchMode=yes');
});

test('openAudioSink refuses an unsafe box before touching the transport', () => {
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), pipe: () => { throw new Error('must not be called'); }, controlDir: '/tmp/cm' });
  expect(() => actions.openAudioSink({ ...BOX, host: 'bad host; rm -rf /' })).toThrow();
});

test('openAudioSink throws when no pipe transport is wired', () => {
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), controlDir: '/tmp/cm' });
  expect(() => actions.openAudioSink(BOX)).toThrow(/not supported/);
});
```

Append to `test/localShellActions.test.js`:

```js
import { buildVoiceWriterRemote } from '../src/server/voiceWriter.js';

test('openAudioSink runs the writer remote under /bin/sh with the factory env', () => {
  const calls = [];
  const handle = { stdin: {}, done: Promise.resolve({ code: 0 }), kill() {} };
  const actions = createLocalShellActions({ env: { HOME: '/tmp/x', PATH: '/usr/bin' }, pipe: (argv, opts) => { calls.push({ argv, opts }); return handle; } });
  expect(actions.openAudioSink()).toBe(handle);
  expect(calls[0].argv).toEqual(['-c', buildVoiceWriterRemote()]);
  expect(calls[0].opts.cmd).toBe('/bin/sh');
  expect(calls[0].opts.env).toEqual({ HOME: '/tmp/x', PATH: '/usr/bin' });
});
```

Note: `test/localShellActions.test.js` already imports `test, expect` and `createLocalShellActions` (lines 1–3); add only the `buildVoiceWriterRemote` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActionsAudioSink.test.js test/localShellActions.test.js`
Expected: FAIL — `openAudioSink is not a function`.

- [ ] **Step 3: Implement**

`src/server/boxActions.js` line 557, add the dep:

```js
export function createBoxActions({ run, runStdin, pipe = null, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist }) {
```

Add the import at the top of `boxActions.js`:

```js
import { buildVoiceWriterRemote } from './voiceWriter.js';
```

Add the method right after `execScriptStdin` (after its closing `},` ~line 647):

```js
    // Long-lived stdin pipe to the box-side voice writer (voiceWriter.js) over
    // the ControlMaster: the /voice-link WebSocket's audio frames go down it.
    // Returns the sshPipe handle; voiceLinks.js owns its lifetime. Same
    // validated argv path as every probe (assertBoxSafe inside buildProbeArgv).
    openAudioSink(box) {
      if (typeof pipe !== 'function') throw new Error('audio sink not supported');
      const argv = buildProbeArgv(box, buildVoiceWriterRemote(), { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      return pipe(argv);
    },
```

`src/server/localShellActions.js`: add imports

```js
import { sshPipe } from './sshRun.js';
import { buildVoiceWriterRemote } from './voiceWriter.js';
```

Change the factory signature (line 66) to add `pipe = sshPipe`:

```js
export function createLocalShellActions({ run = runLocalShellScript, runStdin = runLocalScriptStdin, readHookAsset = readHookAssetDefault, pipe = sshPipe, cwd = os.homedir(), env = process.env, localSession = 'local' } = {}) {
```

Add to the returned object, after `installAgentHooks`:

```js
    // Host Shell's voice link: the same writer a box runs, spawned locally
    // under /bin/sh (sshPipe's test-only `cmd` injection is exactly the seam
    // a local transport needs). HOME comes from `env`, so the FIFO is this
    // host's own ~/.tmuxifier-voice/mic.
    openAudioSink() {
      return pipe(['-c', buildVoiceWriterRemote()], { cmd: '/bin/sh', env });
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActionsAudioSink.test.js test/localShellActions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js src/server/localShellActions.js test/boxActionsAudioSink.test.js test/localShellActions.test.js
git commit -m "feat(voice): openAudioSink — spawn the voice-link writer over the ControlMaster or locally"
```

---

### Task 4: `voiceLinks.js` — one link per box, newest wins

**Files:**
- Create: `src/server/voiceLinks.js`
- Test: `test/voiceLinks.test.js` (create)

**Interfaces:**
- Consumes: an `openSink({ boxId, box }) → Promise<sshPipe handle> | sshPipe handle` injected at construction (Task 5 wires it to `boxActions.openAudioSink` / `localShellActions.openAudioSink`).
- Produces:
  ```js
  export const LINK_CLOSE = { superseded: 4001, notSetUp: 4002, writerFailed: 4003, stalled: 4004 };
  createVoiceLinks({ openSink, readyMs = 300, stallMs = 3000, killGraceMs = 3000, maxFrameBytes = 8192, maxBytesPerSec = 65536, now = Date.now })
    → { open(boxId, box, { onReady(), onClose(code, reason) }) → link, has(boxId), closeAll() }
  link: { boxId, ready: boolean, closed: boolean, dropped: number, write(frame: Buffer) → boolean, close(code = 1000, reason = 'closed') }
  ```

- [ ] **Step 1: Write the failing tests**

```js
// test/voiceLinks.test.js
import { test, expect } from 'vitest';
import { createVoiceLinks, LINK_CLOSE } from '../src/server/voiceLinks.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake sshPipe handle: records writes, exposes writableNeedDrain, and lets
// a test end the child with a chosen exit code.
function fakeSink() {
  const s = { chunks: [], ended: false, killed: false, needDrain: false };
  let settle;
  s.done = new Promise((r) => { settle = r; });
  s.stdin = { write: (b) => { s.chunks.push(Buffer.from(b)); return true; }, end: () => { s.ended = true; }, get writableNeedDrain() { return s.needDrain; } };
  s.kill = () => { s.killed = true; };
  s.exit = (code) => settle({ code, stderr: '' });
  return s;
}

function make(opts = {}) {
  const sinks = [];
  const links = createVoiceLinks({
    openSink: async () => { const s = fakeSink(); sinks.push(s); return s; },
    readyMs: 20, stallMs: 60, killGraceMs: 10,
    ...opts,
  });
  return { links, sinks };
}
function hooks() {
  const h = { ready: 0, closes: [] };
  h.onReady = () => { h.ready++; };
  h.onClose = (code, reason) => { h.closes.push([code, reason]); };
  return h;
}

test('sends ready once the writer has stayed alive readyMs, and forwards frames after that', async () => {
  const { links, sinks } = make();
  const h = hooks();
  const link = links.open('b1', { id: 'b1' }, h);
  expect(link.write(Buffer.alloc(640))).toBe(false);       // before ready: dropped
  await tick(40);
  expect(h.ready).toBe(1);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(sinks[0].chunks).toHaveLength(1);
  link.close();
  expect(sinks[0].ended).toBe(true);
  expect(h.closes).toEqual([[1000, 'closed']]);
  await tick(20);
  expect(sinks[0].killed).toBe(true);
  expect(links.has('b1')).toBe(false);
});

test('a writer exiting 3 before ready closes 4002 not-set-up; any other early exit is 4003', async () => {
  const a = make(); const ha = hooks();
  a.links.open('b1', {}, ha);
  await tick(5);
  a.sinks[0].exit(3);
  await tick(5);
  expect(ha.ready).toBe(0);
  expect(ha.closes).toEqual([[LINK_CLOSE.notSetUp, 'not-set-up']]);
  const b = make(); const hb = hooks();
  b.links.open('b1', {}, hb);
  await tick(5);
  b.sinks[0].exit(255);
  await tick(5);
  expect(hb.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('a writer dying after ready closes 4003', async () => {
  const { links, sinks } = make(); const h = hooks();
  links.open('b1', {}, h);
  await tick(40);
  sinks[0].exit(1);
  await tick(5);
  expect(h.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('openSink throwing closes 4003', async () => {
  const links = createVoiceLinks({ openSink: async () => { throw new Error('no ssh'); }, readyMs: 20 });
  const h = hooks();
  links.open('b1', {}, h);
  await tick(10);
  expect(h.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('newest wins: a second open for the same box closes the first with 4001', async () => {
  const { links, sinks } = make();
  const h1 = hooks(); const h2 = hooks();
  links.open('b1', {}, h1);
  await tick(40);
  const l2 = links.open('b1', {}, h2);
  expect(h1.closes).toEqual([[LINK_CLOSE.superseded, 'superseded']]);
  expect(sinks[0].ended).toBe(true);
  await tick(40);
  expect(h2.ready).toBe(1);
  expect(links.has('b1')).toBe(true);
  l2.close();
  expect(links.has('b1')).toBe(false);
});

test('a closed superseded link cannot remove its successor from the registry', async () => {
  const { links } = make();
  const l1 = links.open('b1', {}, hooks());
  const l2 = links.open('b1', {}, hooks());
  l1.close();
  expect(links.has('b1')).toBe(true);
  l2.close();
  expect(links.has('b1')).toBe(false);
});

test('drops oversize frames, frames beyond the byte-rate cap, and frames while stdin needs drain', async () => {
  let t = 1000;
  const { links, sinks } = make({ now: () => t, maxFrameBytes: 1000, maxBytesPerSec: 2000 });
  const link = links.open('b1', {}, hooks());
  await tick(40);
  expect(link.write(Buffer.alloc(1001))).toBe(false);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(false);       // 2560 > 2000 in this second
  t += 1000;
  expect(link.write(Buffer.alloc(640))).toBe(true);        // new window
  sinks[0].needDrain = true;
  expect(link.write(Buffer.alloc(640))).toBe(false);
  expect(link.dropped).toBe(3);
  expect(sinks[0].chunks).toHaveLength(4);
  link.close();
});

test('no frame for stallMs after ready closes 4004; frames keep it alive', async () => {
  const { links } = make(); const h = hooks();
  const link = links.open('b1', {}, h);
  await tick(40);
  for (let i = 0; i < 4; i++) { link.write(Buffer.alloc(640)); await tick(30); }
  expect(h.closes).toEqual([]);
  await tick(90);
  expect(h.closes).toEqual([[LINK_CLOSE.stalled, 'stalled']]);
});

test('closeAll closes every link with 1001 going away', async () => {
  const { links } = make(); const h1 = hooks(); const h2 = hooks();
  links.open('b1', {}, h1); links.open('b2', {}, h2);
  await tick(40);
  links.closeAll();
  expect(h1.closes).toEqual([[1001, 'going away']]);
  expect(h2.closes).toEqual([[1001, 'going away']]);
  expect(links.has('b1')).toBe(false);
});

test('a link closed before openSink resolves ends and kills the late sink', async () => {
  let resolveSink;
  const s = fakeSink();
  const links = createVoiceLinks({ openSink: () => new Promise((r) => { resolveSink = r; }), readyMs: 20, killGraceMs: 5 });
  const link = links.open('b1', {}, hooks());
  link.close();
  resolveSink(s);
  await tick(20);
  expect(s.ended).toBe(true);
  expect(s.killed).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voiceLinks.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the manager**

```js
// src/server/voiceLinks.js
//
// The server side of a voice link (spec 2026-09-04): one box-side writer
// (voiceWriter.js) per linked box, fed by the /voice-link WebSocket's binary
// frames. Transport-agnostic — server.js glues a socket to a link through
// onReady/onClose and link.write/link.close — so the whole policy is testable
// with a fake sink. Rules:
//  - One link per box, newest wins: a second open closes the first (4001).
//  - `ready` fires once the writer has stayed alive readyMs; an exit before
//    that is a refusal — 3 = the box was never set up (4002), anything else
//    a transport/writer failure (4003). A death after ready is 4003 too.
//  - Never queue audio: a frame is dropped when the child's stdin needs
//    drain, when it is oversize, or when the rolling byte rate exceeds the
//    cap. Stale audio is worthless and a queue is a memory leak.
//  - A link that delivers no frame for stallMs is closed (4004): a stalled
//    feed leaves Claude's reader blocked and its stop hanging.
//  - close() ends stdin (the writer then plays its 2.5 s silence tail) and
//    kills the child killGraceMs later.

export const LINK_CLOSE = { superseded: 4001, notSetUp: 4002, writerFailed: 4003, stalled: 4004 };

export function createVoiceLinks({
  openSink,
  readyMs = 300,
  stallMs = 3000,
  killGraceMs = 3000,
  maxFrameBytes = 8192,
  maxBytesPerSec = 65536,
  now = Date.now,
} = {}) {
  const links = new Map();

  function open(boxId, box, { onReady = () => {}, onClose = () => {} } = {}) {
    const prev = links.get(boxId);
    if (prev) prev.close(LINK_CLOSE.superseded, 'superseded');

    const link = { boxId, ready: false, closed: false, dropped: 0 };
    let sink = null;
    let readyTimer = null;
    let stallTimer = null;
    let window = { start: now(), bytes: 0 };
    links.set(boxId, link);

    const clearTimers = () => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    const retire = (s) => {
      try { s.stdin.end(); } catch {}
      const k = setTimeout(() => { try { s.kill(); } catch {} }, killGraceMs);
      k.unref?.();
    };
    const finish = (code, reason) => {
      if (link.closed) return;
      link.closed = true;
      clearTimers();
      // Only the CURRENT holder may vacate the slot: a superseded link closing
      // late must not delete its successor.
      if (links.get(boxId) === link) links.delete(boxId);
      if (sink) retire(sink);
      try { onClose(code, reason); } catch {}
    };
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(LINK_CLOSE.stalled, 'stalled'), stallMs);
    };

    link.close = (code = 1000, reason = 'closed') => finish(code, reason);
    link.write = (frame) => {
      if (!link.ready || link.closed || !sink) return false;
      if (!frame || frame.length > maxFrameBytes) { link.dropped++; return false; }
      const t = now();
      if (t - window.start >= 1000) window = { start: t, bytes: 0 };
      if (window.bytes + frame.length > maxBytesPerSec) { link.dropped++; return false; }
      if (sink.stdin.writableNeedDrain) { link.dropped++; return false; }
      window.bytes += frame.length;
      sink.stdin.write(frame);
      armStall();
      return true;
    };

    (async () => {
      let s;
      try { s = await openSink({ boxId, box }); }
      catch { finish(LINK_CLOSE.writerFailed, 'writer-failed'); return; }
      if (link.closed) { retire(s); return; }
      sink = s;
      s.done.then(({ code }) => {
        if (link.closed) return;
        if (!link.ready && code === 3) finish(LINK_CLOSE.notSetUp, 'not-set-up');
        else finish(LINK_CLOSE.writerFailed, 'writer-failed');
      });
      readyTimer = setTimeout(() => {
        readyTimer = null;
        if (link.closed) return;
        link.ready = true;
        armStall();
        try { onReady(); } catch {}
      }, readyMs);
    })();

    return link;
  }

  return {
    open,
    has: (boxId) => links.has(boxId),
    closeAll() { for (const l of [...links.values()]) l.close(1001, 'going away'); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voiceLinks.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/voiceLinks.js test/voiceLinks.test.js
git commit -m "feat(voice): voiceLinks manager — one writer per box, readiness, drop-never-queue, stall close"
```

---

### Task 5: `/voice-link` WebSocket, wiring, and the always-on microphone policy

**Files:**
- Modify: `src/server/server.js` (deps line 121; `permissionsPolicyHeader` line 66 and its use ~line 540; the `app.register(async (scope) => …)` block at line 1950)
- Modify: `src/server/index.js` (imports ~line 46; construction after `localShellActions` line 197; `buildServer` call line 357; not-found handler line 362; shutdown flush line 378)
- Test: `test/voiceLinkRoute.test.js` (create); update any test asserting `microphone=()` (find with `grep -rn "microphone=" test/`)

**Interfaces:**
- Consumes: `createVoiceLinks` (Task 4), `openAudioSink` (Task 3).
- Produces: `GET /voice-link?box=<id>` (websocket). `buildServer({ …, voiceLinks = null })`. Server → client: text frame `ready`; closes with the codes in Global Constraints. Client → server: binary frames only; text frames are ignored.

- [ ] **Step 1: Write the failing route tests**

```js
// test/voiceLinkRoute.test.js
import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

// A fake voiceLinks manager that records open() calls and lets a test fire the
// hooks the route wires; the real manager is covered by test/voiceLinks.test.js.
function fakeLinks() {
  const f = { opens: [], writes: [], closes: [] };
  f.open = (boxId, box, hooks) => {
    const link = { boxId, box, hooks, write: (b) => { f.writes.push(Buffer.from(b)); return true; }, close: (c, r) => { f.closes.push([c, r]); } };
    f.opens.push(link);
    return link;
  };
  return f;
}

async function fixture({ setupStatus = null, voiceLinks = fakeLinks() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vl-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'none',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const sessions = { open() { return {}; }, openLocal() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const setupManager = setupStatus ? { currentForBox: () => ({ id: 'j1', boxId: saved.id, status: setupStatus }) } : undefined;
  const app = buildServer({ config, store, sessions, setupManager, voiceLinks, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { app, port, boxId: saved.id, cookie: `${c.name}=${c.value}`, voiceLinks };
}

function closeOf(ws) {
  return new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('unauthenticated upgrade is refused 1008', async () => {
  const { port, boxId } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`);
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'unauthorized' });
});

test('unknown box is refused 1008', async () => {
  const { port, cookie } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=nope`, { headers: { cookie } });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'unknown box' });
});

test('a box whose setup job is running is refused 1008 setting up, and no link is opened', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture({ setupStatus: 'running' });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'setting up' });
  expect(voiceLinks.opens).toHaveLength(0);
});

test('a parked (needs-interactive) job does not gate the link', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture({ setupStatus: 'needs-interactive' });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  expect(voiceLinks.opens).toHaveLength(1);
  ws.close();
});

test('opens a link for the box, relays ready, forwards binary frames only, and closes the link with the socket', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const texts = [];
  ws.on('message', (d, isBinary) => { if (!isBinary) texts.push(d.toString()); });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  const link = voiceLinks.opens[0];
  expect(link.boxId).toBe(boxId);
  expect(link.box.id).toBe(boxId);
  link.hooks.onReady();
  await tick(20);
  expect(texts).toEqual(['ready']);
  ws.send(Buffer.from([1, 2, 3, 4]));
  ws.send('not audio');
  await tick(20);
  expect(voiceLinks.writes).toEqual([Buffer.from([1, 2, 3, 4])]);
  ws.close();
  await tick(20);
  expect(voiceLinks.closes[0]).toEqual([1000, 'closed']);
});

test('the link closing closes the socket with its code and reason', async () => {
  const { port, boxId, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const closed = closeOf(ws);
  await new Promise((res) => ws.on('open', res));
  await tick(20);
  voiceLinks.opens[0].hooks.onClose(4002, 'not-set-up');
  expect(await closed).toEqual({ code: 4002, reason: 'not-set-up' });
});

test('__local__ opens a link with no box', async () => {
  const { port, cookie, voiceLinks } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=__local__`, { headers: { cookie } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await tick(20);
  expect(voiceLinks.opens[0].boxId).toBe('__local__');
  expect(voiceLinks.opens[0].box).toBeNull();
  ws.close();
});

test('without a manager wired the upgrade closes 1011', async () => {
  const { port, boxId, cookie } = await fixture({ voiceLinks: null });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  expect((await closeOf(ws)).code).toBe(1011);
});

test('the permissions policy allows the microphone for this origin regardless of whisper', async () => {
  // The header rides the global onSend hook, so any response carries it —
  // an unauthenticated 401 avoids depending on a built dist/.
  const { app } = await fixture();
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  expect(res.headers['permissions-policy']).toContain('microphone=(self)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voiceLinkRoute.test.js`
Expected: FAIL — the upgrade to `/voice-link` gets a 404 / the policy header says `microphone=()`.

- [ ] **Step 3: Implement the route and policy change**

`src/server/server.js`:

1. Add `voiceLinks = null` to the `buildServer({ … })` destructuring at line 121 (anywhere in the list, e.g. after `voiceEngine = null`).

2. Replace `permissionsPolicyHeader` (line 66) so the microphone token no longer depends on whisper — the browser mic is now a first-class input whether or not local transcription is installed:

```js
// The microphone token is always granted to this origin: the mic feeds the
// whisper dictation path AND the Claude Code voice link, and the latter needs
// nothing installed on this host. `self` still means the operator's own
// browser prompt gates every capture; it just stops depending on voice.json.
function permissionsPolicyHeader() {
  return 'camera=(), microphone=(self), geolocation=()';
}
```

Update its one call site (~line 540) to `permissionsPolicyHeader()`. Then remove `voiceEnabledCache` if nothing else reads it: delete the `let voiceEnabledCache = …` declaration (~lines 158–160), the `voiceEnabledCache = s.enabled;` assignment inside `voiceState()` (~line 168) and the comment block above them that explains the cache (~lines 145–157); keep `voiceState()` itself and the `voiceEnabledInitial` dep (still accepted, now unused by the header — leave the parameter so `index.js` keeps compiling, and drop the comment that motivated it).

3. Inside the existing `app.register(async (scope) => { … })` block (line 1950), after the `/term` handler's closing `});` (line 2133) and before the block's closing `});` (line 2134), add:

```js
    // Voice link (spec 2026-09-04): the browser mic, as 16 kHz S16 mono
    // frames, into the box's default capture device via voiceLinks.js. Same
    // auth and setup gate as /term; __local__ is the host's own writer.
    // Binary frames only — a text frame from the client is ignored.
    scope.get('/voice-link', { websocket: true }, async (socket, req) => {
      if (!hasTrustedOrigin(req)) { socket.close(1008, 'forbidden origin'); return; }
      if (!isAuthed(req)) { socket.close(1008, 'unauthorized'); return; }
      if (!voiceLinks) { socket.close(1011, 'voice link unavailable'); return; }
      const boxId = String(req.query.box || '');
      const box = boxId === '__local__' ? null : await store.getBox(boxId);
      if (boxId !== '__local__' && !box) { socket.close(1008, 'unknown box'); return; }
      if (box && setupManager?.currentForBox(boxId)?.status === 'running') {
        socket.close(1008, 'setting up');
        return;
      }
      const link = voiceLinks.open(boxId, box, {
        onReady: () => { try { if (socket.readyState === 1) socket.send('ready'); } catch {} },
        onClose: (code, reason) => { try { socket.close(code, reason); } catch {} },
      });
      socket.on('message', (raw, isBinary) => { if (isBinary) link.write(raw); });
      socket.on('close', () => link.close(1000, 'closed'));
      socket.on('error', () => link.close(1000, 'closed'));
    });
```

`src/server/index.js`:

1. Imports (beside line 46–47):

```js
import { createVoiceLinks } from './voiceLinks.js';
import { sshPipe } from './sshRun.js';
```

2. `boxActions` construction (lines 77–84): add `pipe: (argv) => sshPipe(argv),` beside `run`/`runStdin`.

3. After `const localShellActions = createLocalShellActions();` (line 197):

```js
// Voice links: one box-side writer per linked box, fed by /voice-link. The
// host's own shell gets the same writer spawned locally.
const voiceLinks = createVoiceLinks({
  openSink: ({ boxId, box }) => (boxId === '__local__' ? localShellActions.openAudioSink() : boxActions.openAudioSink(box)),
});
```

4. Pass `voiceLinks` into the `buildServer({ … })` call (line 357).

5. Not-found handler (line 362): add `|| req.raw.url?.startsWith('/voice-link')` beside the `/term` check.

6. Shutdown flush (line 378, the `flush: [...]` array): add

```js
        // Drop every voice link so no box-side writer outlives the server.
        () => { voiceLinks.closeAll(); return Promise.resolve(); },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voiceLinkRoute.test.js`
Expected: PASS (9 tests). Then run `grep -rn "microphone=" test/` — any test expecting `microphone=()` for the voice-off case must now expect `microphone=(self)`; update it and run that file.

- [ ] **Step 5: Run the existing server suites**

Run: `npx vitest run test/server.ws.integration.test.js test/serverRoutes.test.js 2>/dev/null || npx vitest run test/server.ws.integration.test.js`
Expected: PASS — `/term` is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/server/index.js test/voiceLinkRoute.test.js test/
git commit -m "feat(voice): /voice-link WebSocket wired to voiceLinks; microphone policy always self"
```

---

### Task 6: End-to-end integration over the isolated sshd box

**Files:**
- Test: `test/voiceLink.integration.test.js` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–5 with the real `sshPipe`, real `createVoiceLinks`, real `createBoxActions`, real `/voice-link` route, against `test/helpers/localBox.js`.

- [ ] **Step 1: Check the fixture's PATH carries python3**

Run: `grep -n "SetEnv" test/helpers/localBox.js` and `command -v python3`.
Expected: the `SetEnv … PATH=…` line names a PATH that includes the directory `command -v python3` prints (normally `/usr/bin`). If it does not, extend that PATH in the fixture in this task — the fallback `cat` writer would still pass the byte test but not exercise the real program.

- [ ] **Step 2: Write the integration test**

```js
// test/voiceLink.integration.test.js
import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createVoiceLinks } from '../src/server/voiceLinks.js';
import { sshRun, sshRunStdin, sshPipe } from '../src/server/sshRun.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';
import { setupLocalBox } from './helpers/localBox.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const lb = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vli-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: lb.box.host, sessionName: lb.session });
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    pipe: (argv) => sshPipe(argv, { env: lb.env }),
    sshConfigFile: lb.sshConfigFile, controlDir: path.join(dir, 'cm'),
  });
  const voiceLinks = createVoiceLinks({ openSink: ({ box }) => boxActions.openAudioSink(box), killGraceMs: 500 });
  const sessions = { open() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const app = buildServer({ config, store, sessions, voiceLinks, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { voiceLinks.closeAll(); await app.close(); await lb.cleanup(); await fs.rm(dir, { recursive: true, force: true }); };
  return { lb, port, boxId: saved.id, cookie: `${c.name}=${c.value}` };
}
function connect(port, boxId, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const texts = [];
  ws.on('message', (d, isBinary) => { if (!isBinary) texts.push(d.toString()); });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return { ws, texts, closed };
}
function drain(fd) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') break; throw e; }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

test('a box that was never set up closes 4002 not-set-up', async () => {
  const { port, boxId, cookie } = await fixture();
  const { closed } = connect(port, boxId, cookie);
  expect(await closed).toEqual({ code: 4002, reason: 'not-set-up' });
}, 30000);

test('frames sent after ready land in the box FIFO byte-for-byte', async () => {
  const { lb, port, boxId, cookie } = await fixture();
  const vdir = path.join(lb.home, '.tmuxifier-voice');
  await fs.mkdir(vdir, { recursive: true, mode: 0o700 });
  const fifo = path.join(vdir, 'mic');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const { ws, texts, closed } = connect(port, boxId, cookie);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  for (let i = 0; i < 100 && texts.length === 0; i++) await tick(50);
  expect(texts).toEqual(['ready']);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  const frames = [0, 1, 2].map((k) => Buffer.alloc(640, 0x10 + k));
  const got = [];
  for (const f of frames) { ws.send(f); await tick(30); got.push(drain(fd)); }
  for (let i = 0; i < 40 && Buffer.concat(got).length < 1920; i++) { await tick(50); got.push(drain(fd)); }
  expect(Buffer.concat(got).subarray(0, 1920)).toEqual(Buffer.concat(frames));
  fsSync.closeSync(fd);
  ws.close();
  expect((await closed).code).toBe(1000);
}, 40000);
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/voiceLink.integration.test.js`
Expected: PASS (2 tests). If the first test hangs instead of closing 4002, the writer never exited 3 — check that the `cat` fallback branch is not being taken (python3 missing from the fixture PATH, see Step 1).

- [ ] **Step 4: Commit**

```bash
git add test/voiceLink.integration.test.js test/helpers/localBox.js
git commit -m "test(voice): voice-link integration over the isolated sshd box"
```

---

### Task 7: `claudeVoiceLink.js` — the box-side install script and pusher

**Files:**
- Create: `src/server/claudeVoiceLink.js`
- Test: `test/claudeVoiceLink.test.js` (create)

**Interfaces:**
- Produces: `buildVoiceLinkInstallScript() → string` (pure, interpolates nothing) and `createVoiceLinkPusher({ runStdin }) → { push(box) }` with `runStdin(box, script, bytes)` exactly as `createAgentHooksPusher` uses it. Results, all carrying `target: 'voice-link'`:
  - `{ target, ok: true, settings: 'applied' | 'kept' | 'error-no-json-tool' }`
  - `{ target, ok: false, skipped: 'no Claude on the box' }`
  - `{ target, ok: false, skipped: 'the box has its own ~/.asoundrc' }`
  - `{ target, ok: false, error: 'voice link push failed' }`
  Consumed by Task 8 (setup phase) and Task 9 (Host Shell).

- [ ] **Step 1: Write the failing tests**

```js
// test/claudeVoiceLink.test.js
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceLinkInstallScript, createVoiceLinkPusher } from '../src/server/claudeVoiceLink.js';

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}
// A temp HOME with a stub `claude` on PATH — how the presence check is made to pass.
async function claudeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { dir, cfg: path.join(dir, '.claude'), env: () => ({ HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: `${bin}:/usr/bin:/bin` }) };
}
const isFifo = async (p) => (await fs.stat(p)).isFifo();

test('the script interpolates nothing and carries the marker and the plug/file/null recipe', () => {
  const s = buildVoiceLinkInstallScript();
  expect(s).toContain("MARK='# tmuxifier-voice-link'");
  expect(s).toContain('type plug');
  expect(s).toContain('type file');
  expect(s).toContain('slave.pcm "null"');
  expect(s).toContain('format S16_LE rate 16000 channels 1');
  expect(s).toContain('command -v claude');
  expect(s).not.toMatch(/\$\{[^}]*(box|host|user|session)/i);
});

test('no Claude on the box: touches nothing and reports skipped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vl-'));
  const res = await runShell(buildVoiceLinkInstallScript(), { HOME: dir, PATH: '/usr/bin:/bin' });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.asoundrc'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
});

test('fresh box: writes ~/.asoundrc with the absolute FIFO path, makes the FIFO, and turns voice on', async () => {
  const b = await claudeBox();
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: applied settings=applied');
  const rc = await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8');
  expect(rc.startsWith('# tmuxifier-voice-link\n')).toBe(true);
  expect(rc).toContain(`infile "${path.join(b.dir, '.tmuxifier-voice', 'mic')}"`);
  expect(rc).toContain('pcm.!default {');
  expect((await fs.stat(path.join(b.dir, '.asoundrc'))).mode & 0o777).toBe(0o600);
  expect(await isFifo(path.join(b.dir, '.tmuxifier-voice', 'mic'))).toBe(true);
  expect((await fs.stat(path.join(b.dir, '.tmuxifier-voice'))).mode & 0o777).toBe(0o700);
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(settings).toEqual({ voice: { enabled: true } });
});

test('rerun is idempotent: a marked ~/.asoundrc is rewritten, the FIFO kept, settings kept', async () => {
  const b = await claudeBox();
  await runShell(buildVoiceLinkInstallScript(), b.env());
  await fs.writeFile(path.join(b.dir, '.asoundrc'), '# tmuxifier-voice-link\nstale\n');
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('VOICELINK: applied settings=kept');
  expect(await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8')).toContain('type plug');
  expect(await isFifo(path.join(b.dir, '.tmuxifier-voice', 'mic'))).toBe(true);
});

test('a foreign ~/.asoundrc is never touched: skipped, no FIFO, no settings change', async () => {
  const b = await claudeBox();
  await fs.writeFile(path.join(b.dir, '.asoundrc'), 'pcm.!default { type hw card 0 }\n');
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('VOICELINK: skipped-asoundrc-exists');
  expect(await fs.readFile(path.join(b.dir, '.asoundrc'), 'utf8')).toBe('pcm.!default { type hw card 0 }\n');
  await expect(fs.access(path.join(b.dir, '.tmuxifier-voice'))).rejects.toBeTruthy();
  await expect(fs.access(path.join(b.cfg, 'settings.json'))).rejects.toBeTruthy();
});

test('an existing settings.json without a voice key is merged, every other key preserved', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [] }] } }, null, 2));
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('settings=applied');
  const s = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(s).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [] }] }, voice: { enabled: true } });
});

test('an operator who ran /voice off stays off: an existing voice key is kept verbatim', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  const before = JSON.stringify({ voice: { enabled: false, mode: 'tap' } }, null, 2);
  await fs.writeFile(path.join(b.cfg, 'settings.json'), before);
  const res = await runShell(buildVoiceLinkInstallScript(), b.env());
  expect(res.stdout).toContain('settings=kept');
  expect(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8')).toBe(before);
});

test('pusher maps applied → ok+settings, both skips → skipped, failure → error', async () => {
  const mk = (res) => createVoiceLinkPusher({ runStdin: async () => res });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=applied\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'applied' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: applied settings=kept\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: true, settings: 'kept' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-no-claude\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'no Claude on the box' });
  expect(await mk({ code: 0, stdout: 'VOICELINK: skipped-asoundrc-exists\n' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, skipped: 'the box has its own ~/.asoundrc' });
  expect(await mk({ code: 1, stdout: '' }).push({ id: 'b' })).toEqual({ target: 'voice-link', ok: false, error: 'voice link push failed' });
  let seen;
  await createVoiceLinkPusher({ runStdin: async (box, script, input) => { seen = { box, script, input }; return { code: 0, stdout: 'VOICELINK: applied settings=applied\n' }; } }).push({ id: 'b' });
  expect(seen.script).toBe(buildVoiceLinkInstallScript());
  expect(seen.input.length).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/claudeVoiceLink.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```js
// src/server/claudeVoiceLink.js
//
// The `voice-link` setup phase (spec 2026-09-04), structural twin of
// claudeAgentHooks.js: a pure script that interpolates nothing, pushed over
// the ControlMaster, with the apply-or-skip decision made ON the box by a
// `command -v claude` check. It makes the box's ALSA `default` capture device
// a FIFO Tmuxifier feeds (voiceWriter.js), so Claude Code's own voice mode —
// whose Linux capture opens ALSA `default` — hears the operator's browser
// mic. Three parts, each idempotent:
//  1. ~/.asoundrc: plug → file(infile=FIFO) → null. Written only when absent
//     or already ours (the marker line); an operator's own config is never
//     touched, and the phase then skips entirely — the link cannot work
//     without owning `default`.
//  2. ~/.tmuxifier-voice/mic, the FIFO. Absolute path, resolved on the box
//     from $HOME, because alsa-lib does not expand ~ in `infile`.
//  3. voice.enabled=true in Claude's settings.json — only when no `voice` key
//     exists, so a deliberate /voice off stays off. Same jq → node → python3
//     chain the statusline push uses; a box with none reports it, and still
//     gets the device and the FIFO.

const RC_BODY = [
  'pcm.tmuxifier_mic {',
  '  type file',
  '  slave.pcm "null"',
  '  file "/dev/null"',
  // infile is the one line with a box-side value; it is emitted separately.
  '  format "raw"',
  '}',
  'pcm.!default {',
  '  type plug',
  '  slave { pcm "tmuxifier_mic" format S16_LE rate 16000 channels 1 }',
  '}',
];

export function buildVoiceLinkInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'SETTINGS="$DIR/settings.json"',
    'RC="$HOME/.asoundrc"',
    'VDIR="$HOME/.tmuxifier-voice"',
    'FIFO="$VDIR/mic"',
    "MARK='# tmuxifier-voice-link'",
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'VOICELINK: skipped-no-claude'",
    '  exit 0',
    'fi',
    'cat >/dev/null 2>&1 || true',
    '',
    "# 2. Never touch an operator's own ALSA config.",
    'if [ -f "$RC" ] && ! grep -qF "$MARK" "$RC" 2>/dev/null; then',
    "  echo 'VOICELINK: skipped-asoundrc-exists'",
    '  exit 0',
    'fi',
    '',
    "# 3. The FIFO Claude Code's default capture device reads.",
    'mkdir -p "$VDIR"',
    'chmod 700 "$VDIR"',
    'if [ ! -p "$FIFO" ]; then rm -f "$FIFO"; mkfifo -m 600 "$FIFO"; fi',
    '',
    '# 4. ALSA: default = plug -> file(infile=FIFO) -> null. Atomic write.',
    'TMP="$RC.tmuxifier.tmp"',
    '{',
    '  echo "$MARK"',
    ...RC_BODY.slice(0, 5).map((l) => `  echo '${l}'`),
    '  echo "  infile \\"$FIFO\\""',
    ...RC_BODY.slice(5).map((l) => `  echo '${l}'`),
    '} > "$TMP"',
    'chmod 600 "$TMP"',
    'mv "$TMP" "$RC"',
    '',
    "# 5. Turn Claude Code's voice mode on, once, only where no choice exists yet.",
    'RESULT=kept',
    'if [ ! -f "$SETTINGS" ]; then',
    '  mkdir -p "$DIR"',
    '  printf \'{"voice":{"enabled":true}}\\n\' > "$SETTINGS"',
    '  chmod 600 "$SETTINGS"',
    '  RESULT=applied',
    'elif command -v jq >/dev/null 2>&1; then',
    '  if [ "$(jq -r \'has("voice")\' "$SETTINGS")" = "false" ]; then',
    '    jq \'.voice = {"enabled": true}\' "$SETTINGS" > "$SETTINGS.tmuxifier.tmp" && mv "$SETTINGS.tmuxifier.tmp" "$SETTINGS"',
    '    RESULT=applied',
    '  fi',
    'elif command -v node >/dev/null 2>&1; then',
    '  RESULT=$(node -e \'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));if(Object.prototype.hasOwnProperty.call(d,"voice")){process.stdout.write("kept");process.exit(0)}d.voice={enabled:true};const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p);process.stdout.write("applied")\' "$SETTINGS")',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  RESULT=$(python3 -c \'import json,sys,os',
    'p=sys.argv[1];d=json.load(open(p))',
    'if "voice" in d:',
    '    print("kept",end="");sys.exit(0)',
    'd["voice"]={"enabled":True}',
    't=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p);print("applied",end="")\' "$SETTINGS")',
    'else',
    '  RESULT=error-no-json-tool',
    'fi',
    'echo "VOICELINK: applied settings=$RESULT"',
  ].join('\n');
}

export function createVoiceLinkPusher({ runStdin }) {
  return {
    async push(box) {
      const res = await runStdin(box, buildVoiceLinkInstallScript(), Buffer.alloc(0));
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/VOICELINK:\s*skipped-no-claude/.test(out)) return { target: 'voice-link', ok: false, skipped: 'no Claude on the box' };
        if (/VOICELINK:\s*skipped-asoundrc-exists/.test(out)) return { target: 'voice-link', ok: false, skipped: 'the box has its own ~/.asoundrc' };
        const m = /VOICELINK:\s*applied settings=(\S+)/.exec(out);
        if (m) return { target: 'voice-link', ok: true, settings: m[1] };
      }
      return { target: 'voice-link', ok: false, error: 'voice link push failed' };
    },
  };
}
```

Note on the `echo '…'` lines: every `RC_BODY` line is emitted through single quotes on the box, so `!` and `"` inside them reach the file literally; the `infile` line is the only one that expands (`$FIFO`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/claudeVoiceLink.test.js`
Expected: PASS (8 tests). The merge tests exercise whichever of jq/node/python3 the host has first; all three yield the same file.

- [ ] **Step 5: Commit**

```bash
git add src/server/claudeVoiceLink.js test/claudeVoiceLink.test.js
git commit -m "feat(setup): voice-link install script and pusher (asoundrc plug→file→null, FIFO, voice.enabled)"
```

---

### Task 8: The `voice-link` setup phase and `alsa-utils` in the Claude tool block

**Files:**
- Modify: `src/server/setupManager.js` (deps ~line 58; `summary()` line 109; the phase block lines 200–212)
- Modify: `src/server/boxActions.js` (`TOOLS.claude`, lines 157–169)
- Modify: `src/server/index.js` (pusher construction lines 139–146; `createSetupManager` call lines 172–173)
- Test: `test/setupManager.test.js` (append), `test/boxActions.test.js` or wherever `buildEnsureTmuxRemote(…, { tools: ['claude'] })` is already asserted (find with `grep -rln "install.sh" test/`)

**Interfaces:**
- Consumes: `createVoiceLinkPusher` (Task 7).
- Produces: `createSetupManager({ …, pushVoiceLink = null })`; `job.voiceLink` recorded after `agent-hooks`, before `script`; `summary()` carries `voiceLink`. The `claude` tool's script block installs `alsa-utils` when `arecord` is absent.

- [ ] **Step 1: Write the failing tests**

Append to `test/setupManager.test.js` (it already has `make()`, `BOX`, and the `_settled` helper; mirror the agent-hooks block at lines 369–459):

```js
test('claude tool selected: the voice-link phase runs after agent-hooks and lands on the job and the summary', async () => {
  const seen = [];
  const m = make({
    pushStatusline: async () => { seen.push('sl'); return { target: 'statusline', ok: true }; },
    pushAgentHooks: async () => { seen.push('ah'); return { target: 'agent-hooks', ok: true }; },
    pushVoiceLink: async (box) => { seen.push(`vl:${box.id}`); return { target: 'voice-link', ok: true, settings: 'applied' }; },
  });
  const s = m.start(BOX, { tools: ['claude'] });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(seen).toEqual(['sl', 'ah', `vl:${BOX.id}`]);
  expect(job.voiceLink).toEqual({ target: 'voice-link', ok: true, settings: 'applied' });
  expect(m.listJobs()[0].voiceLink).toEqual({ target: 'voice-link', ok: true, settings: 'applied' });
});

test('no claude tool: the voice-link phase is skipped entirely', async () => {
  let called = 0;
  const m = make({ pushVoiceLink: async () => { called++; return { target: 'voice-link', ok: true }; } });
  const s = m.start(BOX, { tools: ['git'] });
  await m._settled(s.id);
  expect(called).toBe(0);
  expect(m.getJob(s.id).voiceLink).toBeUndefined();
});

test('a failing voice-link push is recorded, never promoted', async () => {
  const m = make({ pushVoiceLink: async () => { throw new Error('boom'); } });
  const s = m.start(BOX, { tools: ['claude'] });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.voiceLink).toEqual({ target: 'voice-link', ok: false, error: 'voice link push failed' });
});

test('voice-link runs before the saved script and before the session is created', async () => {
  const order = [];
  const m = make({
    pushVoiceLink: async () => { order.push('voice-link'); return { target: 'voice-link', ok: true }; },
    getScript: async () => ({ id: 'fs-1', name: 's', script: 'true' }),
    ensureSession: async () => { order.push('session'); },
  });
  const s = m.start(BOX, { tools: ['claude'], scriptId: 'fs-1' });
  await m._settled(s.id);
  expect(order[0]).toBe('voice-link');
  expect(order[order.length - 1]).toBe('session');
});
```

If the last test's `getScript`/`scriptId` shape differs from the existing script-phase tests at lines 617–624, copy their exact fixture instead.

In the tool-catalog test file found by the grep, add:

```js
test('the claude tool also installs alsa-utils for the voice link, guarded on arecord', () => {
  const s = buildEnsureTmuxRemote('web', '', { tools: ['claude'] });
  expect(s).toContain('command -v arecord');
  expect(s).toContain('apt-get install -y --no-install-recommends alsa-utils');
  expect(s).toContain('apk add alsa-utils');
  const g = buildEnsureTmuxRemote('web', '', { tools: ['git'] });
  expect(g).not.toContain('alsa-utils');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js <catalog test file>`
Expected: FAIL on the four new setupManager tests and the catalog test.

- [ ] **Step 3: Implement**

`src/server/setupManager.js`:

1. Deps (after `pushAgentHooks = null,` ~line 58):

```js
  // Post-setup voice-link push (claudeVoiceLink.js). Default null: an
  // unwired manager skips the step. Same one-knob gate as the statusline and
  // the hooks; the box decides via its own command -v claude check.
  pushVoiceLink = null,
```

2. `summary()` (line 109): add `voiceLink: j.voiceLink ?? null,` after `agentHooks: j.agentHooks ?? null,`.

3. After the agent-hooks block (after line 212, before the `script` phase):

```js
    if (pushVoiceLink && wantsClaudeStack && box && !j.cancelled) {
      j.phase = 'voice-link';
      persist();
      try { j.voiceLink = await pushVoiceLink(box); }
      catch { j.voiceLink = { target: 'voice-link', ok: false, error: 'voice link push failed' }; }
    }
```

`src/server/boxActions.js`, `TOOLS.claude` (lines 157–169): append the package block so the entry reads

```js
  claude: () => [
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  t="$(mktemp)"',
    '  curl -fsSL https://claude.ai/install.sh -o "$t"',
    '  bash "$t"',
    '  rm -f "$t"',
    'fi',
    // The voice link (claudeVoiceLink.js) needs alsa-lib for Claude Code's
    // native capture path on boxes that see a sound card, and `arecord` for
    // its fallback on boxes that see none; alsa-utils brings both. Guarded on
    // arecord so a box that has it is left alone.
    ...installPackagesBlock('arecord', samePkg('alsa-utils'), 'alsa-utils'),
  ],
```

`src/server/index.js`: beside the other pushers (line 139–146) add

```js
import { createVoiceLinkPusher } from './claudeVoiceLink.js';
…
const voiceLinkPusher = createVoiceLinkPusher({
  runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
});
```

and in the `createSetupManager({ … })` call add `pushVoiceLink: (box) => voiceLinkPusher.push(box),` after `pushAgentHooks`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js <catalog test file> test/claudeVoiceLink.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/setupManager.js src/server/boxActions.js src/server/index.js test/
git commit -m "feat(setup): voice-link phase after agent-hooks; alsa-utils rides the Claude tool"
```

---

### Task 9: Host Shell install and the local-shell route

**Files:**
- Modify: `src/server/localShellActions.js` (factory lines 66–90)
- Modify: `src/server/server.js` (`PATCH /api/local-shell`, lines 1915–1940)
- Test: `test/localShellActions.test.js` (append); the local-shell route test (find with `grep -rln "api/local-shell" test/`)

**Interfaces:**
- Produces: `localShellActions.installVoiceLink() → pusher result`; `PATCH /api/local-shell` with `claudeHooks === true` returns `{ ok: true, agentHooks, voiceLink }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/localShellActions.test.js`:

```js
import { buildVoiceLinkInstallScript } from '../src/server/claudeVoiceLink.js';

test('installVoiceLink runs the standard voice-link installer locally with empty stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => { calls.push({ script, input, opts }); return { code: 0, stdout: 'VOICELINK: applied settings=kept\n', stderr: '' }; },
  });
  await expect(actions.installVoiceLink()).resolves.toEqual({ target: 'voice-link', ok: true, settings: 'kept' });
  expect(calls[0].script).toBe(buildVoiceLinkInstallScript());
  expect(calls[0].input.length).toBe(0);
  expect(calls[0].opts.cwd).toBe(os.homedir());
});
```

In the local-shell route test file, beside the existing `claudeHooks: true` test, add a case asserting the response carries `voiceLink` from a fake `localShellActions.installVoiceLink` (return `{ target: 'voice-link', ok: true, settings: 'applied' }`) and that `claudeHooks` absent leaves `voiceLink` out of the response.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/localShellActions.test.js <route test file>`
Expected: FAIL — `installVoiceLink is not a function`; response lacks `voiceLink`.

- [ ] **Step 3: Implement**

`src/server/localShellActions.js`: import `createVoiceLinkPusher` from `./claudeVoiceLink.js`; inside the factory, after `hooksPusher`:

```js
  const voiceLinkPusher = createVoiceLinkPusher({
    runStdin: (_box, script, bytes) => runStdin(script, bytes, { cwd, env }),
  });
```

and add to the returned object:

```js
    async installVoiceLink() {
      return voiceLinkPusher.push(null);
    },
```

`src/server/server.js`, replace the `claudeHooks === true` branch (lines 1935–1938):

```js
    if (claudeHooks === true && localShellActions?.installAgentHooks) {
      const agentHooks = await localShellActions.installAgentHooks();
      // The voice link rides the same knob on the host as on a box.
      const voiceLink = localShellActions.installVoiceLink ? await localShellActions.installVoiceLink() : null;
      return { ok: true, agentHooks, voiceLink };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/localShellActions.test.js <route test file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/localShellActions.js src/server/server.js test/
git commit -m "feat(local-shell): install the voice link on the host under the Claude hooks knob"
```

---

### Task 10: `POST /api/boxes/:id/pane-kind`

**Files:**
- Modify: `src/server/tmuxInject.js` (export `paneKindVia`, `paneKindLocal` beside `injectLocalText`, ~line 304)
- Modify: `src/server/boxActions.js` (`paneKind` beside `injectText`, ~line 659)
- Modify: `src/server/server.js` (new route beside `/api/boxes/:id/window`, ~line 972; `paneKindLocal = paneKindLocalDefault` dep at line 121; import from `./tmuxInject.js` at line 25)
- Test: `test/paneKindRoute.test.js` (create); `test/tmuxInject.test.js` (append two cases for `paneKindVia`)

**Interfaces:**
- Produces: `paneKindVia(runScript, session) → Promise<{ ok: true, kind: 'claude'|'codex'|'shell'|'busy' } | { ok: false, error }>`; `paneKindLocal(session, { run })`; `boxActions.paneKind(box, session, { timeoutMs = 8000 })`; route body `{ session? }` → `{ kind }`, 404 unknown box, 409 setup running, 400 bad session, 502 probe failed. For `__local__` the session defaults to the server's `localSession`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tmuxInject.test.js`:

```js
import { paneKindVia } from '../src/server/tmuxInject.js';

test('paneKindVia classifies through the same capture the injectors use', async () => {
  const scripts = [];
  const run = async (s) => { scripts.push(s); return { code: 0, stdout: 'claude\n╭─ Claude Code ─╮\n' }; };
  expect(await paneKindVia(run, 'web')).toEqual({ ok: true, kind: 'claude' });
  expect(scripts[0]).toContain("#{pane_current_command}");
  expect(scripts[0]).toContain("'=web:'");
  expect(await paneKindVia(async () => ({ code: 0, stdout: 'zsh\nuser@host $ ' }), 'web')).toEqual({ ok: true, kind: 'shell' });
});

test('paneKindVia reports a failed capture rather than guessing', async () => {
  const r = await paneKindVia(async () => ({ code: 1, stdout: '', stderr: 'no session' }), 'web');
  expect(r).toEqual({ ok: false, error: 'no session' });
  const t = await paneKindVia(async () => { throw new Error('ssh died'); }, 'web');
  expect(t).toEqual({ ok: false, error: 'ssh died' });
});
```

```js
// test/paneKindRoute.test.js — modeled on test/paneRoutes.test.js: real
// createBoxActions over a fake `run` seam, real routes, fake setupManager.
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, boxId, calls, captureOut, failNext, setupRunning, localCalls;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pk-'));
  const config = { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir, sshConfigPath: path.join(dir, 'nope'), localShell: 'none' };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  boxId = saved.id;
  calls = []; captureOut = 'claude\n╭─╮\n'; failNext = false; setupRunning = false; localCalls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'boom' }; }
    return { code: 0, stdout: captureOut, stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  const paneKindLocal = async (session) => { localCalls.push(session); return { ok: true, kind: 'shell' }; };
  app = buildServer({ config, store, sessions, boxActions, setupManager, paneKindLocal, localSession: 'local', statusChecker: { checkBox: async () => ({ reachable: true }) } });
});
afterAll(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}
const post = async (id, payload) => app.inject({ method: 'POST', url: `/api/boxes/${id}/pane-kind`, headers: await headers(), payload });

test('classifies the requested session on the box', async () => {
  calls.length = 0;
  const res = await post(boxId, { session: 'proj2' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ kind: 'claude' });
  expect(calls[0][calls[0].length - 1]).toContain("'=proj2:'");
});

test('defaults to the box session when none is given', async () => {
  calls.length = 0;
  captureOut = 'zsh\n$ ';
  const res = await post(boxId, {});
  expect(res.json()).toEqual({ kind: 'shell' });
  expect(calls[0][calls[0].length - 1]).toContain("'=web:'");
});

test('rejects a session name outside SESSION_NAME_RE', async () => {
  expect((await post(boxId, { session: 'bad name' })).statusCode).toBe(400);
});

test('unknown box is 404; a running setup job is 409 and probes nothing', async () => {
  expect((await post('nope', {})).statusCode).toBe(404);
  calls.length = 0; setupRunning = true;
  expect((await post(boxId, {})).statusCode).toBe(409);
  expect(calls).toHaveLength(0);
  setupRunning = false;
});

test('a failed probe is 502', async () => {
  failNext = true;
  const res = await post(boxId, {});
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toMatch(/boom/);
});

test('__local__ classifies the host session through the injected local runner', async () => {
  const res = await post('__local__', {});
  expect(res.json()).toEqual({ kind: 'shell' });
  expect(localCalls).toEqual(['local']);
});

test('unauthenticated is 401', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/pane-kind`, payload: {} });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tmuxInject.test.js test/paneKindRoute.test.js`
Expected: FAIL — `paneKindVia` not exported; route 404.

- [ ] **Step 3: Implement**

`src/server/tmuxInject.js`, after `injectTextVia` (line 275):

```js
// Which flow the pane header's mic should take (spec 2026-09-04): the SAME
// capture and classifier the injectors use, so "links to Claude" and "would
// type here" can never disagree. Never throws — a failed capture is reported,
// not guessed at, because the client treats anything but 'claude' as
// dictation and a guessed 'claude' would arm a link into a shell.
export async function paneKindVia(runScript, session) {
  try {
    const cap = await runScript(buildPaneStateRemote(session));
    if (!cap || cap.code !== 0) return { ok: false, error: String(cap?.stderr || '').trim() || 'pane state failed' };
    return { ok: true, kind: classifyPaneState(parsePaneState(cap.stdout)) };
  } catch (e) {
    return { ok: false, error: e?.message || 'pane state failed' };
  }
}
```

and beside `injectLocalText` (line 304):

```js
export function paneKindLocal(session, { run = runLocalScript } = {}) {
  return paneKindVia(run, session);
}
```

`src/server/boxActions.js`: import `paneKindVia` from `./tmuxInject.js` (the file already imports `injectVia`/`injectTextVia` from it) and add after `injectText`:

```js
    // The mic button's press-time verdict: which flow this pane takes.
    async paneKind(box, session, { timeoutMs = 8000 } = {}) {
      return paneKindVia((script) => runRemote(box, script, timeoutMs), session);
    },
```

`src/server/server.js`: extend the import at line 25 with `paneKindLocal as paneKindLocalDefault`; add `paneKindLocal = paneKindLocalDefault` to the `buildServer` deps (line 121); add the route after `/api/boxes/:id/window` (after line 972):

```js
  // The mic button's press-time verdict (spec 2026-09-04): 'claude' links the
  // browser mic to the box, anything else dictates. Same classifier as
  // dictation's own injection, same 409 gate as /term. __local__ classifies
  // the host's own session.
  app.post('/api/boxes/:id/pane-kind', { preHandler: requireAuth }, async (req, reply) => {
    const id = String(req.params.id);
    const box = id === '__local__' ? null : await store.getBox(id);
    if (id !== '__local__' && !box) return reply.code(404).send({ error: 'box not found' });
    if (box && setupManager?.currentForBox(box.id)?.status === 'running') {
      return reply.code(409).send({ error: 'box setup is still running' });
    }
    const requested = (req.body || {}).session;
    const session = requested === undefined ? (box ? box.sessionName : localSession) : requested;
    if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) {
      return reply.code(400).send({ error: 'session name must be letters, digits, _ or -' });
    }
    const res = box
      ? (boxActions?.paneKind ? await boxActions.paneKind(box, session) : { ok: false, error: 'pane kind unavailable' })
      : await paneKindLocal(session);
    if (!res.ok) return reply.code(502).send({ error: res.error });
    return { kind: res.kind };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tmuxInject.test.js test/paneKindRoute.test.js test/paneRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tmuxInject.js src/server/boxActions.js src/server/server.js test/tmuxInject.test.js test/paneKindRoute.test.js
git commit -m "feat(api): POST /api/boxes/:id/pane-kind — the mic button's press-time verdict"
```

---

### Task 11: `pcmStream.ts` — stateful resampler and framer

**Files:**
- Create: `src/web/pcmStream.ts`
- Test: `test/pcmStream.test.js` (create)

**Interfaces:**
- Produces: `createPcmStream(inputRate, { outRate = 16000, frameBytes = 640 } = {}) → { push(block: Float32Array): Uint8Array[] }`. Each returned frame is exactly `frameBytes` long, little-endian S16 mono at `outRate`; the fractional resampling position and the previous block's last sample carry across `push` calls; the remainder stays buffered. `LINK_RATE = 16000`, `FRAME_BYTES = 640`. Consumed by Task 13 (`voiceRecorder.stream`).

- [ ] **Step 1: Write the failing tests**

```js
// test/pcmStream.test.js
import { test, expect } from 'vitest';
import { createPcmStream, FRAME_BYTES, LINK_RATE } from '../src/web/pcmStream';
import { resampleTo16k } from '../src/web/wavEncode';

function sine(seconds, rate, hz = 440) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
function blocks(samples, size) {
  const out = [];
  for (let i = 0; i < samples.length; i += size) out.push(samples.subarray(i, i + size));
  return out;
}
function s16(frames) {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  const dv = new DataView(all.buffer);
  const v = new Float32Array(all.length / 2);
  for (let i = 0; i < v.length; i++) v[i] = dv.getInt16(i * 2, true) / 32767;
  return v;
}

test('emits whole 640-byte frames and carries the remainder', () => {
  const st = createPcmStream(48000);
  const frames = st.push(sine(0.1, 48000));            // 4800 in → 1600 out samples = 3200 B = 5 frames
  expect(frames.map((f) => f.length)).toEqual([640, 640, 640, 640, 640]);
  expect(FRAME_BYTES).toBe(640);
  expect(LINK_RATE).toBe(16000);
});

test('16 kHz input passes through sample-exact', () => {
  const st = createPcmStream(16000);
  const src = sine(0.04, 16000);                         // 640 samples = 2 frames
  const got = s16(st.push(src));
  expect(got.length).toBe(640);
  for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - src[i])).toBeLessThan(1 / 32767 + 1e-6);
});

test('chunked 48 kHz input matches the whole-buffer resampler with no seam per block', () => {
  const src = sine(0.5, 48000, 1000);
  const ref = resampleTo16k(src, 48000);
  const st = createPcmStream(48000);
  const frames = [];
  for (const b of blocks(src, 128)) frames.push(...st.push(b));   // AudioWorklet block size
  const got = s16(frames);
  expect(got.length).toBeGreaterThanOrEqual(ref.length - 2);
  for (let i = 0; i < got.length && i < ref.length - 1; i++) {
    expect(Math.abs(got[i] - ref[i])).toBeLessThan(2 / 32767);
  }
});

test('44.1 kHz input keeps its fractional phase across blocks', () => {
  const src = sine(0.3, 44100, 700);
  const ref = resampleTo16k(src, 44100);
  const st = createPcmStream(44100);
  const frames = [];
  for (const b of blocks(src, 128)) frames.push(...st.push(b));
  const got = s16(frames);
  for (let i = 0; i < got.length && i < ref.length - 1; i++) {
    expect(Math.abs(got[i] - ref[i])).toBeLessThan(2 / 32767);
  }
});

test('clamps out-of-range samples and never emits an odd byte count', () => {
  const st = createPcmStream(16000);
  const loud = new Float32Array(640).fill(3);
  const frames = st.push(loud);
  const v = s16(frames);
  expect(v.every((x) => x === 1)).toBe(true);
  const st2 = createPcmStream(48000);
  let total = 0;
  for (const b of blocks(sine(0.2, 48000), 100)) for (const f of st2.push(b)) total += f.length;
  expect(total % 640).toBe(0);
});

test('rejects an invalid input rate or frame size', () => {
  expect(() => createPcmStream(0)).toThrow();
  expect(() => createPcmStream(48000, { frameBytes: 641 })).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pcmStream.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/pcmStream.ts
//
// Streaming counterpart of wavEncode.ts for the voice link: Float32 blocks at
// the device rate in, 16 kHz S16 mono frames out, as they arrive. The same
// linear interpolation as resampleTo16k, but stateful — the fractional
// resampling position and the previous block's last sample survive between
// push() calls, so a 128-sample AudioWorklet block boundary produces no seam.
// Frames are a fixed size (20 ms) so the server's per-frame caps and the
// box-side writer's even-length invariant hold by construction.

export const LINK_RATE = 16000;
export const FRAME_BYTES = 640;   // 20 ms of 16 kHz S16 mono

export interface PcmStream {
  push(block: Float32Array): Uint8Array[];
}

export function createPcmStream(inputRate: number, opts: { outRate?: number; frameBytes?: number } = {}): PcmStream {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('invalid input sample rate');
  const outRate = opts.outRate ?? LINK_RATE;
  const frameBytes = opts.frameBytes ?? FRAME_BYTES;
  if (!Number.isInteger(frameBytes) || frameBytes < 2 || frameBytes % 2 !== 0) throw new Error('frameBytes must be a positive even integer');
  const ratio = inputRate / outRate;
  // Position of the next output sample, in input samples, relative to the
  // start of the current block. Index -1 addresses `prev`, the last sample of
  // the previous block, which is how interpolation reaches across the seam.
  let pos = 0;
  let prev = 0;
  let hasPrev = false;
  let pending = new Uint8Array(frameBytes);
  let filled = 0;
  return {
    push(block: Float32Array): Uint8Array[] {
      const frames: Uint8Array[] = [];
      const n = block.length;
      if (n === 0) return frames;
      let p = pos;
      for (;;) {
        const i = Math.floor(p);
        const j = i + 1;
        if (j >= n) break;                 // the next input sample is in the next block
        const frac = p - i;
        const s0 = i < 0 ? (hasPrev ? prev : block[0]) : block[i];
        const s1 = block[j];
        const s = s0 + (s1 - s0) * frac;
        const c = Math.max(-1, Math.min(1, s));
        const v = Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
        pending[filled++] = v & 0xff;
        pending[filled++] = (v >> 8) & 0xff;
        if (filled === frameBytes) {
          frames.push(pending);
          pending = new Uint8Array(frameBytes);
          filled = 0;
        }
        p += ratio;
      }
      pos = p - n;
      prev = block[n - 1];
      hasPrev = true;
      return frames;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pcmStream.test.js && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/pcmStream.ts test/pcmStream.test.js
git commit -m "feat(web): pcmStream — stateful 16 kHz S16 resampler and 20 ms framer for the voice link"
```

---

### Task 12: `voicePress.ts` — the pure press/verdict/release reducer

**Files:**
- Create: `src/web/voicePress.ts`
- Test: `test/voicePress.test.js` (create)

**Interfaces:**
- Produces:
  ```ts
  export type PressState = 'idle' | 'probing' | 'recording' | 'working' | 'linking' | 'live';
  export type PaneKind = 'claude' | 'codex' | 'shell' | 'busy' | 'error';
  export type PressEvent = { t: 'press' } | { t: 'release' } | { t: 'verdict'; kind: PaneKind } | { t: 'ready' } | { t: 'refused' } | { t: 'done' } | { t: 'closed' };
  export type PressEffect = 'startMic' | 'probe' | 'openLink' | 'stream' | 'finishDictation' | 'unlink' | 'stopMic' | 'noticeRefused' | 'noticeClosed';
  export interface PressModel { state: PressState; released: boolean }
  export const IDLE: PressModel;
  export function reducePress(m: PressModel, ev: PressEvent): { model: PressModel; effects: PressEffect[] };
  export function inFlight(state: PressState): boolean;       // state !== 'idle'
  export function endInFlight(state: PressState): PressEvent | null;  // what the hotkey's second press means
  ```
  Consumed by Task 14 (`voiceUi.ts`).

- [ ] **Step 1: Write the failing tests**

```js
// test/voicePress.test.js
import { test, expect } from 'vitest';
import { reducePress, IDLE, inFlight, endInFlight } from '../src/web/voicePress';

const run = (events, start = IDLE) => events.reduce((acc, ev) => {
  const r = reducePress(acc.model, ev);
  return { model: r.model, effects: [...acc.effects, ...r.effects] };
}, { model: start, effects: [] });

test('press starts the mic and the probe', () => {
  const r = reducePress(IDLE, { t: 'press' });
  expect(r.model).toEqual({ state: 'probing', released: false });
  expect(r.effects).toEqual(['startMic', 'probe']);
});

test('claude verdict opens the link; ready streams and goes live; release is ignored while live', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'release' }]);
  expect(r.model.state).toBe('live');
  expect(r.effects).toEqual(['startMic', 'probe', 'openLink', 'stream']);
});

test('a second press while live unlinks and stops the mic', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'press' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['unlink', 'stopMic']);
});

test('a press while still linking unlinks too', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'press' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['unlink', 'stopMic']);
});

test('shell verdict records; release finishes dictation; done returns to idle', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'shell' }, { t: 'release' }, { t: 'done' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects).toEqual(['startMic', 'probe', 'finishDictation']);
});

test('release before a non-claude verdict finishes dictation the moment the verdict lands', () => {
  for (const kind of ['shell', 'busy', 'codex', 'error']) {
    const r = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind }]);
    expect(r.model.state).toBe('working');
    expect(r.effects).toEqual(['startMic', 'probe', 'finishDictation']);
  }
});

test('release before a claude verdict still links (a tap)', () => {
  const r = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }]);
  expect(r.model.state).toBe('live');
  expect(r.effects).toEqual(['startMic', 'probe', 'openLink', 'stream']);
});

test('a refused link continues as dictation: recording if still held, finishing if already released', () => {
  const held = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'refused' }]);
  expect(held.model.state).toBe('recording');
  expect(held.effects.slice(-1)).toEqual(['noticeRefused']);
  const released = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind: 'claude' }, { t: 'refused' }]);
  expect(released.model.state).toBe('working');
  expect(released.effects.slice(-2)).toEqual(['noticeRefused', 'finishDictation']);
  const closedEarly = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'closed' }]);
  expect(closedEarly.model.state).toBe('recording');
});

test('the link closing while live stops the mic and says so', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'closed' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['stopMic', 'noticeClosed']);
});

test('stray events are inert', () => {
  for (const [state, ev] of [
    ['idle', { t: 'release' }], ['idle', { t: 'ready' }], ['idle', { t: 'done' }], ['idle', { t: 'closed' }],
    ['probing', { t: 'press' }], ['probing', { t: 'ready' }], ['probing', { t: 'done' }],
    ['recording', { t: 'press' }], ['recording', { t: 'ready' }], ['recording', { t: 'verdict', kind: 'claude' }],
    ['working', { t: 'press' }], ['working', { t: 'release' }], ['working', { t: 'closed' }],
    ['live', { t: 'release' }], ['live', { t: 'verdict', kind: 'shell' }], ['live', { t: 'ready' }],
  ]) {
    const m = { state, released: false };
    const r = reducePress(m, ev);
    expect(r.model).toEqual(m);
    expect(r.effects).toEqual([]);
  }
});

test('inFlight and endInFlight give the hotkey its toggle', () => {
  expect(inFlight('idle')).toBe(false);
  for (const s of ['probing', 'recording', 'working', 'linking', 'live']) expect(inFlight(s)).toBe(true);
  expect(endInFlight('probing')).toEqual({ t: 'release' });
  expect(endInFlight('recording')).toEqual({ t: 'release' });
  expect(endInFlight('linking')).toEqual({ t: 'press' });
  expect(endInFlight('live')).toEqual({ t: 'press' });
  expect(endInFlight('working')).toBeNull();
  expect(endInFlight('idle')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voicePress.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/voicePress.ts
//
// The one 🎤 button's decision logic (spec 2026-09-04), as a pure reducer so
// every ordering of press, release, verdict, ready, refused and closed is a
// unit test rather than a race in a browser. The controller in voiceUi.ts
// owns the side effects the reducer names.
//
//   idle ─press─▶ probing ─verdict(claude)─▶ linking ─ready─▶ live
//                    │                          │refused         │press/closed
//                    └verdict(other)─▶ recording ─release─▶ working ─done─▶ idle
//
// `released` remembers a release that lands before the verdict: a Claude pane
// still links (the press was a tap), anything else finishes dictation at
// once. A refused link falls back to dictation with the audio the recorder
// buffered while the link was attempted — nothing said is lost.

export type PressState = 'idle' | 'probing' | 'recording' | 'working' | 'linking' | 'live';
export type PaneKind = 'claude' | 'codex' | 'shell' | 'busy' | 'error';
export type PressEvent =
  | { t: 'press' }
  | { t: 'release' }
  | { t: 'verdict'; kind: PaneKind }
  | { t: 'ready' }
  | { t: 'refused' }
  | { t: 'done' }
  | { t: 'closed' };
export type PressEffect =
  | 'startMic' | 'probe' | 'openLink' | 'stream' | 'finishDictation'
  | 'unlink' | 'stopMic' | 'noticeRefused' | 'noticeClosed';
export interface PressModel { state: PressState; released: boolean }

export const IDLE: PressModel = { state: 'idle', released: false };

const same = (m: PressModel) => ({ model: m, effects: [] as PressEffect[] });
const to = (state: PressState, released: boolean, effects: PressEffect[]) => ({ model: { state, released }, effects });

export function reducePress(m: PressModel, ev: PressEvent): { model: PressModel; effects: PressEffect[] } {
  switch (m.state) {
    case 'idle':
      return ev.t === 'press' ? to('probing', false, ['startMic', 'probe']) : same(m);
    case 'probing':
      if (ev.t === 'release') return to('probing', true, []);
      if (ev.t === 'verdict') {
        if (ev.kind === 'claude') return to('linking', m.released, ['openLink']);
        return m.released ? to('working', true, ['finishDictation']) : to('recording', false, []);
      }
      return same(m);
    case 'recording':
      return ev.t === 'release' ? to('working', true, ['finishDictation']) : same(m);
    case 'working':
      return ev.t === 'done' ? to('idle', false, []) : same(m);
    case 'linking':
      if (ev.t === 'release') return to('linking', true, []);
      if (ev.t === 'press') return to('idle', false, ['unlink', 'stopMic']);
      if (ev.t === 'ready') return to('live', m.released, ['stream']);
      if (ev.t === 'refused' || ev.t === 'closed') {
        return m.released ? to('working', true, ['noticeRefused', 'finishDictation']) : to('recording', false, ['noticeRefused']);
      }
      return same(m);
    case 'live':
      if (ev.t === 'press') return to('idle', false, ['unlink', 'stopMic']);
      if (ev.t === 'closed') return to('idle', false, ['stopMic', 'noticeClosed']);
      return same(m);
  }
}

export function inFlight(state: PressState): boolean { return state !== 'idle'; }

// The hotkey's second press ends whatever is in flight: a held/probing
// recording is released, a link is unlinked, a transcription in progress is
// left alone.
export function endInFlight(state: PressState): PressEvent | null {
  if (state === 'probing' || state === 'recording') return { t: 'release' };
  if (state === 'linking' || state === 'live') return { t: 'press' };
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voicePress.test.js && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/voicePress.ts test/voicePress.test.js
git commit -m "feat(web): voicePress reducer — press/verdict/release/ready/refused/closed as pure state"
```

---

### Task 13: `voiceLink.ts` client and `api.paneKind`

**Files:**
- Create: `src/web/voiceLink.ts`
- Modify: `src/web/api.ts` (add `paneKind` beside `postVoice`, ~line 361)
- Test: `test/voiceLinkClient.test.js` (create)

**Interfaces:**
- Produces:
  ```ts
  export const LINK_MAX_MS = 30 * 60 * 1000;
  export type LinkCloseWhy = 'closed' | 'superseded' | 'not-set-up' | 'writer-failed' | 'stalled' | 'cap' | 'hidden' | 'unauthorized' | 'setting-up';
  export function closeReason(code: number, reason: string): LinkCloseWhy;
  export function voiceLinkUrl(boxId: string, loc: { protocol: string; host: string }): string;
  export interface VoiceLink { send(frame: Uint8Array): void; close(): void }
  export interface LinkSocket { readyState: number; send(d: Uint8Array | string): void; close(code?: number, reason?: string): void; addEventListener(type: string, fn: (ev: any) => void): void }
  export function openVoiceLink(boxId: string, onClose: (why: LinkCloseWhy) => void, deps?: { makeSocket?: (url: string) => LinkSocket; doc?: { visibilityState: string; addEventListener: Function; removeEventListener: Function } | null; maxMs?: number; loc?: { protocol: string; host: string } }): Promise<VoiceLink>;
  ```
  `openVoiceLink` resolves on the server's `ready` frame; rejects before it with an `Error` whose `.why` is the `LinkCloseWhy`; after `ready`, any close not initiated by `close()` calls `onClose(why)` exactly once. `api.paneKind(boxId, session?) → Promise<{ kind }>`.

- [ ] **Step 1: Write the failing tests**

```js
// test/voiceLinkClient.test.js
import { test, expect } from 'vitest';
import { openVoiceLink, closeReason, voiceLinkUrl, LINK_MAX_MS } from '../src/web/voiceLink';

// A minimal WebSocket stand-in: the client only uses addEventListener, send,
// close and readyState.
function fakeSocket() {
  const ls = {};
  const s = {
    readyState: 0, sent: [], closes: [],
    addEventListener: (t, fn) => { (ls[t] ||= []).push(fn); },
    send: (d) => s.sent.push(d),
    close: (code, reason) => { s.closes.push([code, reason]); },
    emit: (t, ev) => { for (const fn of ls[t] || []) fn(ev); },
    open() { s.readyState = 1; s.emit('open', {}); },
    ready() { s.emit('message', { data: 'ready' }); },
    closed(code, reason = '') { s.readyState = 3; s.emit('close', { code, reason }); },
  };
  return s;
}
const loc = { protocol: 'https:', host: 'tmuxifier.example.com' };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('voiceLinkUrl follows the page scheme and encodes the box id', () => {
  expect(voiceLinkUrl('b 1', loc)).toBe('wss://tmuxifier.example.com/voice-link?box=b%201');
  expect(voiceLinkUrl('__local__', { protocol: 'http:', host: '127.0.0.1:7437' })).toBe('ws://127.0.0.1:7437/voice-link?box=__local__');
});

test('closeReason maps the server codes', () => {
  expect(closeReason(4001, '')).toBe('superseded');
  expect(closeReason(4002, '')).toBe('not-set-up');
  expect(closeReason(4003, '')).toBe('writer-failed');
  expect(closeReason(4004, '')).toBe('stalled');
  expect(closeReason(1008, 'setting up')).toBe('setting-up');
  expect(closeReason(1008, 'unauthorized')).toBe('unauthorized');
  expect(closeReason(1006, '')).toBe('closed');
  expect(LINK_MAX_MS).toBe(30 * 60 * 1000);
});

test('resolves on ready, forwards frames only after it, and reports a later close once', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open();
  s.ready();
  const link = await p;
  const frame = new Uint8Array(640);
  link.send(frame);
  expect(s.sent).toEqual([frame]);
  s.closed(4004, 'stalled');
  s.closed(4004, 'stalled');
  expect(closes).toEqual(['stalled']);
  link.send(frame);
  expect(s.sent).toHaveLength(1);
});

test('a close before ready rejects with the reason and never calls onClose', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open();
  s.closed(4002, 'not-set-up');
  await expect(p).rejects.toMatchObject({ why: 'not-set-up' });
  expect(closes).toEqual([]);
});

test('close() by the caller closes the socket and does not report', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open(); s.ready();
  const link = await p;
  link.close();
  expect(s.closes).toEqual([[1000, 'unlink']]);
  s.closed(1000, '');
  expect(closes).toEqual([]);
});

test('the 30-minute cap and a hidden tab both unlink, reporting why', async () => {
  const a = fakeSocket();
  const aw = [];
  const pa = openVoiceLink('b1', (w) => aw.push(w), { makeSocket: () => a, doc: null, loc, maxMs: 30 });
  a.open(); a.ready(); await pa;
  await tick(60);
  expect(aw).toEqual(['cap']);
  expect(a.closes[0][1]).toBe('cap');

  const handlers = {};
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => { handlers[t] = fn; }, removeEventListener: (t) => { delete handlers[t]; } };
  const b = fakeSocket();
  const bw = [];
  const pb = openVoiceLink('b1', (w) => bw.push(w), { makeSocket: () => b, doc, loc });
  b.open(); b.ready(); const link = await pb;
  doc.visibilityState = 'hidden';
  handlers.visibilitychange();
  expect(bw).toEqual(['hidden']);
  expect(handlers.visibilitychange).toBeUndefined();
  link.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voiceLinkClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/web/voiceLink.ts
//
// The browser end of a voice link (spec 2026-09-04): one WebSocket per linked
// pane carrying 640-byte 16 kHz S16 frames to /voice-link. Resolves once the
// server says `ready` (the box-side writer stayed alive), so the caller keeps
// buffering for dictation until then and loses nothing on a refusal. After
// ready, every close the caller did not ask for is reported once through
// onClose — the server's codes, the 30-minute cap, and a hidden tab.
// Sockets do not pass through http.ts's 401 seam, so an auth refusal (1008)
// is reported here as 'unauthorized' for the controller to surface.

export const LINK_MAX_MS = 30 * 60 * 1000;

export type LinkCloseWhy = 'closed' | 'superseded' | 'not-set-up' | 'writer-failed' | 'stalled' | 'cap' | 'hidden' | 'unauthorized' | 'setting-up';

export function closeReason(code: number, reason: string): LinkCloseWhy {
  if (code === 4001) return 'superseded';
  if (code === 4002) return 'not-set-up';
  if (code === 4003) return 'writer-failed';
  if (code === 4004) return 'stalled';
  if (code === 1008) return reason === 'setting up' ? 'setting-up' : 'unauthorized';
  return 'closed';
}

export function voiceLinkUrl(boxId: string, loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}/voice-link?box=${encodeURIComponent(boxId)}`;
}

export interface VoiceLink { send(frame: Uint8Array): void; close(): void }

export interface LinkSocket {
  readyState: number;
  send(d: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}

interface DocLike {
  visibilityState: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface VoiceLinkDeps {
  makeSocket?: (url: string) => LinkSocket;
  doc?: DocLike | null;
  maxMs?: number;
  loc?: { protocol: string; host: string };
}

export function openVoiceLink(boxId: string, onClose: (why: LinkCloseWhy) => void, deps: VoiceLinkDeps = {}): Promise<VoiceLink> {
  return new Promise<VoiceLink>((resolve, reject) => {
    const loc = deps.loc ?? (typeof location !== 'undefined' ? location : { protocol: 'http:', host: '' });
    const ws = (deps.makeSocket ?? ((u: string) => new WebSocket(u) as unknown as LinkSocket))(voiceLinkUrl(boxId, loc));
    const doc = deps.doc === undefined ? (typeof document !== 'undefined' ? (document as unknown as DocLike) : null) : deps.doc;
    let ready = false;
    let done = false;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const onVis = (): void => {
      if (doc?.visibilityState === 'hidden') { try { ws.close(1000, 'hidden'); } catch { /* closing */ } finish('hidden'); }
    };
    const teardown = (): void => {
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
      doc?.removeEventListener('visibilitychange', onVis);
    };
    const finish = (why: LinkCloseWhy): void => {
      if (done) return;
      done = true;
      teardown();
      if (ready) onClose(why);
      else reject(Object.assign(new Error(`voice link ${why}`), { why }));
    };
    const link: VoiceLink = {
      send(frame) { if (ready && !done && ws.readyState === 1) ws.send(frame); },
      close() {
        if (done) return;
        done = true;
        teardown();
        try { ws.close(1000, 'unlink'); } catch { /* already closed */ }
      },
    };
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (ready || done || ev.data !== 'ready') return;
      ready = true;
      capTimer = setTimeout(() => { try { ws.close(1000, 'cap'); } catch { /* closing */ } finish('cap'); }, deps.maxMs ?? LINK_MAX_MS);
      doc?.addEventListener('visibilitychange', onVis);
      resolve(link);
    });
    ws.addEventListener('close', (ev: { code: number; reason: string }) => finish(closeReason(ev.code, ev.reason)));
    ws.addEventListener('error', () => { /* a close event follows */ });
  });
}
```

`src/web/api.ts`, after `postVoice`:

```ts
  // The mic button's press-time verdict (POST /api/boxes/:id/pane-kind).
  // `session` is omitted for __local__: the server classifies its own host
  // session there.
  async paneKind(boxId: string, session?: string) {
    return j<{ kind: 'claude' | 'codex' | 'shell' | 'busy' }>(
      await fetch(`/api/boxes/${encodeURIComponent(boxId)}/pane-kind`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session ? { session } : {}),
      }));
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voiceLinkClient.test.js test/webHttp.test.js && npm run typecheck`
Expected: PASS (`webHttp.test.js` confirms `api.ts` still routes through `j`); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/voiceLink.ts src/web/api.ts test/voiceLinkClient.test.js
git commit -m "feat(web): voice-link client (ready handshake, close reasons, cap, hidden-tab unlink) and api.paneKind"
```

---

### Task 14: The one 🎤 button — recorder stream mode, controller, wiring, and the live state

**Files:**
- Modify: `src/web/voiceRecorder.ts` (interface line 12; `start()` line 40; add `stream`)
- Modify: `src/web/voiceUi.ts` (`VoiceHost` line 118; `createVoiceController` line 128; `wireVoice` line 290)
- Modify: `src/web/terminal.ts` (options line 441; `wireVoice` call line 484; return handle line 577)
- Modify: `src/web/main.ts` (`ensureTab` line 813; a `paneVoiceHint` helper beside `attachedSession` line 861; the header-refresh path)
- Modify: `src/web/style.css` (after line 1346; after line 2162)
- Test: `test/voiceUi.test.js` (modify + append)

**Interfaces:**
- Consumes: `createPcmStream` (Task 11), `reducePress`/`IDLE`/`inFlight`/`endInFlight` (Task 12), `openVoiceLink`/`VoiceLink`/`LinkCloseWhy` (Task 13), `api.paneKind` (Task 13).
- Produces:
  - `VoiceRecorder` gains `stream(sink: (frame: Uint8Array) => void): void` (discards the buffer, clears the auto-stop cap, sends 640-byte frames as they are produced).
  - `VoiceHost` gains `session?(): string | undefined` and `hint?(): 'claude' | null`.
  - `createVoiceController(boxId, maxSeconds, host, makeRecorder = createVoiceRecorder, deps: { probe?, openLink?, dictationEnabled? } = {})` returns `{ begin(), release(), finish(), blur(), recording(), cancel(), refreshHint(), mount(parent, verdict), dispose() }`.
  - `idleTitle(hint, dictationEnabled)` exported for tests.
  - `wireVoice(parent, boxId, host)` returns `{ ready(), recording(), begin(), finish(), refreshHint(), dispose() }` and mounts the button whether or not whisper is enabled.
  - `openTerminal` options gain `voiceSession?: () => string | undefined` and `voiceHint?: () => 'claude' | null`; its handle gains `refreshHint()`.
  - Button `data-state` values: `idle` | `working` | `recording` | `live`.

- [ ] **Step 1: Write the failing tests**

In `test/voiceUi.test.js`, first find the existing test asserting that no button mounts when `uiConfig.voice` is false (search for `voice: false` near a `createElement` counter) and change its expectation: the button now mounts, disabled only when the readiness verdict fails, and its idle title says dictation is off. Then append:

```js
import { idleTitle } from '../src/web/voiceUi';

// A fake recorder that also supports the link's stream mode.
function streamRecorder() {
  const r = { started: 0, cancelled: 0, streamed: null, start: async () => { r.started++; }, stop: async () => new ArrayBuffer(45), cancel() { r.cancelled++; }, recording: () => true, stream(sink) { r.streamed = sink; } };
  return r;
}
function fakeLink() {
  const l = { sent: [], closed: 0, send: (f) => l.sent.push(f), close() { l.closed++; } };
  return l;
}
const noopHost = { write() {}, copy() {}, focus() {} };
const flush = () => new Promise((r) => setTimeout(r, 0));

test('idleTitle names the flow a press will take', () => {
  expect(idleTitle('claude', true)).toMatch(/link your mic to Claude Code/i);
  expect(idleTitle(null, true)).toMatch(/hold to dictate/i);
  expect(idleTitle(null, false)).toMatch(/not enabled/i);
  expect(idleTitle('claude', false)).toMatch(/link your mic/i);
});

test('a claude verdict links: the link opens, ready streams the recorder, the button reads live, a second press unlinks', async () => {
  stubDocument();
  const rec = streamRecorder();
  const link = fakeLink();
  let closeCb;
  const opened = [];
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'proj' }, () => rec, {
    probe: async (boxId, session) => { opened.push(['probe', boxId, session]); return 'claude'; },
    openLink: async (boxId, onClose) => { opened.push(['link', boxId]); closeCb = onClose; return link; },
    dictationEnabled: true,
  });
  const btn = {};
  c.mount({ appendChild: (b) => Object.assign(btn, b) }, { ok: true, reason: '', hint: '' });
  c.begin();
  await flush(); await flush();
  expect(opened).toEqual([['probe', 'box1', 'proj'], ['link', 'box1']]);
  expect(typeof rec.streamed).toBe('function');
  expect(c.recording()).toBe(true);
  rec.streamed(new Uint8Array(640));
  expect(link.sent).toHaveLength(1);
  c.release();                       // ignored while live
  expect(c.recording()).toBe(true);
  c.begin();                         // second press = unlink
  expect(link.closed).toBe(1);
  expect(rec.cancelled).toBe(1);
  expect(c.recording()).toBe(false);
  expect(typeof closeCb).toBe('function');
});

test('a refused link continues as dictation with the buffered audio and says why', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'kept words', injected: true, mode: 'claude' }) }; };
  const rec = streamRecorder();
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'claude',
    openLink: async () => { throw Object.assign(new Error('voice link not-set-up'), { why: 'not-set-up' }); },
    dictationEnabled: true,
  });
  c.begin();
  c.release();
  await flush(); await flush(); await flush();
  expect(writes.join('')).toMatch(/box not set up/);
  expect(writes.join('')).toMatch(/dictating instead/);
  expect(urls[0]).toContain('/api/voice?box=box1');
  expect(rec.streamed).toBeNull();
});

test('a non-claude verdict is today\'s dictation, and a release before the verdict finishes once it lands', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi', injected: true, mode: 'shell' }) }; };
  const rec = streamRecorder();
  let resolveVerdict;
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: () => new Promise((r) => { resolveVerdict = r; }),
    openLink: async () => { throw new Error('must not link'); },
    dictationEnabled: true,
  });
  c.begin();
  c.release();
  await flush();
  expect(urls).toEqual([]);
  resolveVerdict('shell');
  await flush(); await flush(); await flush();
  expect(urls).toHaveLength(1);
});

test('with whisper off a non-claude press explains itself instead of posting', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }; };
  const rec = streamRecorder();
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'shell', openLink: async () => fakeLink(), dictationEnabled: false,
  });
  c.begin(); c.release();
  await flush(); await flush(); await flush();
  expect(fetched).toBe(0);
  expect(writes.join('')).toMatch(/not enabled/);
  expect(rec.cancelled).toBe(1);
});

test('blur finishes a dictation but never unlinks a live link; dispose closes it', async () => {
  const rec = streamRecorder();
  const link = fakeLink();
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async () => link, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  expect(c.recording()).toBe(true);
  c.blur();
  expect(link.closed).toBe(0);
  expect(c.recording()).toBe(true);
  c.dispose();
  expect(link.closed).toBe(1);
});

test('the server closing a live link stops the mic and reports the reason', async () => {
  const rec = streamRecorder();
  let onClose;
  const writes = [];
  const c = createVoiceController('box1', 120, { ...noopHost, write: (t) => writes.push(t), session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async (_b, cb) => { onClose = cb; return fakeLink(); }, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  onClose('superseded');
  expect(c.recording()).toBe(false);
  expect(rec.cancelled).toBe(1);
  expect(writes.join('')).toMatch(/another pane/);
});

test('finish() ends whatever is in flight: release for a recording, unlink for a link', async () => {
  const rec = streamRecorder();
  const link = fakeLink();
  const c = createVoiceController('box1', 120, { ...noopHost, session: () => 'web' }, () => rec, {
    probe: async () => 'claude', openLink: async () => link, dictationEnabled: true,
  });
  c.begin();
  await flush(); await flush();
  c.finish();
  expect(link.closed).toBe(1);
  expect(c.recording()).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voiceUi.test.js`
Expected: FAIL — `idleTitle` not exported; `release` is not a function; the changed voice-off expectation.

- [ ] **Step 3: `voiceRecorder.ts` — stream mode**

Extend the interface and implementation:

```ts
import { createPcmStream } from './pcmStream';

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
  recording(): boolean;
  // Voice link: from now on, frames go to `sink` as they are produced and the
  // dictation buffer is dropped; the auto-stop cap no longer applies (the link
  // has its own 30-minute cap).
  stream(sink: (frame: Uint8Array) => void): void;
}
```

Inside `createVoiceRecorder`, add the method to the returned object:

```ts
    stream(sink: (frame: Uint8Array) => void): void {
      if (!node) return;
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
      chunks = [];
      const pcm = createPcmStream(rate || 48000);
      node.port.onmessage = (e: MessageEvent) => { for (const f of pcm.push(e.data as Float32Array)) sink(f); };
    },
```

- [ ] **Step 4: `voiceUi.ts` — the controller around the reducer**

Replace the `VoiceHost` interface and the whole `createVoiceController` + `wireVoice` with the version below. Keep `evaluateVoice`, `isVoiceHotkey`, `isVoiceHotkeyChordKey`, `VoiceHotkeyTarget`, `createVoiceHotkeyHandler`, and `detectVoiceEnv` exactly as they are — the hotkey handler's `finish()`-if-`recording()`-else-`begin()` toggle is what `endInFlight` was written for.

```ts
import { api } from './api';
import { createVoiceRecorder, type VoiceRecorder } from './voiceRecorder';
import { termSafe } from './upload';
import { reducePress, IDLE, inFlight, endInFlight, type PressModel, type PressEvent, type PressEffect, type PaneKind } from './voicePress';
import { openVoiceLink, type VoiceLink, type LinkCloseWhy } from './voiceLink';

export interface VoiceHost {
  write(text: string): void;      // echo status into the terminal
  copy(text: string): void;       // clipboard fallback when a pane is busy
  focus(): void;                  // return keyboard focus to the terminal
  sink?(): ((text: string) => void) | null;   // phone composer draft (dictation only)
  // The session THIS pane is attached to (per-pane since duplicate panes);
  // undefined for the Host Shell, whose session the server names itself.
  session?(): string | undefined;
  // Pre-press hint from the status snapshot's paneCmd — the idle tooltip
  // only. The press-time verdict (POST pane-kind) decides.
  hint?(): 'claude' | null;
}

export interface VoiceControllerDeps {
  probe?: (boxId: string, session: string | undefined) => Promise<PaneKind>;
  openLink?: (boxId: string, onClose: (why: LinkCloseWhy) => void) => Promise<VoiceLink>;
  dictationEnabled?: boolean;   // whisper.cpp usable on this server
}

const PROBE_MS = 1500;

// Never blocks dictation on a slow box: a probe that misses the window reads
// as 'error', which the reducer treats like any non-claude verdict.
async function probeDefault(boxId: string, session: string | undefined): Promise<PaneKind> {
  const timeout = new Promise<PaneKind>((r) => setTimeout(() => r('error'), PROBE_MS));
  const ask = api.paneKind(boxId, session).then((r) => r.kind as PaneKind).catch((): PaneKind => 'error');
  return Promise.race([ask, timeout]);
}

export function idleTitle(hint: 'claude' | null, dictationEnabled: boolean): string {
  if (hint === 'claude') return 'Tap to link your mic to Claude Code (then hold Space in the pane)';
  if (!dictationEnabled) return 'Dictation is not enabled on this server (npm run setup-voice); tap on a Claude Code pane to link your mic';
  return 'Hold to dictate (or tap Ctrl+Shift+Space to start/stop)';
}

function refusedText(why: string): string {
  if (why === 'not-set-up') return 'box not set up — run setup with Claude Code ticked';
  if (why === 'setting-up') return 'box setup is running';
  if (why === 'writer-failed') return 'the box-side writer failed';
  if (why === 'unauthorized') return 'session expired';
  return why;
}

function closedText(why: string): string {
  if (why === 'superseded') return 'unlinked — linked from another pane';
  if (why === 'stalled') return 'unlinked — audio stalled';
  if (why === 'cap') return 'off after 30 min';
  if (why === 'hidden') return 'unlinked — tab hidden';
  if (why === 'writer-failed') return 'unlinked — the box-side writer died';
  return 'unlinked';
}

// Owns one recorder, at most one link, and the button element. The reducer in
// voicePress.ts decides; this runs its effects. makeRecorder/probe/openLink
// are injectable so tests drive every ordering with fakes.
export function createVoiceController(
  boxId: string,
  maxSeconds: number,
  host: VoiceHost,
  makeRecorder: (maxSeconds: number, onAutoStop: () => void) => VoiceRecorder = createVoiceRecorder,
  deps: VoiceControllerDeps = {},
) {
  const probe = deps.probe ?? probeDefault;
  const openLink = deps.openLink ?? ((id, onClose) => openVoiceLink(id, onClose));
  const dictationEnabled = deps.dictationEnabled !== false;
  let model: PressModel = IDLE;
  let recorder: VoiceRecorder | null = null;
  let link: VoiceLink | null = null;
  let refusedWhy = 'closed';
  let closedWhy = 'closed';
  let button: HTMLButtonElement | null = null;

  function paint(): void {
    if (!button) return;
    const s = model.state;
    const ds = s === 'idle' ? 'idle' : s === 'recording' ? 'recording' : s === 'live' ? 'live' : 'working';
    button.dataset.state = ds;
    button.textContent = s === 'recording' ? '● rec' : s === 'live' ? '● live' : s === 'idle' ? '🎤' : '… ';
    button.title = s === 'idle' ? idleTitle(host.hint?.() ?? null, dictationEnabled)
      : s === 'recording' ? 'Release to transcribe (or tap Ctrl+Shift+Space to stop)'
      : s === 'live' ? 'Linked to Claude Code — hold Space in the pane to talk. Tap to unlink.'
      : 'Working…';
    // The visible label is a glyph — mirror the tooltip into the accessible
    // name so the state change is announced, not just painted.
    button.setAttribute('aria-label', button.title);
  }

  function dispatch(ev: PressEvent): void {
    const r = reducePress(model, ev);
    model = r.model;
    paint();
    for (const fx of r.effects) run(fx);
  }

  function startMic(): void {
    const r = makeRecorder(maxSeconds, () => {
      // The dictation cap: transcribe what was captured rather than lose it.
      if (model.state === 'probing' || model.state === 'recording') dispatch({ t: 'release' });
    });
    recorder = r;
    void r.start().then(() => {
      // finish()/cancel()/dispose() already ran while getUserMedia's prompt
      // was up: release the mic through the still-live local reference.
      if (recorder !== r) r.cancel();
    }).catch((e) => {
      r.cancel();
      if (recorder !== r) return;
      recorder = null;
      link?.close(); link = null;
      model = IDLE;
      paint();
      host.write(`\r\n\x1b[33m[voice: ${termSafe((e as Error).message || 'microphone unavailable')}]\x1b[0m\r\n`);
    });
  }

  function openLinkNow(): void {
    void openLink(boxId, (why) => {
      closedWhy = why;
      if (model.state === 'live') dispatch({ t: 'closed' });
    }).then((l) => {
      if (model.state !== 'linking') { l.close(); return; }   // unlinked while connecting
      link = l;
      dispatch({ t: 'ready' });
    }).catch((e) => {
      refusedWhy = (e as { why?: string })?.why ?? 'closed';
      if (model.state === 'linking') dispatch({ t: 'refused' });
    });
  }

  async function finishDictation(): Promise<void> {
    const r = recorder;
    recorder = null;
    // Bound at finish-time, not delivery-time: if the composer closes during
    // the round trip, the text still lands in the draft it was dictated for.
    const sink = host.sink?.() ?? null;
    try {
      if (!r) return;
      if (!dictationEnabled) {
        r.cancel();
        host.write('\r\n\x1b[33m[voice: dictation is not enabled on this server — run npm run setup-voice]\x1b[0m\r\n');
        return;
      }
      const wav = await r.stop();
      // A 44-byte WAV is header-only: nothing was captured, skip the round trip.
      if (wav.byteLength <= 44) return;
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }), sink ? { inject: false } : undefined);
      if (sink) {
        if (res.text) sink(res.text);
        else host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.text) {
        host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.injected) {
        // A refused injection must never cost the user what they said.
        host.copy(res.text);
        const why = res.mode === 'busy' ? 'pane busy — transcript copied to clipboard' : 'injection failed — transcript copied to clipboard';
        host.write(`\r\n\x1b[33m[voice: ${why}]\x1b[0m\r\n`);
      }
    } catch (e) {
      host.write(`\r\n\x1b[33m[voice failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
    } finally {
      dispatch({ t: 'done' });
      // Hand focus back to the terminal so Enter submits what was dictated;
      // on the sink path focus must STAY on the composer field.
      if (!sink) host.focus();
    }
  }

  function run(fx: PressEffect): void {
    switch (fx) {
      case 'startMic': startMic(); break;
      case 'probe':
        void probe(boxId, host.session?.()).then((kind) => { if (model.state === 'probing') dispatch({ t: 'verdict', kind }); });
        break;
      case 'openLink': openLinkNow(); break;
      case 'stream': recorder?.stream((f) => link?.send(f)); break;
      case 'finishDictation': void finishDictation(); break;
      case 'unlink': link?.close(); link = null; break;
      case 'stopMic': recorder?.cancel(); recorder = null; host.focus(); break;
      case 'noticeRefused': host.write(`\r\n\x1b[33m[voice link: ${termSafe(refusedText(refusedWhy))}; dictating instead]\x1b[0m\r\n`); break;
      case 'noticeClosed': host.write(`\r\n\x1b[2m[voice link: ${termSafe(closedText(closedWhy))}]\x1b[0m\r\n`); break;
    }
  }

  const begin = (): void => { dispatch({ t: 'press' }); };
  const release = (): void => { dispatch({ t: 'release' }); };
  const cancel = (): void => { link?.close(); link = null; recorder?.cancel(); recorder = null; model = IDLE; paint(); };

  return {
    begin,
    release,
    // End whatever is in flight — the hotkey's second press.
    finish(): void { const ev = endInFlight(model.state); if (ev) dispatch(ev); },
    // Focus loss ends a dictation (privacy: a hidden tab with a live mic and
    // nobody watching) but never a link: the live state is persistent in the
    // header and the browser's own mic indicator is showing.
    blur(): void { if (model.state === 'probing' || model.state === 'recording') dispatch({ t: 'release' }); },
    recording(): boolean { return inFlight(model.state); },
    cancel,
    refreshHint(): void { if (model.state === 'idle') paint(); },
    mount(parent: HTMLElement, verdict: VoiceVerdict): void {
      button = document.createElement('button');
      button.className = 'voice-btn';
      button.type = 'button';
      paint();
      if (!verdict.ok) {
        button.disabled = true;
        button.title = `${verdict.reason} ${verdict.hint}`.trim();
        button.setAttribute('aria-label', button.title);
      } else {
        // Pointer events, not mouse events (touch fires the compatibility
        // mouse pair back-to-back after touchend). preventDefault keeps DOM
        // focus on the terminal for the whole hold and suppresses that pair.
        button.addEventListener('pointerdown', (ev) => { ev.preventDefault(); begin(); });
        button.addEventListener('pointerup', () => release());
        button.addEventListener('pointerleave', () => release());
        // Touch-only: pointercancel instead of pointerup when the browser
        // takes the gesture over (a scroll started from the button).
        button.addEventListener('pointercancel', () => release());
      }
      parent.appendChild(button);
    },
    dispose(): void { cancel(); button?.remove(); button = null; },
  };
}

// Attaches to the terminal's parent and returns something whose dispose()
// the caller folds into its own. The button mounts whether or not whisper is
// installed: a Claude pane links with nothing on this host, and a non-Claude
// press with whisper off explains itself (see finishDictation).
export function wireVoice(parent: HTMLElement, boxId: string, host: VoiceHost) {
  let controller: ReturnType<typeof createVoiceController> | null = null;
  let disposed = false;
  let verdictOk = false;

  void api.uiConfig().then((cfg) => {
    if (disposed || !cfg) return;
    const verdict = evaluateVoice(detectVoiceEnv(true));
    controller = createVoiceController(boxId, cfg.voiceMaxSeconds ?? 120, host, createVoiceRecorder, { dictationEnabled: !!cfg.voice });
    controller.mount(parent, verdict);
    verdictOk = verdict.ok;
  }).catch(() => {});

  const onBlur = (): void => { controller?.blur(); };
  if (typeof window !== 'undefined') window.addEventListener('blur', onBlur);

  return {
    ready(): boolean { return controller !== null && verdictOk; },
    recording(): boolean { return controller?.recording() ?? false; },
    begin(): void { controller?.begin(); },
    finish(): void { controller?.finish(); },
    refreshHint(): void { controller?.refreshHint(); },
    dispose(): void {
      disposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
      controller?.dispose();
      controller = null;
    },
  };
}
```

- [ ] **Step 5: `terminal.ts` and `main.ts` wiring**

`src/web/terminal.ts` options (line 441–448): add

```ts
    // Voice link (spec 2026-09-04): the session this pane is attached to (for
    // the press-time pane-kind probe; undefined = the server's own default)
    // and the status-snapshot hint that paints the idle tooltip.
    voiceSession?: () => string | undefined; voiceHint?: () => 'claude' | null;
```

`wireVoice` call (line 484): add `session: opts?.voiceSession, hint: opts?.voiceHint,` to the host object. Return handle (line 577): add `refreshHint: () => voice.refreshHint(),`.

`src/web/main.ts`: beside `attachedSession` (line 861) add

```ts
// Pre-press hint for the mic: the status snapshot already carries each
// session's active-pane command (paneCmd), so the idle tooltip can say which
// flow a press will take. A hint only, up to 30 s stale — the press-time
// verdict (POST pane-kind) decides. The Host Shell has no status entry.
function paneVoiceHint(iid: string): 'claude' | null {
  if (isLocalPane(iid)) return null;
  const s = latestStatus[boxOfInstance(iid)]?.sessions?.find((x) => x.name === attachedSession(iid));
  const cmd = (s?.paneCmd || '').toLowerCase();
  return cmd === 'claude' || cmd.startsWith('claude-') ? 'claude' : null;
}
```

In `ensureTab` (line 813–834) add to the `openTerminal` options:

```ts
    // Per-pane session for the mic's pane-kind probe; the Host Shell lets the
    // server name its own session.
    voiceSession: () => (isLocalPane(id) ? undefined : attachedSession(id)),
    voiceHint: () => paneVoiceHint(id),
```

In the function that repaints pane headers after a status poll (`updatePaneHeaders`, called at line 820), add one line so idle tooltips follow the snapshot:

```ts
  for (const [, t] of tabs) t.term.refreshHint();
```

- [ ] **Step 6: `style.css` — the live state**

After line 1346 (`.voice-btn[data-state='working']`):

```css
/* Linked to Claude Code: the box is hearing this browser's mic. Amber — the
   engaged-state accent (DESIGN.md, The Amber Means Alive Rule) with the Glow
   Is Power emission — distinct from recording's red, which means "capturing
   for dictation right now". */
.voice-btn[data-state='live'] { color: var(--accent); border-color: var(--accent); font-weight: 700; opacity: 1; box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 30%, transparent); }
```

After line 2162 (inside the touch-keys media block, matching specificity 0-4-0):

```css
  .touch-keys .touch-mic-slot .voice-btn[data-state='live'] { opacity: 1; }
```

- [ ] **Step 7: Run the web suites and typecheck**

Run: `npm run typecheck && npx vitest run test/voiceUi.test.js test/voicePress.test.js test/voiceLinkClient.test.js test/pcmStream.test.js test/styleTokens.test.js test/paneHeader.test.js`
Expected: PASS. Fix any existing `voiceUi.test.js` case that assumed `finish()` after `begin()` equals a release — replace such calls with `release()` where they model a pointer gesture.

- [ ] **Step 8: Commit**

```bash
git add src/web/voiceRecorder.ts src/web/voiceUi.ts src/web/terminal.ts src/web/main.ts src/web/style.css test/voiceUi.test.js
git commit -m "feat(web): one mic button — link a Claude pane, dictate anywhere else; live state"
```

---

### Task 15: End-to-end — a Claude pane links, the live state paints on phone

**Files:**
- Modify: `test/e2e/global-setup.js` (create the FIFO in the fixture home)
- Create: `test/e2e/voiceLink.spec.ts`
- Modify: `test/e2e/touchBar.spec.ts` (line 115–122: add the `live` state to the exhaustive opacity map)

**Interfaces:**
- Consumes: everything shipped by Tasks 1–14 running as the real server the e2e global setup starts.

- [ ] **Step 1: Give the fixture box its FIFO**

In `test/e2e/global-setup.js`, right after the localBox is created (before the store seeds the `localhost` box at line 35), add:

```js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
…
  // The voice link's box-side FIFO (spec 2026-09-04). The e2e box is this
  // host, so the real Python writer runs against it; no ALSA config is
  // needed for the link to reach `ready`.
  const vdir = path.join(lb.home, '.tmuxifier-voice');
  fs.mkdirSync(vdir, { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', path.join(vdir, 'mic')]);
```

Use the variable name the file already uses for the localBox result (the report shows `lb`).

- [ ] **Step 2: Write the spec**

```ts
// test/e2e/voiceLink.spec.ts
import { test, expect, type Page } from '@playwright/test';

// Same fake-microphone setup as voice.spec.ts: loopback HTTP is a secure
// context, and the flags feed getUserMedia a synthetic tone.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openLocalhostBox(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
}

// A stand-in for Claude Code: a foreground process whose argv[0] is `claude`,
// which is what tmux's #{pane_current_command} reports (it reads the
// foreground process group leader's cmdline). A subshell keeps the pane's
// shell alive for the specs that run after this one; Ctrl+C ends it.
async function runFakeClaude(page: Page) {
  await page.keyboard.type('( exec -a claude sleep 300 )');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

test('pressing the mic on a Claude pane links and paints live; pressing again unlinks', async ({ page }) => {
  await openLocalhostBox(page);
  await runFakeClaude(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await expect(mic).toBeEnabled();
  await mic.dispatchEvent('pointerdown');
  await mic.dispatchEvent('pointerup');
  // probe (pane-kind over the fixture sshd) + writer readiness (300 ms)
  await expect(mic).toHaveAttribute('data-state', 'live', { timeout: 15000 });
  await expect(mic).toHaveText(/live/);
  await mic.dispatchEvent('pointerdown');
  await mic.dispatchEvent('pointerup');
  await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 5000 });
  // No transcript line ever reaches the pane on the link path.
  await expect(page.locator('.xterm-rows').first()).not.toContainText('hello from the fixture');
  await page.keyboard.press('Control+c');
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 10000 });
});

test('the same press at a shell prompt still dictates', async ({ page }) => {
  await openLocalhostBox(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeEnabled({ timeout: 10000 });
  await mic.dispatchEvent('pointerdown');
  await page.waitForTimeout(500);
  await mic.dispatchEvent('pointerup');
  await expect(page.locator('.xterm-rows').first()).toContainText('hello from the fixture', { timeout: 15000 });
  await expect(mic).toHaveAttribute('data-state', 'idle');
});
```

- [ ] **Step 3: Extend the touch-bar cascade test**

In `test/e2e/touchBar.spec.ts` lines 115–122, add `live: read((b) => { b.dataset.state = 'live'; }),` to the map and `live: '1'` to the `toEqual`.

- [ ] **Step 4: Build in the worktree and run the three specs**

Run (in the worktree, never in `/root/tmuxifier`): `npm run build && npx playwright test test/e2e/voiceLink.spec.ts test/e2e/voice.spec.ts test/e2e/touchBar.spec.ts`
Expected: PASS. If the first spec never reaches `live`, run `tmux display-message -p '#{pane_current_command}'` against the fixture session by hand to confirm the stand-in reports `claude`; if it reports `zsh`/`bash`, replace `exec -a` with `cp "$(command -v sleep)" ~/claude && ~/claude 300`.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/global-setup.js test/e2e/voiceLink.spec.ts test/e2e/touchBar.spec.ts
git commit -m "test(e2e): a Claude pane links the mic and paints live; shell prompt still dictates"
```

---

### Task 16: Documentation

**Files:**
- Modify: `docs/terminal.md` (the Voice dictation section, lines 143–193; the phone paragraph ~line 289)
- Modify: `docs/boxes-and-setup.md` (the Claude Code checkbox section lines 65–84; the phase-order block lines 111–119)
- Modify: `README.md` (line 196–198; the docs table row at line 160)
- Modify: `DESIGN.md` (the Chips/badges component line ~351; or a new bullet under Named Rules' examples naming the mic's `live` state)
- Modify: `CLAUDE.md` and `AGENTS.md` (server modules after the `claudeAgentHooks.js` entry, line 784; the routes paragraph in the `server.js` entry; the web modules sentence before line 1286; the `VoiceHost.sink` note at lines 1095–1097)

- [ ] **Step 1: `docs/terminal.md`**

Replace the paragraph at lines 152–156 (which says `/voice` cannot work on a headless box) with:

```markdown
The same button also drives Claude Code's own `/voice` mode. Claude Code reads the machine's
**default microphone**, and a headless box has none — so when you press the mic on a pane where
Claude Code is open, Tmuxifier **links** your browser microphone to that box instead of
transcribing: the button turns amber (`● live`), and from then on you hold Space in the pane
exactly as you would on a laptop, with Anthropic's transcription. Press the mic again to unlink.
On any other pane the press is ordinary dictation, transcribed locally as described above. The
pane is classified at press time by the same check that decides where dictation types, so the
button never has to be told which mode you mean.

A link streams audio continuously while it is up (about 32 KB/s), and ends when you unlink, when
the tab is hidden, when the page is closed or logged out, or after 30 minutes. It is refused, with
a one-line note, on a box whose setup never installed the voice link — re-run setup with
**Claude Code** ticked (see [Boxes & setup](boxes-and-setup.md#the-claude-code-checkbox)). Linked
audio goes to the box and from there to Anthropic under that box's Claude.ai login — unlike
dictation, which never leaves the Tmuxifier host.
```

Amend the "Audio never leaves the host" paragraph (lines 187–189) to start "For dictation, audio never leaves the host: …" and end "…unlike a **linked** Claude Code pane, which uses Claude Code's own voice mode."

In the phone paragraph (~line 290), after "release to transcribe, exactly as on the desktop", add: "— and on a Claude Code pane a tap links your mic, exactly as on the desktop."

- [ ] **Step 2: `docs/boxes-and-setup.md`**

In the Claude Code checkbox list (lines 70–78), change "three things" to "four things" and add a fourth bullet:

```markdown
- **Prepare the voice link**: writes a user-level ALSA config (`~/.asoundrc`) that makes the
  box's default microphone a pipe Tmuxifier feeds from your browser, creates that pipe under
  `~/.tmuxifier-voice/`, installs `alsa-utils`, and turns Claude Code's voice mode on in its
  settings.json unless you already chose (`/voice off` stays off). A box that already has its own
  `~/.asoundrc` is left alone and the step reports `skipped`. See [Voice dictation](terminal.md#voice-dictation)
  for what the link does. The pipe is written by a small Python program on the box; on an image
  without `python3` a plain `cat` takes its place and may carry a little stale audio.
```

Update the phase-order block (lines 116–119) to:

```
tools & shell framework → AI-auth seeding → Claude statusline → agent hooks
  → voice link → your saved script → tmux session created
```

- [ ] **Step 3: `README.md`**

Line 196–198: extend the voice sentence: "**Voice dictation** (Ctrl+Shift+Space) records in your browser and transcribes on the Tmuxifier host with local whisper.cpp — audio never leaves the host — and on a pane running Claude Code the same button **links your mic to the box** so Claude Code's own `/voice` works there."

Docs table (line 160): add "voice link" to the terminal row's summary.

- [ ] **Step 4: `DESIGN.md`**

Under the Named Rules' Glow Is Power example list (line 318–321), add the mic's linked state to the enumeration of live elements: "…working-agent chips, the mic button while linked to Claude Code (`● live`)." And in the Status LEDs section note that the mic's **recording** state keeps `--crit` (capturing now) while **linked** reads `--accent` (engaged).

- [ ] **Step 5: `CLAUDE.md` and `AGENTS.md`** (identical edits in both)

After the `claudeAgentHooks.js` entry add:

```markdown
- `claudeVoiceLink.js` — `buildVoiceLinkInstallScript` (pure) + `createVoiceLinkPusher`: the
  `voice-link` setup phase (spec 2026-09-04), run after `agent-hooks` under the same `claude`
  tools knob, recorded on `job.voiceLink`, never promoted. Makes the box's ALSA `default`
  capture device a FIFO (`~/.tmuxifier-voice/mic`) through a user-level `~/.asoundrc`
  (`plug` → `file(infile)` → `null`; the plug layer converts whatever Claude Code's capture
  negotiates — its native cpal path asks for 48 kHz 32-bit mono — to the pipe's fixed 16 kHz
  S16), creates the FIFO, and merges `voice.enabled: true` into Claude's settings.json only
  when no `voice` key exists. Guarded by the `# tmuxifier-voice-link` marker: a foreign
  `~/.asoundrc` is never touched and the phase skips. The box decides via `command -v claude`.
  Host Shell gets the same install under the local-shell `claudeHooks` flag.
- `voiceWriter.js` / `voiceLinks.js` — the runtime half of the voice link. `voiceWriter.js`
  is the static Python program (no single quote in it: it rides a single-quoted shell string;
  `cat` fallback without python3) that keeps the FIFO fed: opened `O_RDWR` so open never
  blocks and EOF never reaches a reader, pipe shrunk to 4 KB, non-blocking writes dropped when
  full, even-length runs only, and 2.5 s of paced silence on stdin EOF — because alsa-lib's
  file plugin does not pad a closed FIFO with silence, it spins on stale buffer contents.
  `voiceLinks.js` holds one writer per linked box (newest wins, `4001`), sends `ready` after
  the writer survives 300 ms (exit 3 before that is `4002 not-set-up`, anything else `4003`),
  never queues audio (drops on backpressure, oversize, or over 64 KB/s), closes a link that
  delivers no frame for 3 s (`4004`), and is drained by `registerShutdownFlush`. Transport is
  `sshRun.js`'s `sshPipe` via `boxActions.openAudioSink` (or `localShellActions.openAudioSink`
  for the host).
```

In the `server.js` entry's route list add: "`GET /voice-link?box=` (WebSocket, cookie-authenticated like `/term`, `1008 'setting up'` while the box's setup job runs, `__local__` accepted) carries the browser mic's 16 kHz S16 frames to `voiceLinks.js`; `POST /api/boxes/:id/pane-kind` `{ session? }` is the mic button's press-time verdict, the same `classifyPaneState` dictation's injection uses, so 'links' and 'would type here' cannot disagree. The permissions-policy `microphone` token is always `self` now — the link needs nothing installed on this host."

In the web modules sentence add, beside `voiceUi.ts`: "`pcmStream.ts` (the stateful 16 kHz S16 resampler and 640-byte framer the link streams through), `voicePress.ts` (the pure press/verdict/release/ready/refused/closed reducer behind the one mic button: a `claude` verdict from `POST pane-kind` links, anything else dictates; a release before the verdict is remembered), `voiceLink.ts` (the `/voice-link` client: resolves on `ready`, rejects before it with the close reason so the same press falls back to dictation with its buffered audio, unlinks on the 30-minute cap and on a hidden tab)". Extend the `voiceUi.ts` description: "the controller runs the reducer's effects; `blur()` ends a dictation but never a link; the button mounts whether or not whisper is enabled, and the idle tooltip reads the status snapshot's `paneCmd` as a hint".

- [ ] **Step 6: Commit**

```bash
git add docs/terminal.md docs/boxes-and-setup.md README.md DESIGN.md CLAUDE.md AGENTS.md
git commit -m "docs: the voice mic link — one button, Claude panes link, everything else dictates"
```

---

## Live validation before merge (not a task: the release gate)

Run from the worktree, exactly as CLAUDE.md's Shipping section describes: `npm run build` in the worktree, `rsync -a --delete <worktree>/dist/ /root/tmuxifier/dist/`, copy the changed `src/server/` files onto the main checkout (this feature touches the server: a dist-only candidate would leave `/voice-link` 404), wait until no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`, `sudo systemctl restart tmuxifier`, fetch one hashed asset end-to-end. Then:

1. **Host Shell first.** Settings → Host shell → tick Claude hooks → save; the response's `voiceLink` must read `applied`. Open the Host Shell pane, run `claude`, wait for its prompt, press the mic: `● live`. Hold Space, speak a sentence, release: the transcript lands in Claude's prompt. Press the mic: idle.
2. **Unlink mid-recording.** Link, hold Space, start talking, press the mic while still holding Space. Claude must end the recording on its own within about three seconds, not hang — this is the silence tail doing its job.
3. **A real box.** Open the box's Edit dialog, tick Claude Code, save; when the job reports done, `GET /api/setup/<id>` must show `voiceLink.ok: true`. Confirm on the box: `cat ~/.asoundrc` carries the marker, `ls -l ~/.tmuxifier-voice/mic` is a FIFO, `arecord --version` works. Restart claude in the session, link, hold Space, speak.
4. **The seeded-token question.** On a box whose Claude login came from `setup-token` seeding: does `/voice` say "Voice mode requires a Claude.ai account"? If so, the docs' Known limits gain that sentence and the interactive `/login` becomes the documented route.
5. **Two panes, one box.** Link from pane A; link from pane B; A's button must drop to idle with the "another pane" line.
6. **A box that sees no sound card** (a VM, or a container on a PVE host with no audio): `/voice` must still work through `arecord`.
7. **Hidden tab.** Link, switch tabs for a few seconds, come back: idle, with the "tab hidden" line.

Only after 1–7 pass does the branch merge and the release checklist run.
