# Claude-Aware tmux-Side Upload Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a terminal file upload lands on the box, the server — not the browser — types the quoted path into the tmux pane, but only when the pane is a Claude Code or shell prompt; busy panes get a tmux status message instead.

**Architecture:** A new pure module `src/server/tmuxInject.js` holds the pane classifier (`claude`/`shell`/`busy`), the three tmux script builders (capture-pane / send-keys / display-message), and the runner-agnostic `injectVia` orchestration. `boxActions.injectUploadPath` runs it over the existing ControlMaster; `injectLocalUploadPath` runs it via `/bin/sh` for the `__local__` terminal. The upload route calls the injector after a successful upload and returns `{ path, injected, mode }`; the browser stops calling `term.paste()`.

**Tech Stack:** Node 20+ ESM, tmux (`capture-pane`/`send-keys -l`/`display-message`), vitest, existing sshd-loopback test helper.

**Spec:** `docs/superpowers/specs/2026-07-13-claude-aware-tmux-injection-design.md`

## Global Constraints

- No new npm dependencies. ESM everywhere; server is plain `.js`, web client is `.ts`. TDD, real code not mocks (DI fakes fine).
- The v1.6.0 upload transport is untouched: `POST /api/upload` validation, `bodyLimit`, `~/.tmuxifier-uploads/`, 24h prune, `storedUploadName` all stay byte-identical.
- All ssh/tmux-facing values go through `sanitizeSession`/`shSingleQuote`/`assertBoxSafe` (via `buildProbeArgv`).
- Classification modes exactly: `'claude' | 'shell' | 'busy'`; response modes add `'error'`. Claude is checked before shell. Unknown pane content is `busy` — never type into it.
- No auto-Enter, no `/image` (verified nonexistent in Claude Code).
- Injection failure never fails the upload (route still returns 200 with the path).
- Injected text is exactly `'<path>' ` — single-quoted, embedded quotes sh-escaped, trailing space.
- tmux messages: success `[tmuxifier] image pasted: <basename>`; busy `[tmuxifier] image uploaded: <path> (pane busy — not typed)`.
- Conventional-commit messages. Run all commands from `/root/tmuxifier`.

---

### Task 1: `tmuxInject.js` — classifier, script builders, injection text

**Files:**
- Create: `src/server/tmuxInject.js`
- Test: `test/tmuxInject.test.js` (create)

**Interfaces:**
- Consumes: `sanitizeSession`, `shSingleQuote` from `src/server/sshCommand.js`.
- Produces (Tasks 2–4 rely on these exact names):
  - `classifyPane(text: string): 'claude' | 'shell' | 'busy'`
  - `buildCapturePaneRemote(session: string): string`
  - `buildSendKeysRemote(session: string, text: string): string`
  - `buildDisplayMessageRemote(session: string, msg: string): string`
  - `injectionText(path: string): string`

- [ ] **Step 1: Write the failing tests**

Create `test/tmuxInject.test.js`:

