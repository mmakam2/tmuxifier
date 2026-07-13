# Terminal File Paste & Drop Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasting an image or dropping a file onto a browser terminal uploads it to `~/.tmuxifier-uploads/` on the target (box over SSH, or the Tmuxifier host for `__local__`) and types the quoted absolute path into the terminal.

**Architecture:** The browser intercepts file-bearing `paste`/`drop` events (text paste untouched), POSTs the raw bytes to a new authenticated `POST /api/upload` route, and the server pipes them over the existing SSH ControlMaster (`cat > file`) or writes them locally. The response carries the absolute path, which the client injects via `term.paste()`. Each upload opportunistically prunes files older than 24h in the upload dir — no server state.

**Tech Stack:** Node 20+ ESM, Fastify (raw `application/octet-stream` body, per-route `bodyLimit` — no new dependencies), xterm.js, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-terminal-file-paste-design.md`

## Global Constraints

- No new npm dependencies (no `@fastify/multipart`).
- ESM everywhere; server is plain `.js`, web client is `.ts`.
- TDD: failing test first, real code not mocks (DI factories).
- All ssh-facing values stay on the `assertBoxSafe`/`buildProbeArgv`/`shSingleQuote` validation path.
- Upload dir on every target: `~/.tmuxifier-uploads/` (mode 0700, files 0600 locally); prune threshold 1440 minutes.
- Size limit: `TMUXIFIER_UPLOAD_MAX_MB`, default 25, clamped 1–1024.
- Filename rule (server-authoritative): `/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/` — basename only, no leading `-`/`.`.
- Conventional-commit messages.
- Run all commands from `/root/tmuxifier`.

---

### Task 1: Config knob `TMUXIFIER_UPLOAD_MAX_MB`

**Files:**
- Modify: `src/server/config.js` (DEFAULTS ~line 53, envCfg ~line 115, clamps ~line 140)
- Modify: `.env.example` (after the `TMUXIFIER_TERM_FONT_SIZE` block, ~line 80)
- Test: `test/config.test.js` (append)

**Interfaces:**
- Produces: `loadConfig(...).uploadMaxMb: number` (clamped int, default 25) and `loadConfig(...).uploadMaxBytes: number` (`uploadMaxMb * 1024 * 1024`). Task 5 reads `config.uploadMaxBytes`.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
test('uploadMaxMb defaults to 25 and derives uploadMaxBytes', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.uploadMaxMb).toBe(25);
  expect(c.uploadMaxBytes).toBe(25 * 1024 * 1024);
});

test('TMUXIFIER_UPLOAD_MAX_MB overrides and clamps the upload limit', () => {
  const mb = (v) => loadConfig({}, { env: { TMUXIFIER_UPLOAD_MAX_MB: v }, cwd: '/app' }).uploadMaxMb;
  expect(mb('100')).toBe(100);
  expect(loadConfig({}, { env: { TMUXIFIER_UPLOAD_MAX_MB: '100' }, cwd: '/app' }).uploadMaxBytes).toBe(100 * 1024 * 1024);
  expect(mb('0')).toBe(25);      // pathological zero -> default
  expect(mb('9999')).toBe(25);   // out of range -> default
  expect(mb('abc')).toBe(25);    // non-numeric -> default
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `expected undefined to be 25`

- [ ] **Step 3: Implement**

In `src/server/config.js`, add to `DEFAULTS` (after `pveMaxJobs: 50,`):

```js
  // Terminal file upload (paste/drag-drop): max accepted body size in MB.
  uploadMaxMb: 25,
```

Add to the `envCfg` object (after the `termFontSize` line):

```js
    uploadMaxMb: e.TMUXIFIER_UPLOAD_MAX_MB ? Number(e.TMUXIFIER_UPLOAD_MAX_MB) : undefined,
```

Add after the `pveMaxJobs` clamp line:

```js
  merged.uploadMaxMb = clampInt(merged.uploadMaxMb, 1, 1024, DEFAULTS.uploadMaxMb);
  merged.uploadMaxBytes = merged.uploadMaxMb * 1024 * 1024;
```

In `.env.example`, after the `TMUXIFIER_TERM_FONT_SIZE` entry add:

```
# Max size (MB) for files pasted/dropped onto a terminal (default 25).
#TMUXIFIER_UPLOAD_MAX_MB=25
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.js`
Expected: PASS (all, including pre-existing)

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js .env.example test/config.test.js
git commit -m "feat(config): TMUXIFIER_UPLOAD_MAX_MB terminal upload size knob"
```

---

### Task 2: `sshRunStdin` — one-shot ssh with piped stdin

**Files:**
- Modify: `src/server/sshRun.js`
- Test: `test/sshRun.test.js` (create)

**Interfaces:**
- Produces: `sshRunStdin(argv: string[], input: Buffer|string, { env, timeout = 60000, cmd = 'ssh' }): Promise<{ code: number, stdout: string, stderr: string }>`. Task 4 injects it into `createBoxActions` as `runStdin`. `cmd` exists only so tests can substitute `/bin/sh` — production callers never pass it.