```js
import { test, expect } from 'vitest';
import {
  classifyPane,
  buildCapturePaneRemote,
  buildSendKeysRemote,
  buildDisplayMessageRemote,
  injectionText,
} from '../src/server/tmuxInject.js';

const CLAUDE_IDLE = [
  '⏺ Done. The tests pass.',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ >                                            │',
  '╰──────────────────────────────────────────────╯',
  '  ? for shortcuts                               ',
].join('\n');

const CLAUDE_WORKING = [
  '⏺ Reading files…',
  '',
  '✻ Cerebrating… (esc to interrupt)',
].join('\n');

test('classifyPane detects Claude Code screens', () => {
  expect(classifyPane(CLAUDE_IDLE)).toBe('claude');
  expect(classifyPane(CLAUDE_WORKING)).toBe('claude');
  expect(classifyPane('│ › Try "fix the bug"')).toBe('claude');
  expect(classifyPane('⏵⏵ accept edits on (shift+tab to cycle)')).toBe('claude');
});

test('classifyPane detects shell prompts', () => {
  expect(classifyPane('user@box:~$ ')).toBe('shell');
  expect(classifyPane('build ok\nuser@box:~$')).toBe('shell');
  expect(classifyPane('~/code ❯ ')).toBe('shell');
  expect(classifyPane('root@lxc:/# ')).toBe('shell');
  expect(classifyPane('tycho% ')).toBe('shell');
  // tmux capture output can pad lines to the pane width
  expect(classifyPane('user@box:~$' + ' '.repeat(60))).toBe('shell');
});

test('classifyPane is claude-first when both could match', () => {
  // Claude's input row ends the capture with a border, but a footer hint
  // above must still win over any shell-ish trailing char.
  expect(classifyPane('esc to interrupt\n$ ')).toBe('claude');
});

test('classifyPane returns busy for everything else', () => {
  expect(classifyPane('')).toBe('busy');
  expect(classifyPane('   \n  ')).toBe('busy');
  expect(classifyPane('~\n~\n-- INSERT --')).toBe('busy');          // vim
  expect(classifyPane('Compiling tmuxifier v1.6.0')).toBe('busy'); // running build
  expect(classifyPane('Downloading 45%')).toBe('busy');
  expect(classifyPane('100%')).toBe('busy');
  expect(classifyPane('>>> ')).toBe('busy');                        // Python REPL
  expect(classifyPane('        < Ok >   < Cancel >')).toBe('busy'); // dialog buttons
});

test('script builders sanitize the session and quote arguments', () => {
  expect(buildCapturePaneRemote('web')).toBe("tmux capture-pane -p -t 'web' 2>/dev/null | tail -25");
  // session goes through sanitizeSession: unsafe chars become '-'
  expect(buildCapturePaneRemote('a;b')).toContain("'a-b'");
  expect(buildSendKeysRemote('web', "'/root/.tmuxifier-uploads/1-aa-x.png' "))
    .toBe("tmux send-keys -t 'web' -l -- ''\\''/root/.tmuxifier-uploads/1-aa-x.png'\\'' '");
  expect(buildDisplayMessageRemote('web', '[tmuxifier] image pasted: x.png'))
    .toBe("tmux display-message -t 'web' '[tmuxifier] image pasted: x.png'");
});

test('injectionText single-quotes with sh escaping and trailing space', () => {
  expect(injectionText('/home/u/.tmuxifier-uploads/1-aa-shot.png'))
    .toBe("'/home/u/.tmuxifier-uploads/1-aa-shot.png' ");
  expect(injectionText("/a/it's.png")).toBe("'/a/it'\\''s.png' ");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: FAIL — cannot resolve `../src/server/tmuxInject.js`

- [ ] **Step 3: Implement**

Create `src/server/tmuxInject.js`:

```js
import { sanitizeSession, shSingleQuote } from './sshCommand.js';

// Pane-aware injection of an uploaded file's path into a tmux session
// (spec: docs/superpowers/specs/2026-07-13-claude-aware-tmux-injection-design.md).
// The classifier decides whether typing into the pane is safe; the builders
// produce the sh commands that run on the box (or locally for __local__).
// Classification runs here in Node — not remote grep — so it's a pure,
// fixture-testable function.

// Strong Claude Code TUI markers. Any one suffices; checked before the shell
// rule because Claude's own input row would also match a trailing '>'.
const CLAUDE_MARKERS = [
  /^\s*│\s*[>›](?:\s|$)/m, // the bordered prompt-box input row
  /esc to interrupt/i,     // working/spinner footer
  /\? for shortcuts/i,     // idle footer hint
  /accept edits/i,         // permission-mode footer
  /bypass permissions/i,
  /plan mode/i,
];

// A pane whose last non-empty line (trailing padding trimmed — tmux capture
// output may pad lines to the pane width) ends in a prompt character is a
// shell. '%' (zsh) counts only when preceded by a non-digit, so progress
// lines ("Downloading 45%") stay busy. Bare '>' is NOT a prompt marker:
// Python's '>>>', dialog button rows ('< Cancel >'), and Claude's own input
// row all end in '>' — a missed prompt fails safe (status message), a
// mis-typed busy pane does not. Anything unrecognized is 'busy'.
export function classifyPane(text) {
  const t = String(text || '');
  if (!t.trim()) return 'busy';
  if (CLAUDE_MARKERS.some((re) => re.test(t))) return 'claude';
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = (lines[lines.length - 1] || '').trimEnd();
  if (/[$#❯]$/.test(last)) return 'shell';
  if (/[^\d\s]%$/.test(last)) return 'shell';
  return 'busy';
}

function sess(session) {
  return shSingleQuote(sanitizeSession(session));
}

// Last 25 pane lines. tail's exit status makes this exit 0 even when the
// session is missing (capture-pane's error goes to /dev/null), so a dead
// session degrades to an empty capture → 'busy'.
export function buildCapturePaneRemote(session) {
  return `tmux capture-pane -p -t ${sess(session)} 2>/dev/null | tail -25`;
}

// -l = literal (no key-name lookup); -- guards a text starting with '-'.
export function buildSendKeysRemote(session, text) {
  return `tmux send-keys -t ${sess(session)} -l -- ${shSingleQuote(text)}`;
}

export function buildDisplayMessageRemote(session, msg) {
  return `tmux display-message -t ${sess(session)} ${shSingleQuote(msg)}`;
}

// What gets typed: the absolute path, always single-quoted (embedded quotes
// sh-escaped) plus a trailing space — the drag-drop convention CLIs parse.
export function injectionText(path) {
  return shSingleQuote(String(path)) + ' ';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/tmuxInject.js test/tmuxInject.test.js
git commit -m "feat(inject): pane classifier and tmux script builders for upload injection"
```

---

### Task 2: `injectVia` orchestration + local injector

**Files:**
- Modify: `src/server/tmuxInject.js` (append)
- Test: `test/tmuxInject.test.js` (append)

**Interfaces:**
- Consumes: Task 1's builders/classifier (same module).
- Produces (Tasks 3–4 rely on these exact names):
  - `injectVia(runScript, session, remotePath): Promise<{ injected: boolean, mode: 'claude'|'shell'|'busy'|'error' }>` where `runScript(script: string) → Promise<{ code, stdout, stderr }>` and MUST NOT throw un-caught (injectVia catches).
  - `injectLocalUploadPath(session, path, { run } = {}): Promise<same>` — `/bin/sh`-backed default runner for the `__local__` terminal.

- [ ] **Step 1: Write the failing tests**

Append to `test/tmuxInject.test.js` (add `injectVia`, `injectLocalUploadPath` to the import list):

```js
function fakeRunner(captureOut, { sendCode = 0, failCapture = false } = {}) {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.startsWith('tmux capture-pane')) {
      return failCapture ? { code: 1, stdout: '', stderr: 'no session' } : { code: 0, stdout: captureOut, stderr: '' };
    }
    if (script.startsWith('tmux send-keys')) return { code: sendCode, stdout: '', stderr: sendCode ? 'boom' : '' };
    return { code: 0, stdout: '', stderr: '' }; // display-message
  };
  return { run, calls };
}

test('injectVia types the quoted path into a shell pane and reports mode', async () => {
  const { run, calls } = fakeRunner('user@box:~$ ');
  const res = await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  expect(res).toEqual({ injected: true, mode: 'shell' });
  const send = calls.find((c) => c.startsWith('tmux send-keys'));
  expect(send).toContain('/root/.tmuxifier-uploads/1-aa-shot.png');
  const msg = calls.find((c) => c.startsWith('tmux display-message'));
  expect(msg).toContain('image pasted: 1-aa-shot.png');
});

test('injectVia detects claude mode', async () => {
  const { run } = fakeRunner('│ > \n? for shortcuts');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: true, mode: 'claude' });
});

test('injectVia never types into a busy pane — message only', async () => {
  const { run, calls } = fakeRunner('~\n~\n-- INSERT --');
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(calls.some((c) => c.startsWith('tmux send-keys'))).toBe(false);
  const msg = calls.find((c) => c.startsWith('tmux display-message'));
  expect(msg).toContain('pane busy');
  expect(msg).toContain('/x/y.png');
});

test('injectVia treats a failed capture as busy', async () => {
  const { run } = fakeRunner('', { failCapture: true });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
});