- [ ] **Step 1: Write the failing tests**

Create `test/sshRun.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sshRunStdin } from '../src/server/sshRun.js';

// cmd override lets these tests exercise the spawn/stdin/timeout mechanics with
// /bin/sh instead of a real ssh connection (the ssh path is covered by
// upload.integration.test.js).

test('pipes the input buffer to stdin and captures stdout + exit code', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-sshrun-'));
  const dest = path.join(dir, 'out.bin');
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]); // binary-safe
  const res = await sshRunStdin(['-c', `cat > '${dest}' && echo done`], payload, { cmd: '/bin/sh' });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('done');
  expect(await fs.readFile(dest)).toEqual(payload);
  await fs.rm(dir, { recursive: true, force: true });
});

test('reports a non-zero exit code and stderr', async () => {
  const res = await sshRunStdin(['-c', 'echo bad >&2; exit 7'], '', { cmd: '/bin/sh' });
  expect(res.code).toBe(7);
  expect(res.stderr).toContain('bad');
});

test('survives the child exiting before stdin is written (EPIPE)', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const res = await sshRunStdin(['-c', 'exit 3'], big, { cmd: '/bin/sh' });
  expect(res.code).toBe(3);
});

test('kills the child and resolves code 124 on timeout', async () => {
  const res = await sshRunStdin(['-c', 'sleep 30'], '', { cmd: '/bin/sh', timeout: 300 });
  expect(res.code).toBe(124);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sshRun.test.js`
Expected: FAIL — `sshRunStdin` is not exported

- [ ] **Step 3: Implement**

In `src/server/sshRun.js`, change the first line to `import { execFile, spawn } from 'node:child_process';` and append:

```js
// One-shot ssh with the given bytes piped to stdin (used to land uploads on a
// box via `cat > file` over the shared ControlMaster). execFile can't stream
// stdin, hence spawn. Output capture is capped like execFile's maxBuffer so a
// chatty remote can't balloon memory; a timeout SIGKILLs and resolves 124
// (shell timeout convention). `cmd` is test-only injection (/bin/sh).
const MAX_CAPTURE = 1024 * 1024;

export function sshRunStdin(argv, input, { env = process.env, timeout = 60000, cmd = 'ssh' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(124);
    }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    // A child that exits before consuming stdin (auth failure, bad remote
    // command) EPIPEs the write; without this handler that throws uncaught.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sshRun.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/sshRun.js test/sshRun.test.js
git commit -m "feat(ssh): sshRunStdin pipes a buffer to a one-shot ssh command"
```

---

### Task 3: Server upload helpers (`uploads.js`)

**Files:**
- Create: `src/server/uploads.js`
- Test: `test/uploads.test.js` (create)

**Interfaces:**
- Consumes: `shSingleQuote(s)` from `src/server/sshCommand.js`.
- Produces (all used by Tasks 4–5):
  - `UPLOAD_DIR_NAME = '.tmuxifier-uploads'`
  - `validUploadName(name: unknown): boolean`
  - `storedUploadName(name: string, { now = Date.now(), rand } = {}): string` — `<now>-<8 hex>-<name>`; throws on invalid name
  - `buildUploadRemote(storedName: string): string` — sh script: mkdir/chmod dir, prune >1440 min, `cat >` the file, print its absolute path; throws on invalid name
  - `saveLocalUpload(storedName: string, buffer: Buffer, { home = os.homedir(), now = Date.now() } = {}): Promise<string>` — writes 0o600, prunes, returns absolute path

- [ ] **Step 1: Write the failing tests**

Create `test/uploads.test.js`:

```js
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UPLOAD_DIR_NAME,
  validUploadName,
  storedUploadName,
  buildUploadRemote,
  saveLocalUpload,
} from '../src/server/uploads.js';

test('validUploadName accepts plain filenames', () => {
  expect(validUploadName('screenshot.png')).toBe(true);
  expect(validUploadName('pasted-1760000000000.png')).toBe(true);
  expect(validUploadName('My File (1).txt'.replace(/[()]/g, '_'))).toBe(true);
  expect(validUploadName('a')).toBe(true);
});

test('validUploadName rejects traversal, options, hidden files, junk', () => {
  expect(validUploadName('')).toBe(false);
  expect(validUploadName(undefined)).toBe(false);
  expect(validUploadName('../etc/passwd')).toBe(false);
  expect(validUploadName('a/b.png')).toBe(false);
  expect(validUploadName('-rf')).toBe(false);
  expect(validUploadName('.env')).toBe(false);
  expect(validUploadName('..')).toBe(false);
  expect(validUploadName('a\nb')).toBe(false);
  expect(validUploadName(`x'; rm -rf /`)).toBe(false);
  expect(validUploadName('x'.repeat(200))).toBe(false);
});

test('storedUploadName uniquifies and preserves the original name', () => {
  const s = storedUploadName('shot.png', { now: 1760000000000, rand: () => 'abcd1234' });
  expect(s).toBe('1760000000000-abcd1234-shot.png');
  expect(validUploadName(s)).toBe(true);
  expect(() => storedUploadName('../x')).toThrow(/invalid/);
});