test('injectVia reports error (and never throws) when send-keys fails', async () => {
  const { run, calls } = fakeRunner('user@box:~$ ', { sendCode: 1 });
  const res = await injectVia(run, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
  // degradation: it still tried to surface the path via display-message
  expect(calls.filter((c) => c.startsWith('tmux display-message')).length).toBe(1);
});

test('injectVia survives a throwing runner', async () => {
  const res = await injectVia(async () => { throw new Error('ssh died'); }, 'web', '/x/y.png');
  expect(res).toEqual({ injected: false, mode: 'error' });
});

test('injectLocalUploadPath runs the same flow through the injected runner', async () => {
  const { run, calls } = fakeRunner('~/code ❯ ');
  const res = await injectLocalUploadPath('local', '/home/u/.tmuxifier-uploads/1-aa-x.png', { run });
  expect(res).toEqual({ injected: true, mode: 'shell' });
  expect(calls[0]).toContain("-t 'local'");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: FAIL — `injectVia` is not exported

- [ ] **Step 3: Implement**

Append to `src/server/tmuxInject.js` (add `import { execFile } from 'node:child_process';` at the top):

```js
// Orchestration: capture → classify → type or message. runScript executes one
// sh command on the target (over ssh for a box, /bin/sh for __local__) and
// resolves {code, stdout, stderr}. Never throws — the upload already
// succeeded, so injection failures degrade to a status message and a mode
// the client can surface.
export async function injectVia(runScript, session, remotePath) {
  const name = String(remotePath).split('/').pop() || String(remotePath);
  let mode = 'busy';
  try {
    const cap = await runScript(buildCapturePaneRemote(session));
    mode = cap && cap.code === 0 ? classifyPane(cap.stdout) : 'busy';
    if (mode === 'claude' || mode === 'shell') {
      const sent = await runScript(buildSendKeysRemote(session, injectionText(remotePath)));
      if (!sent || sent.code !== 0) throw new Error('send-keys failed');
      try { await runScript(buildDisplayMessageRemote(session, `[tmuxifier] image pasted: ${name}`)); } catch {}
      return { injected: true, mode };
    }
    try { await runScript(buildDisplayMessageRemote(session, `[tmuxifier] image uploaded: ${remotePath} (pane busy — not typed)`)); } catch {}
    return { injected: false, mode: 'busy' };
  } catch {
    try { await runScript(buildDisplayMessageRemote(session, `[tmuxifier] image uploaded: ${remotePath} (pane busy — not typed)`)); } catch {}
    return { injected: false, mode: 'error' };
  }
}

function runLocalScript(script, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

// The __local__ terminal runs inside a real local tmux session (sessions.openLocal),
// so the same flow works with a /bin/sh runner on the Tmuxifier host.
export function injectLocalUploadPath(session, path, { run = runLocalScript } = {}) {
  return injectVia(run, session, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/tmuxInject.js test/tmuxInject.test.js
git commit -m "feat(inject): injectVia orchestration and local-shell injector"
```

---

### Task 3: `boxActions.injectUploadPath` + real-tmux integration test

**Files:**
- Modify: `src/server/boxActions.js` (imports + one method after `uploadFile`)
- Test: `test/tmuxInject.integration.test.js` (create)

**Interfaces:**
- Consumes: `injectVia` (Task 2); existing `runRemote` closure inside `createBoxActions`.
- Produces: `boxActions.injectUploadPath(box, session, remotePath, { timeoutMs = 8000 } = {}): Promise<{ injected, mode }>` — Task 4's route calls exactly this. Never throws.

- [ ] **Step 1: Write the failing test**

Create `test/tmuxInject.integration.test.js` (sshd loopback like `test/upload.integration.test.js`; the "box" is this host, so tmux sessions are real local sessions — unique names + kill cleanup):

```js
import { test, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';

let teardown;
const sessions = [];
let lb;
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try { await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux kill-session -t ${s} 2>/dev/null || true`], { env: lb.env }); } catch {}
  }
  if (teardown) await teardown();
  teardown = null;
});

async function harness() {
  lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: 'ignored' };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

async function newSession(cmd) {
  const s = `tmuxinj-${randomUUID().slice(0, 8)}`;
  sessions.push(s);
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux new-session -d -s ${s}${cmd ? ` '${cmd}'` : ''}`], { env: lb.env });
  return s;
}

async function capture(s) {
  const r = await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux capture-pane -p -t ${s}`], { env: lb.env });
  return String(r.stdout || '');
}

test('injects the quoted path into a real shell pane', async () => {
  const { box, boxActions } = await harness();
  const s = await newSession(); // default shell → prompt
  // wait for the shell prompt to draw (poll up to ~3s)
  let ready = false;
  for (let i = 0; i < 15 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ready = /[$%#❯>] ?\s*$/.test((await capture(s)).trimEnd());
  }
  const res = await boxActions.injectUploadPath(box, s, '/tmp/tmuxinj-fake.png');
  expect(res.injected).toBe(true);
  expect(res.mode).toBe('shell');
  expect(await capture(s)).toContain("'/tmp/tmuxinj-fake.png'");
});

test('does not type into a busy pane', async () => {
  const { box, boxActions } = await harness();
  const s = await newSession('cat'); // cat waits on stdin, blank pane → busy
  await new Promise((r) => setTimeout(r, 400));
  const res = await boxActions.injectUploadPath(box, s, '/tmp/tmuxinj-fake2.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(await capture(s)).not.toContain('tmuxinj-fake2.png');
});

test('missing session degrades to busy, never throws', async () => {
  const { box, boxActions } = await harness();
  const res = await boxActions.injectUploadPath(box, 'tmuxinj-nonexistent', '/tmp/x.png');
  expect(res.injected).toBe(false);
  expect(['busy', 'error']).toContain(res.mode);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tmuxInject.integration.test.js`
Expected: FAIL — `boxActions.injectUploadPath is not a function`

- [ ] **Step 3: Implement**

In `src/server/boxActions.js`: add to the imports

```js
import { injectVia } from './tmuxInject.js';
```

and add to the object returned by `createBoxActions`, directly after the `uploadFile` method:

```js
    // After an upload lands, type its quoted path into the box session's
    // active pane — but only when the pane is a Claude Code or shell prompt
    // (tmuxInject.js classifies a capture-pane snapshot; busy panes get a
    // tmux status message instead). Rides the same validated probe path as
    // uploadFile; never throws — the upload already succeeded.
    async injectUploadPath(box, session, remotePath, { timeoutMs = 8000 } = {}) {
      return injectVia((script) => runRemote(box, script, timeoutMs), session, remotePath);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tmuxInject.integration.test.js test/boxActions.test.js`
Expected: PASS (3 integration + all pre-existing boxActions tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js test/tmuxInject.integration.test.js
git commit -m "feat(inject): boxActions.injectUploadPath over the ControlMaster"
```

---

### Task 4: Route returns `{ path, injected, mode }`

**Files:**
- Modify: `src/server/server.js` (imports; `buildServer` params; the `POST /api/upload` handler)
- Test: `test/server.test.js` (update the three passing-upload tests; add injector-error test)

**Interfaces:**
- Consumes: `boxActions.injectUploadPath` (Task 3); `injectLocalUploadPath` (Task 2); existing `localSession` param (default `'local'`).
- Produces: `POST /api/upload` response `{ path: string, injected: boolean, mode: 'claude'|'shell'|'busy'|'error' }`. `buildServer` gains optional `injectLocalUpload = injectLocalUploadPath` (DI for tests). Task 5's client relies on this shape.

- [ ] **Step 1: Update/extend the failing tests**

In `test/server.test.js`:

Update the local-upload test's assertions (the test titled `'POST /api/upload saves a local-shell upload and returns its absolute path'`) — add an `injectLocalUpload` stub to its `makeApp` overrides and assert the new shape:

```js
  app = await makeApp({
    saveUploadLocally: async (stored, buf) => { saved.push([stored, buf]); return `/home/u/.tmuxifier-uploads/${stored}`; },
    injectLocalUpload: async (session, p) => ({ injected: true, mode: 'shell' }),
  });
```

and after the existing `expect(res.json().path).toMatch(...)` add:

```js
  expect(res.json().injected).toBe(true);
  expect(res.json().mode).toBe('shell');
```

Update the box-upload test (`'POST /api/upload routes a box upload through boxActions.uploadFile'`) — extend its `boxActions` stub and assertions:

```js
    boxActions: {
      uploadFile: async (box, name, buf) => { calls.push([box.id, name, buf.toString()]); return { ok: true, path: '/root/.tmuxifier-uploads/1-aa-shot.png' }; },
      injectUploadPath: async (box, session, p) => { calls.push(['inject', session, p]); return { injected: true, mode: 'claude' }; },
    },
```

and replace its final response assertion with:

```js
  expect(res.json()).toEqual({ path: '/root/.tmuxifier-uploads/1-aa-shot.png', injected: true, mode: 'claude' });
  expect(calls).toContainEqual(['inject', 'web', '/root/.tmuxifier-uploads/1-aa-shot.png']);
```

(the box is created via `POST /api/boxes` with `{ label: 'b', host: 'h1' }`; the store defaults `sessionName` — read the created box's `sessionName` from the add response and assert against that value instead of the literal `'web'` if it differs.)

Append a new test:

```js
test('POST /api/upload succeeds even when injection is unavailable or fails', async () => {
  app = await makeApp({
    boxActions: {
      uploadFile: async () => ({ ok: true, path: '/root/.tmuxifier-uploads/1-aa-x.png' }),
      // no injectUploadPath at all — route must degrade, not 500
    },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${add.json().id}&name=x.png`, headers, payload: Buffer.from('x') });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ path: '/root/.tmuxifier-uploads/1-aa-x.png', injected: false, mode: 'error' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — responses lack `injected`/`mode`

- [ ] **Step 3: Implement**

In `src/server/server.js`:

Add to the imports:

```js
import { injectLocalUploadPath } from './tmuxInject.js';
```

Add `injectLocalUpload = injectLocalUploadPath` to the `buildServer({ ... })` destructured parameters.

In the `POST /api/upload` handler, replace the `__local__` branch's return with:

```js
      try {
        const p = await saveUploadLocally(storedUploadName(name), body);
        const inj = await injectLocalUpload(localSession, p).catch(() => ({ injected: false, mode: 'error' }));
        return { path: p, ...inj };
      } catch (e) {
        return reply.code(500).send({ error: e?.message || 'could not save upload' });
      }
```

and replace the final `return { path: res.path };` with:

```js
    const inj = typeof boxActions.injectUploadPath === 'function'
      ? await boxActions.injectUploadPath(box, box.sessionName, res.path).catch(() => ({ injected: false, mode: 'error' }))
      : { injected: false, mode: 'error' };
    return { path: res.path, ...inj };
```

Also update the route's leading comment: the path is now typed **by the server into the tmux pane** when the pane is a Claude/shell prompt (see `tmuxInject.js`), not by the client.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS (all, including the three updated upload tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(api): upload route injects the path tmux-side and reports {injected, mode}"
```

---

### Task 5: Browser stops typing the path

**Files:**
- Modify: `src/web/api.ts` (uploadFile return type)
- Modify: `src/web/terminal.ts` (`wireUploads` body)
- Modify: `src/web/upload.ts` (remove `pathInjection`)
- Test: `test/upload.test.js` (remove the `pathInjection` test)

**Interfaces:**
- Consumes: the Task 4 response shape.
- Produces: no new exports; `pathInjection` is deleted from `src/web/upload.ts` (its server-side successor is `injectionText` in `tmuxInject.js`).

- [ ] **Step 1: api.ts**

Change the `uploadFile` method's type parameter to:

```ts
    return j<{ path: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' }>(await fetch(`/api/upload?box=${encodeURIComponent(boxId)}&name=${encodeURIComponent(name)}`, {
```

- [ ] **Step 2: terminal.ts**

In `wireUploads`:
- Remove `pathInjection` from the `./upload` import (keep `filesFromDataTransfer, uploadName, sizeError, termSafe`).
- Replace the `uploadAll` body's success handling. The whole function becomes:

```ts
  async function uploadAll(files: File[]): Promise<void> {
    for (const f of files) {
      if (disposed) return;
      const name = uploadName(f, Date.now());
      const tooBig = sizeError(f.size, uploadMaxBytes);
      if (tooBig) {
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe(`${name}: ${tooBig}`)}]\x1b[0m\r\n`);
        continue;
      }
      term.write(`\r\n\x1b[2m[uploading ${termSafe(name)}…]\x1b[0m\r\n`);
      try {
        const res = await api.uploadFile(boxId, name, f);
        if (disposed) return;
        // The server typed the path into the pane (it arrives through the
        // normal attach stream) — only surface the cases where it didn't.
        if (!res.injected) {
          term.write(`\r\n\x1b[33m[uploaded: ${termSafe(res.path)} — pane busy, not typed]\x1b[0m\r\n`);
        }
      } catch (e) {
        if (disposed) return;
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
      }
    }
    if (disposed) return;
    term.focus();
  }
```

- Update `wireUploads`'s leading comment: the server now types the quoted path into the tmux pane when it's safe (Claude Code / shell prompt — see the spec); the browser only reports uploads the server chose not to type.
- Everything else in `wireUploads` (chain serialization, disposed flag, listeners, cleanup) stays exactly as is.

- [ ] **Step 3: upload.ts + its test**

Delete the `pathInjection` function (and its comment block) from `src/web/upload.ts`. Delete the `'pathInjection single-quotes and escapes embedded quotes, trailing space'` test from `test/upload.test.js` and remove `pathInjection` from that file's import list.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (typecheck catches any missed `pathInjection` reference)

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/terminal.ts src/web/upload.ts test/upload.test.js
git commit -m "feat(ui): rely on server-side tmux injection; report busy/error uploads only"
```

---

### Task 6: Docs + full verification

**Files:**
- Modify: `README.md` ("Pasting images & files" section)
- Modify: `CLAUDE.md` and `AGENTS.md` (server module list; `upload.ts` entry)

**Interfaces:** none — documentation only.

- [ ] **Step 1: README**

Replace the body of the existing `## Pasting images & files` section with:

```markdown
Pasting an image (Ctrl/Cmd+V) or dropping any file onto a terminal uploads it to
`~/.tmuxifier-uploads/` on that box over the existing SSH connection (the local
shell terminal writes to the Tmuxifier host instead). Tmuxifier then checks what
the pane is doing before typing anything: at a Claude Code or shell prompt it
types the quoted path into the tmux pane itself — so the path appears in every
attached tmux client, not just the browser tab — and shows a tmux status
message. If the pane is busy (vim, a running build), nothing is typed; the path
is shown in a tmux message and in the browser instead. Text paste is unchanged,
and nothing needs to be installed on your own machine or the boxes.

Uploaded files older than 24 hours are cleaned up automatically on the next
upload to that machine. The size limit is 25 MB by default
(`TMUXIFIER_UPLOAD_MAX_MB`).
```

- [ ] **Step 2: CLAUDE.md + AGENTS.md**

In both files' server module list, after the `uploads.js` entry add:

```markdown
- `tmuxInject.js` — pane-aware upload injection: classifies a `capture-pane`
  snapshot (`claude`/`shell`/`busy`), and types the quoted uploaded path via
  `tmux send-keys -l` only at a Claude Code or shell prompt (busy panes get a
  `display-message` instead; never auto-Enter, no `/image` — it doesn't exist).
  `boxActions.injectUploadPath` runs it over the ControlMaster;
  `injectLocalUploadPath` covers the `__local__` terminal's local tmux session.
```

In both files' web client list, update the `upload.ts` parenthetical to `(pure paste/drop upload helpers: DataTransfer extraction, pasted-image naming, size check)` — the quoted-path injection moved server-side.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: everything green

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: claude-aware tmux-side upload injection"
```

---

## Amendment A (2026-07-13, during Task 3): command-first classification

Real-host integration testing exposed two defects in the original Task 1 design that the plan's
code blocks above still show (kept as point-in-time record; the git history is authoritative):

1. `buildCapturePaneRemote`'s `| tail -25` keeps the BOTTOM of the pane — a fresh pane's
   top-aligned prompt (with blank rows below) was discarded entirely.
2. zsh right-prompts (RPROMPT — e.g. the oh-my-zsh "blinks" theme Tmuxifier's own provisioning
   installs, `RPROMPT='!%!'`) pad text after the prompt char, so the screen regex never matched.

Resolution (commit a9aaa2b): the primary classification signal is now tmux's
`#{pane_current_command}`; the screen heuristics remain as fallback.

- `buildCapturePaneRemote` → **`buildPaneStateRemote(session)`**: a two-line script — line 1
  `tmux display-message -p -t <sess> '#{pane_current_command}' 2>/dev/null || echo`, then
  `tmux capture-pane -p -t <sess> 2>/dev/null` (whole visible pane, no tail).
- New **`parsePaneState(raw)`** → `{ command, screen }` (first line vs rest).
- New **`classifyPaneState({ command, screen })`**: command `claude`/`claude-*` → claude;
  screen markers → claude; command ∈ {bash, zsh, sh, fish, dash, ash, ksh, tcsh, csh} → shell;
  else the screen heuristic (`classifyPane`, unchanged); default busy.
- `injectVia` classifies via `classifyPaneState(parsePaneState(cap.stdout))`.
- Integration test no longer polls for a drawn prompt (command-based detection works before the
  prompt draws); fake-runner fixtures carry the command first line; the state script is
  distinguished from status display-message calls by `#{pane_current_command}`.