test('buildUploadRemote writes stdin to the upload dir, prunes old files, prints the path', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uphome-'));
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  const oldFile = path.join(dir, 'stale.txt');
  await fs.writeFile(oldFile, 'old');
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const script = buildUploadRemote('1-aa-shot.png');
  const res = await new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }));
    child.stdin.end(Buffer.from('img-bytes'));
  });

  expect(res.code).toBe(0);
  const dest = path.join(dir, '1-aa-shot.png');
  expect(res.stdout.trim()).toBe(dest);
  expect(await fs.readFile(dest, 'utf8')).toBe('img-bytes');
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.rm(home, { recursive: true, force: true });
});

test('buildUploadRemote refuses an invalid stored name', () => {
  expect(() => buildUploadRemote("x'; rm -rf /")).toThrow(/invalid/);
});

test('saveLocalUpload writes 0600, prunes old files, returns the absolute path', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uplocal-'));
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  const oldFile = path.join(dir, 'stale.txt');
  await fs.writeFile(oldFile, 'old');
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const p = await saveLocalUpload('1-aa-shot.png', Buffer.from('local-bytes'), { home });
  expect(p).toBe(path.join(dir, '1-aa-shot.png'));
  expect(await fs.readFile(p, 'utf8')).toBe('local-bytes');
  expect(((await fs.stat(p)).mode & 0o777)).toBe(0o600);
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.rm(home, { recursive: true, force: true });
});

test('saveLocalUpload refuses an invalid stored name', async () => {
  await expect(saveLocalUpload('../x', Buffer.from('x'), { home: os.tmpdir() })).rejects.toThrow(/invalid/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/uploads.test.js`
Expected: FAIL — cannot resolve `../src/server/uploads.js`

- [ ] **Step 3: Implement**

Create `src/server/uploads.js`:

```js
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { shSingleQuote } from './sshCommand.js';

// Terminal file uploads (paste/drag-drop) land in this dir under the target's
// $HOME — a box over ssh (buildUploadRemote) or the Tmuxifier host itself
// (saveLocalUpload). Every upload opportunistically prunes files older than
// UPLOAD_PRUNE_MINUTES, so the dir is self-cleaning with no tracked state.
export const UPLOAD_DIR_NAME = '.tmuxifier-uploads';
export const UPLOAD_PRUNE_MINUTES = 1440; // 24h

// Basename only, no leading '-' (option injection) or '.' (hidden/traversal),
// conservative charset, capped length. The client sanitizes toward this rule;
// the server enforces it. The stored name (epoch-hex-name) matches it too.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export function validUploadName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function storedUploadName(name, { now = Date.now(), rand = () => randomBytes(4).toString('hex') } = {}) {
  if (!validUploadName(name)) throw new Error('invalid upload filename');
  return `${now}-${rand()}-${name}`;
}

// sh script run on the box (stdin = file bytes): ensure the dir, prune, write,
// echo the absolute destination so the caller never guesses the remote $HOME.
// The name is validated above AND single-quoted, belt and braces.
export function buildUploadRemote(storedName) {
  if (!validUploadName(storedName)) throw new Error('invalid upload filename');
  const q = shSingleQuote(storedName);
  return [
    'set -eu',
    `dir="$HOME/${UPLOAD_DIR_NAME}"`,
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    `find "$dir" -type f -mmin +${UPLOAD_PRUNE_MINUTES} -delete 2>/dev/null || true`,
    `cat > "$dir/"${q}`,
    `printf '%s\\n' "$dir/"${q}`,
  ].join('\n');
}

// Same contract for the __local__ terminal: write under the Tmuxifier host's
// own $HOME, prune, return the absolute path.
export async function saveLocalUpload(storedName, buffer, { home = os.homedir(), now = Date.now() } = {}) {
  if (!validUploadName(storedName)) throw new Error('invalid upload filename');
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const cutoff = now - UPLOAD_PRUNE_MINUTES * 60000;
  for (const entry of await fs.readdir(dir)) {
    const p = path.join(dir, entry);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) await fs.unlink(p);
    } catch {}
  }
  const dest = path.join(dir, storedName);
  await fs.writeFile(dest, buffer, { mode: 0o600 });
  return dest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/uploads.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/uploads.js test/uploads.test.js
git commit -m "feat(uploads): validators, remote write script, and local save for terminal uploads"
```

---

### Task 4: `boxActions.uploadFile` over the ControlMaster

**Files:**
- Modify: `src/server/boxActions.js` (factory signature line 176 and returned object)
- Modify: `src/server/index.js` (`createBoxActions` call, ~line 46)
- Test: `test/upload.integration.test.js` (create)

**Interfaces:**
- Consumes: `storedUploadName`, `buildUploadRemote`, `UPLOAD_DIR_NAME` from `src/server/uploads.js` (Task 3); `sshRunStdin` (Task 2); existing `buildProbeArgv`.
- Produces: `boxActions.uploadFile(box, name, buffer, { timeoutMs = 60000 } = {}): Promise<{ ok: true, path: string } | { ok: false, error: string }>` — Task 5's route calls exactly this. `createBoxActions` gains an optional `runStdin` dependency (same injection style as `run`).

- [ ] **Step 1: Write the failing test**

Create `test/upload.integration.test.js` (mirrors `fleet.integration.test.js`: a real ssh loop back to this host — uploads land in the real `~/.tmuxifier-uploads`, so the test tracks and removes what it creates):

```js
import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { UPLOAD_DIR_NAME } from '../src/server/uploads.js';

let teardown;
const created = [];
afterEach(async () => {
  for (const p of created.splice(0)) { try { await fs.unlink(p); } catch {} }
  if (teardown) await teardown();
  teardown = null;
});

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

test('uploadFile lands the bytes on the box and returns the absolute path', async () => {
  const { box, boxActions } = await harness();
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const res = await boxActions.uploadFile(box, 'shot.png', payload, { timeoutMs: 15000 });
  expect(res.ok).toBe(true);
  expect(res.path).toMatch(new RegExp(`/${UPLOAD_DIR_NAME}/\\d+-[0-9a-f]{8}-shot\\.png$`));
  expect(path.isAbsolute(res.path)).toBe(true);
  created.push(res.path);
  // the "box" is this host, so the file is directly readable
  expect(await fs.readFile(res.path)).toEqual(payload);
});

test('uploadFile prunes uploads older than 24h', async () => {
  const { box, boxActions } = await harness();
  const dir = path.join(os.homedir(), UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const oldFile = path.join(dir, 'stale-test-upload.txt');
  await fs.writeFile(oldFile, 'old');
  created.push(oldFile);
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  await fs.utimes(oldFile, past, past);

  const res = await boxActions.uploadFile(box, 'fresh.txt', Buffer.from('hi'), { timeoutMs: 15000 });
  expect(res.ok).toBe(true);
  created.push(res.path);
  await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('uploadFile rejects an invalid filename without touching ssh', async () => {
  const boxActions = createBoxActions({
    run: async () => { throw new Error('must not run'); },
    runStdin: async () => { throw new Error('must not run'); },
  });
  const res = await boxActions.uploadFile({ host: 'example.com' }, '../etc/passwd', Buffer.from('x'));
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/invalid upload filename/);
});

test('uploadFile surfaces a failed remote write as ok:false with stderr', async () => {
  // Injected runner (DI, same style as server.test.js stubs) — no ssh needed
  // to exercise the non-zero-exit branch.
  const boxActions = createBoxActions({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runStdin: async () => ({ code: 1, stdout: '', stderr: 'disk full' }),
  });
  const res = await boxActions.uploadFile({ host: 'example.com' }, 'x.txt', Buffer.from('x'));
  expect(res).toEqual({ ok: false, error: 'disk full' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/upload.integration.test.js`
Expected: FAIL — `boxActions.uploadFile is not a function`

- [ ] **Step 3: Implement**

In `src/server/boxActions.js`:

Add to the imports at the top:

```js
import { storedUploadName, buildUploadRemote } from './uploads.js';
```

Change the factory signature (line 176) to:

```js
export function createBoxActions({ run, runStdin, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist }) {
```

Add to the returned object (after `execCommand`):

```js
    // Land a pasted/dropped file on the box: pipe the bytes to a remote
    // `cat > ~/.tmuxifier-uploads/<stored>` over the shared ControlMaster
    // (no second auth) and return the absolute remote path the script echoes.
    // Same validation path as every probe: assertBoxSafe inside buildProbeArgv,
    // stored name allowlisted + single-quoted in buildUploadRemote.
    async uploadFile(box, name, buffer, { timeoutMs = 60000 } = {}) {
      if (typeof runStdin !== 'function') return { ok: false, error: 'upload not supported' };
      let argv;
      try {
        const stored = storedUploadName(name);
        argv = buildProbeArgv(box, buildUploadRemote(stored), { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid upload' };
      }
      const res = await runStdin(argv, buffer, { timeout: timeoutMs });
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || `ssh exited ${res ? res.code : 'unknown'}` };
      }
      const lines = String(res.stdout || '').trim().split(/\r?\n/);
      const remotePath = (lines[lines.length - 1] || '').trim();
      if (!remotePath.startsWith('/')) return { ok: false, error: 'could not resolve upload path' };
      return { ok: true, path: remotePath };
    },
```

In `src/server/index.js`, extend the ssh import (line 10) to `import { sshRun, sshRunStdin } from './sshRun.js';` and add to the `createBoxActions({...})` call (line 46):

```js
  runStdin: (argv, input, opts) => sshRunStdin(argv, input, opts),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/upload.integration.test.js test/boxActions.test.js`
Expected: PASS (upload tests plus all pre-existing boxActions tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js src/server/index.js test/upload.integration.test.js
git commit -m "feat(uploads): boxActions.uploadFile pipes files onto a box over the ControlMaster"
```

---

### Task 5: `POST /api/upload` route + `uploadMaxBytes` in `/api/ui-config`

**Files:**
- Modify: `src/server/server.js` (imports ~line 1–30; ui-config route ~line 554; new route after it)
- Test: `test/server.test.js` (update two existing ui-config tests; append upload route tests)

**Interfaces:**
- Consumes: `validUploadName`, `storedUploadName`, `saveLocalUpload` from `uploads.js`; `boxActions.uploadFile` (Task 4); `config.uploadMaxBytes` (Task 1).
- Produces: `POST /api/upload?box=<id|__local__>&name=<filename>` with `application/octet-stream` body → `200 { path }`, `400` invalid name / unknown box / missing body, `401` unauthed, `413` over limit, `502 { error: 'upload failed: …' }` on ssh failure, `500` on local write failure. `GET /api/ui-config` gains `uploadMaxBytes: number`. `buildServer` gains an optional `saveUploadLocally = saveLocalUpload` dependency (test injection).

- [ ] **Step 1: Write the failing tests**

In `test/server.test.js`, update the two existing ui-config assertions to include the new field:

```js
  expect(res.json()).toEqual({ termFont: null, termFontSize: 12, uploadMaxBytes: 25 * 1024 * 1024 });
```

(first test — and in the `'reflects the configured terminal font'` test:)

```js
  expect(res.json()).toEqual({ termFont: 'Fira Code', termFontSize: 13, uploadMaxBytes: 25 * 1024 * 1024 });
```

Append the upload route tests:

```js
test('POST /api/upload requires auth', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/upload?box=__local__&name=x.png',
    headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x'),
  });
  expect(res.statusCode).toBe(401);
});

test('POST /api/upload saves a local-shell upload and returns its absolute path', async () => {
  const saved = [];
  app = await makeApp({
    saveUploadLocally: async (stored, buf) => { saved.push([stored, buf]); return `/home/u/.tmuxifier-uploads/${stored}`; },
  });
  const cookie = await login();
  const res = await app.inject({
    method: 'POST', url: '/api/upload?box=__local__&name=shot.png',
    headers: { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('img-bytes'),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().path).toMatch(/^\/home\/u\/\.tmuxifier-uploads\/\d+-[0-9a-f]{8}-shot\.png$/);
  expect(saved).toHaveLength(1);
  expect(saved[0][1].toString()).toBe('img-bytes');
});

test('POST /api/upload routes a box upload through boxActions.uploadFile', async () => {
  const calls = [];
  app = await makeApp({
    boxActions: {
      uploadFile: async (box, name, buf) => { calls.push([box.id, name, buf.toString()]); return { ok: true, path: '/root/.tmuxifier-uploads/1-aa-shot.png' }; },
    },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const boxId = add.json().id;
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${boxId}&name=shot.png`, headers, payload: Buffer.from('bytes') });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ path: '/root/.tmuxifier-uploads/1-aa-shot.png' });
  expect(calls).toEqual([[boxId, 'shot.png', 'bytes']]);
});

test('POST /api/upload rejects bad filenames and unknown boxes', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const bad = await app.inject({ method: 'POST', url: `/api/upload?box=__local__&name=${encodeURIComponent('../etc/passwd')}`, headers, payload: Buffer.from('x') });
  expect(bad.statusCode).toBe(400);
  const nobox = await app.inject({ method: 'POST', url: '/api/upload?box=nope&name=x.png', headers, payload: Buffer.from('x') });
  expect(nobox.statusCode).toBe(400);
  expect(nobox.json().error).toContain('unknown box');
});

test('POST /api/upload returns 413 over the configured limit and 502 on ssh failure', async () => {
  app = await makeApp({
    config: { uploadMaxBytes: 16 },
    boxActions: { uploadFile: async () => ({ ok: false, error: 'Connection closed' }) },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const big = await app.inject({ method: 'POST', url: '/api/upload?box=__local__&name=x.png', headers, payload: Buffer.alloc(64, 0x41) });
  expect(big.statusCode).toBe(413);
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${add.json().id}&name=x.png`, headers, payload: Buffer.from('x') });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('upload failed');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — ui-config equality (missing `uploadMaxBytes`) and 404s on `/api/upload`

- [ ] **Step 3: Implement**

In `src/server/server.js`:

Add to imports:

```js
import { validUploadName, storedUploadName, saveLocalUpload } from './uploads.js';
```

Add `saveUploadLocally = saveLocalUpload` to the `buildServer({ ... })` destructured parameters (line 59).

After `app.register(websocket);` (line 75) add:

```js
  // Terminal uploads POST their raw bytes; keep them as a Buffer. Scoped to
  // this content type only — JSON handling everywhere else is untouched.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
  const uploadMaxBytes = Number(config.uploadMaxBytes) || 25 * 1024 * 1024;
```

Change the ui-config route (line 554) to:

```js
  app.get('/api/ui-config', { preHandler: requireAuth }, async () => {
    return { termFont: config.termFont ?? null, termFontSize: config.termFontSize ?? 12, uploadMaxBytes };
  });
```

Add after the ui-config route:

```js
  // Land a pasted/dropped file on a box (or the Tmuxifier host for the local
  // shell) and return the absolute path the client will type into the PTY.
  // Fastify enforces uploadMaxBytes via bodyLimit (413); filenames are
  // allowlist-validated here and re-validated/quoted in uploads.js.
  app.post('/api/upload', { preHandler: requireAuth, bodyLimit: uploadMaxBytes }, async (req, reply) => {
    const name = String(req.query?.name || '');
    if (!validUploadName(name)) return reply.code(400).send({ error: 'invalid filename' });
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return reply.code(400).send({ error: 'missing file body' });
    const boxId = String(req.query?.box || '');
    if (boxId === '__local__') {
      try {
        return { path: await saveUploadLocally(storedUploadName(name), body) };
      } catch (e) {
        return reply.code(500).send({ error: e?.message || 'could not save upload' });
      }
    }
    const box = await store.getBox(boxId);
    if (!box) return reply.code(400).send({ error: 'unknown box' });
    if (!boxActions?.uploadFile) return reply.code(500).send({ error: 'upload not supported' });
    const res = await boxActions.uploadFile(box, name, body);
    if (!res.ok) return reply.code(502).send({ error: `upload failed: ${res.error}` });
    return { path: res.path };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS (all, including the two updated ui-config tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(api): POST /api/upload terminal file upload route + uploadMaxBytes in ui-config"
```

---

### Task 6: Web pure helpers (`upload.ts`)

**Files:**
- Create: `src/web/upload.ts`
- Test: `test/upload.test.js` (create)

**Interfaces:**
- Produces (all consumed by Task 7):
  - `sanitizeUploadName(name: string): string` — coerce toward the server allowlist; `''` when unsalvageable
  - `uploadName(file: { name?: string; type?: string }, now: number): string` — sanitized original name, or `pasted-<now>.<ext>` from MIME for nameless clipboard blobs
  - `filesFromDataTransfer<T>(dt: { items?: ArrayLike<{ kind: string; getAsFile(): T | null }>; files?: ArrayLike<T> } | null | undefined): T[]`
  - `pathInjection(path: string): string` — `'<path>' ` single-quoted, embedded quotes escaped, trailing space
  - `sizeError(size: number, maxBytes: number): string | null`
  - `termSafe(s: string): string` — strip control/non-ASCII chars from server messages before `term.write`

- [ ] **Step 1: Write the failing tests**

Create `test/upload.test.js`:

```js
import { test, expect } from 'vitest';
import {
  sanitizeUploadName,
  uploadName,
  filesFromDataTransfer,
  pathInjection,
  sizeError,
  termSafe,
} from '../src/web/upload';

test('sanitizeUploadName keeps safe names and coerces unsafe ones', () => {
  expect(sanitizeUploadName('shot.png')).toBe('shot.png');
  expect(sanitizeUploadName('My Report (final).pdf')).toBe('My Report _final_.pdf');
  expect(sanitizeUploadName('.env')).toBe('env');
  expect(sanitizeUploadName('---weird')).toBe('weird');
  // Cyrillic chars all map to '_', which the leading-junk trim then strips.
  expect(sanitizeUploadName('док.png')).toBe('png');
  expect(sanitizeUploadName('')).toBe('');
  expect(sanitizeUploadName('x'.repeat(300)).length).toBeLessThanOrEqual(128);
});

test('uploadName uses the sanitized filename when present', () => {
  expect(uploadName({ name: 'shot.png', type: 'image/png' }, 1760000000000)).toBe('shot.png');
});

test('uploadName synthesizes pasted-<ts>.<ext> for nameless clipboard images', () => {
  expect(uploadName({ name: '', type: 'image/png' }, 1760000000000)).toBe('pasted-1760000000000.png');
  expect(uploadName({ type: 'image/jpeg' }, 5)).toBe('pasted-5.jpg');
  expect(uploadName({ type: 'application/x-thing' }, 5)).toBe('pasted-5.bin');
});

test('filesFromDataTransfer prefers items, falls back to files, tolerates null', () => {
  const f1 = { name: 'a.png' };
  const f2 = { name: 'b.txt' };
  const viaItems = filesFromDataTransfer({
    items: [
      { kind: 'file', getAsFile: () => f1 },
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f2 },
    ],
  });
  expect(viaItems).toEqual([f1, f2]);
  expect(filesFromDataTransfer({ files: [f1] })).toEqual([f1]);
  expect(filesFromDataTransfer(null)).toEqual([]);
  expect(filesFromDataTransfer({ items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
});

test('pathInjection single-quotes and escapes embedded quotes, trailing space', () => {
  expect(pathInjection('/home/u/.tmuxifier-uploads/1-aa-shot.png')).toBe("'/home/u/.tmuxifier-uploads/1-aa-shot.png' ");
  expect(pathInjection("/a/it's.png")).toBe("'/a/it'\\''s.png' ");
});

test('sizeError reports MB over-limit, null when within', () => {
  expect(sizeError(10, 100)).toBeNull();
  expect(sizeError(26 * 1024 * 1024, 25 * 1024 * 1024)).toBe('file too large (max 25 MB)');
});

test('termSafe strips escape sequences and control chars', () => {
  expect(termSafe('ok message 1.2')).toBe('ok message 1.2');
  expect(termSafe('bad\x1b[31mred\x07')).toBe('bad[31mred');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/upload.test.js`
Expected: FAIL — cannot resolve `../src/web/upload`

- [ ] **Step 3: Implement**

Create `src/web/upload.ts`:

```ts
// Pure helpers for terminal file uploads (paste/drag-drop). Like clipboard.ts,
// no direct DOM/global access — callers hand in the event payloads — so all of
// this is unit-testable in Node.

// Mirror of the server allowlist in src/server/uploads.js (NAME_RE) — keep in
// sync. The server is authoritative; this only makes friendly names client-side.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

// Coerce a filename toward the server's allowlist: replace disallowed chars,
// strip a leading '-'/'.'/space run (option/hidden-file safety), cap length.
// Returns '' when nothing salvageable remains (caller synthesizes a name).
export function sanitizeUploadName(name: string): string {
  const replaced = String(name || '').replace(/[^A-Za-z0-9 ._-]/g, '_');
  const trimmed = replaced.replace(/^[-._ ]+/, '').slice(0, 128).trim();
  return NAME_RE.test(trimmed) ? trimmed : '';
}

// Pasted clipboard images arrive as nameless blobs ("image.png" or '') —
// synthesize a timestamped name from the MIME type for those.
export function uploadName(file: { name?: string; type?: string }, now: number): string {
  const sanitized = sanitizeUploadName(file.name || '');
  if (sanitized) return sanitized;
  const ext = EXT_BY_MIME[file.type || ''] || 'bin';
  return `pasted-${now}.${ext}`;
}

// Extract the file entries from a paste/drop DataTransfer. Structural typing
// (not the DOM DataTransfer) so tests can pass plain objects.
export function filesFromDataTransfer<T>(
  dt: { items?: ArrayLike<{ kind: string; getAsFile(): T | null }>; files?: ArrayLike<T> } | null | undefined,
): T[] {
  if (!dt) return [];
  const out: T[] = [];
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files) out.push(...Array.from(dt.files));
  return out;
}

// What gets typed into the PTY after an upload: the absolute path, always
// single-quoted (embedded quotes escaped the sh way), plus a trailing space —
// the same convention terminals use for drag-drop, which CLIs parse as a path.
export function pathInjection(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}' `;
}

export function sizeError(size: number, maxBytes: number): string | null {
  if (size <= maxBytes) return null;
  return `file too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`;
}

// Server error messages get echoed into the terminal — strip anything that
// could act as an escape sequence.
export function termSafe(s: string): string {
  return String(s).replace(/[^\x20-\x7e]/g, '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/upload.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean

```bash
git add src/web/upload.ts test/upload.test.js
git commit -m "feat(web): pure upload helpers for terminal paste/drop"
```

---

### Task 7: Wire uploads into the terminal (api.ts, terminal.ts, main.ts)

**Files:**
- Modify: `src/web/api.ts` (uiConfig type line 94; new `uploadFile` method)
- Modify: `src/web/terminal.ts` (imports; new `setUploadMaxBytes` + `wireUploads`; hook into `openTerminal`)
- Modify: `src/web/main.ts` (boot line ~268)

**Interfaces:**
- Consumes: Task 6 helpers; `POST /api/upload` and extended `/api/ui-config` (Task 5).
- Produces: `api.uploadFile(boxId: string, name: string, blob: Blob): Promise<{ path: string }>`; `setTerminalUploads({ uploadMaxBytes }: { uploadMaxBytes?: number })` exported from `terminal.ts` and called at boot in `main.ts`.

There is no DOM test harness in this repo for event wiring (clipboard wiring is likewise untested at the DOM level); the pure logic was tested in Task 6. Verification here is `npm run typecheck` + `npm test` + `npm run build`.

- [ ] **Step 1: Extend api.ts**

Change line 94's type and add the upload method after `uiConfig`:

```ts
  async uiConfig() { return j<{ termFont: string | null; termFontSize: number; uploadMaxBytes: number }>(await fetch('/api/ui-config')); },
  async uploadFile(boxId: string, name: string, blob: Blob) {
    return j<{ path: string }>(await fetch(`/api/upload?box=${encodeURIComponent(boxId)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
    }));
  },
```

- [ ] **Step 2: Wire terminal.ts**

Add imports at the top of `src/web/terminal.ts`:

```ts
import { api } from './api';
import { filesFromDataTransfer, uploadName, pathInjection, sizeError, termSafe } from './upload';
```

Add near `setTerminalFont` (module state set once at boot, same pattern):

```ts
// Upload limit from /api/ui-config, applied at boot like the font settings.
let uploadMaxBytes = 25 * 1024 * 1024;
export function setTerminalUploads(o: { uploadMaxBytes?: number }): void {
  if (Number.isFinite(o?.uploadMaxBytes) && (o.uploadMaxBytes as number) > 0) uploadMaxBytes = o.uploadMaxBytes as number;
}
```

Add the wiring function (after `wireClipboard`):

```ts
// Pasting a file/image or dropping one onto the terminal uploads it to the
// box's ~/.tmuxifier-uploads and types the quoted remote path into the PTY —
// the path crosses the text-only ssh pipe, not the bytes. Text pastes take
// the untouched native path (wireClipboard). Capture phase so the file case
// wins before xterm's own paste handler sees the event.
function wireUploads(parent: HTMLElement, term: Terminal, boxId: string): () => void {
  async function uploadAll(files: File[]): Promise<void> {
    const injections: string[] = [];
    for (const f of files) {
      const name = uploadName(f, Date.now());
      const tooBig = sizeError(f.size, uploadMaxBytes);
      if (tooBig) {
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe(`${name}: ${tooBig}`)}]\x1b[0m\r\n`);
        continue;
      }
      term.write(`\r\n\x1b[2m[uploading ${termSafe(name)}…]\x1b[0m\r\n`);
      try {
        const res = await api.uploadFile(boxId, name, f);
        injections.push(pathInjection(res.path));
      } catch (e) {
        term.write(`\r\n\x1b[33m[upload failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
      }
    }
    if (injections.length) term.paste(injections.join(''));
    term.focus();
  }
  const onPaste = (ev: ClipboardEvent) => {
    const files = filesFromDataTransfer<File>(ev.clipboardData);
    if (!files.length) return; // text paste — leave xterm's native handling alone
    ev.preventDefault();
    ev.stopPropagation();
    void uploadAll(files);
  };
  const onDragOver = (ev: DragEvent) => { ev.preventDefault(); };
  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const files = filesFromDataTransfer<File>(ev.dataTransfer);
    if (files.length) void uploadAll(files);
  };
  parent.addEventListener('paste', onPaste, true);
  parent.addEventListener('dragover', onDragOver);
  parent.addEventListener('drop', onDrop);
  return () => {
    parent.removeEventListener('paste', onPaste, true);
    parent.removeEventListener('dragover', onDragOver);
    parent.removeEventListener('drop', onDrop);
  };
}
```

In `openTerminal` add after `wireClipboard(term);`:

```ts
  const offUploads = wireUploads(parent, term, boxId);
```

and extend the returned `dispose` to call it first:

```ts
    dispose: () => { offUploads(); closedByUser = true; clearTimeout(stableTimer); clearTimeout(retryTimer); window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
```

Do NOT touch `openProvisionTerminal`.

- [ ] **Step 3: Boot wiring in main.ts**

At line ~268, change:

```ts
    try { setTerminalFont(await api.uiConfig()); } catch {}
```

to:

```ts
    try {
      const uiCfg = await api.uiConfig();
      setTerminalFont(uiCfg);
      setTerminalUploads(uiCfg);
    } catch {}
```

and add `setTerminalUploads` to the `./terminal` import at the top of `main.ts` (line 2):

```ts
import { openTerminal, openProvisionTerminal, setTerminalFont, setTerminalUploads } from './terminal';
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests pass, vite build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/terminal.ts src/web/main.ts
git commit -m "feat(ui): paste/drop file upload in the box terminal, path typed into the PTY"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `README.md` (a "Pasting images & files" section near the terminal/usage docs; add `TMUXIFIER_UPLOAD_MAX_MB` to the config table if one exists)
- Modify: `CLAUDE.md` and `AGENTS.md` (architecture lists)

**Interfaces:** none — documentation only.

- [ ] **Step 1: README**

Add a section (place it after the terminal/clipboard usage docs; adapt heading level to neighbors):

```markdown
## Pasting images & files

Pasting an image (Ctrl/Cmd+V) or dropping any file onto a terminal uploads it to
`~/.tmuxifier-uploads/` on that box (over the existing SSH connection — the local
shell terminal writes to the Tmuxifier host instead) and types the quoted absolute
path into the terminal. CLI tools that accept file paths — Claude Code, Codex —
pick it up directly, so pasting a screenshot into a remote Claude session just works.
Text paste is unchanged.

Uploaded files older than 24 hours are cleaned up automatically on the next upload
to that machine. The size limit is 25 MB by default (`TMUXIFIER_UPLOAD_MAX_MB`).
```

Also add `TMUXIFIER_UPLOAD_MAX_MB` wherever README enumerates config knobs, mirroring the `.env.example` comment.

- [ ] **Step 2: CLAUDE.md + AGENTS.md**

In both files' server module list, after the `boxActions.js` entry add:

```markdown
- `uploads.js` — terminal file uploads (paste/drag-drop): filename allowlist,
  stored-name uniquifier, the remote `cat > ~/.tmuxifier-uploads/…` script builder
  (24h self-prune), and the local-shell file writer. `boxActions.uploadFile` pipes
  the bytes over the ControlMaster via `sshRunStdin` (`sshRun.js`); the route is
  `POST /api/upload` with `TMUXIFIER_UPLOAD_MAX_MB` as `bodyLimit`.
```

In both files' web client list, add `upload.ts` alongside `clipboard.ts`:

```markdown
`upload.ts` (pure paste/drop upload helpers: DataTransfer extraction, pasted-image
naming, size check, quoted-path injection),
```

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: everything green

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: terminal file paste & drop upload"
```
