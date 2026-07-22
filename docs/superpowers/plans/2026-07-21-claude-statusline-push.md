# Claude Code Statusline Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Push Claude Code statusline" checkbox to the box setup form that copies the operator's custom statusline to a box, applying it only when Claude Code is actually installed on that box.

**Architecture:** A post-setup step structurally identical to AI-auth seeding — an opt-in boolean, a dedicated server module (`claudeStatusline.js`), invoked in `setupManager.completeDone` after the setup script and the seed but strictly before `ensureSession`. The apply-or-skip decision is made *on the box* by a `command -v claude` presence check, so the same single rule yields "nothing happens" for a new box without Claude and "try anyway" for an edit of a box that already has it — with no add-vs-edit branching. The canonical statusline script is bundled in the repo and piped to the box over the existing ControlMaster.

**Tech Stack:** Node 20+ ESM (server, plain `.js`), TypeScript web client (`.ts`, bundled by Vite), Vitest (`environment: 'node'` — no jsdom), POSIX shell for the remote installer.

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+.
- Server is plain `.js`; web client is `.ts`. Run `npm run typecheck` (tsc over `src/web`) for web changes — Vite/Vitest strip types unchecked.
- TDD with **real code, not mocks** (dependency-injection factories). Vitest env is `node`; there is no jsdom, so DOM-bound web code is verified by `npm run typecheck`, and only pure functions get unit tests (mirror `test/setupOptions.test.js`).
- Conventional-commit messages (`feat(setup): …`, `fix(ui): …`).
- Public repo: **no real PII** in code, tests, docs, or commits (no real domains/IPs/emails/hostnames/box names). Use placeholders (`example.com`, `192.168.1.10`).
- Secrets and untrusted input never interpolated into ssh argv. The statusline content is not secret but travels on **stdin** anyway; the remote installer script text contains no interpolated input.
- `commit only when asked` is this repo's rule, but this plan's tasks each end in a commit as the unit of work — the executor commits per task as normal plan execution.
- The exact settings.json command string to install is, **literally** (the `${…}` is expanded later by the shell that runs the statusline, not at install time):
  `bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh"`
- The Claude-presence test, verbatim (matches `boxActions.js` `TOOLS.claude`):
  `command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]`

---

### Task 1: Bundle the canonical statusline asset

**Files:**
- Create: `src/server/assets/claude-statusline.sh`
- Test: `test/claudeStatuslineAsset.test.js`

**Interfaces:**
- Produces: a repo-bundled script file read at runtime by `claudeStatusline.js` (Task 2) and `index.js` (Task 5) via `new URL('./assets/claude-statusline.sh', import.meta.url)`.

The canonical, verified script already lives on this host at `/root/.claude/statusline-command.sh`. It is portable (all paths `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`/`$HOME`-relative; caveman badge resolved by glob and inert where the plugin is absent).

- [ ] **Step 1: Copy the canonical script into the repo**

```bash
mkdir -p src/server/assets
cp /root/.claude/statusline-command.sh src/server/assets/claude-statusline.sh
chmod 755 src/server/assets/claude-statusline.sh
```

- [ ] **Step 2: Verify the bundled copy is the portable version**

Run:
```bash
f=src/server/assets/claude-statusline.sh
grep -Fq '${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/caveman/caveman/' "$f" && \
grep -Fq "jq -r '.model.display_name" "$f" && \
echo OK
```
Expected: `OK` (portable caveman glob + jq-driven model field present). Use `grep -F` (fixed strings) — the glob line contains regex metacharacters (`$`, `{`, `}`, `.`). If not `OK`, the wrong file was copied — stop and re-copy.

- [ ] **Step 3: Write the failing asset test**

```js
// test/claudeStatuslineAsset.test.js
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../src/server/assets/claude-statusline.sh', import.meta.url));

test('the bundled statusline asset is the portable version', () => {
  const s = readFileSync(p, 'utf8');
  // Config-dir-relative caveman glob → works for root, any $HOME, custom CLAUDE_CONFIG_DIR.
  expect(s).toContain('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/caveman/caveman/');
  // jq-driven fields (the statusline's render-time dependency).
  expect(s).toContain("jq -r '.model.display_name");
  // No hardcoded /root path leaked in.
  expect(s).not.toContain('/root/.claude/plugins/cache/caveman');
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/claudeStatuslineAsset.test.js`
Expected: PASS (the asset was copied in Step 1).

- [ ] **Step 5: Commit**

```bash
git add src/server/assets/claude-statusline.sh test/claudeStatuslineAsset.test.js
git commit -m "feat(setup): bundle the canonical Claude Code statusline as a server asset"
```

---

### Task 2: `claudeStatusline.js` — remote installer builder + pusher

**Files:**
- Create: `src/server/claudeStatusline.js`
- Test: `test/claudeStatusline.test.js`

**Interfaces:**
- Consumes (from Task 1): the bundled asset, injected as `readAsset()` → `Promise<Buffer>`.
- Produces:
  - `buildStatuslineInstallScript(): string` — the remote installer script text (no interpolated input; statusline content arrives on stdin).
  - `createStatuslinePusher({ runStdin, readAsset }): { push(box): Promise<StatuslineResult> }` where `runStdin(box, script, inputBytes)` resolves `{ ok, code, stdout, stderr, error? }` and `StatuslineResult = { target: 'statusline', ok: boolean, skipped?: string, error?: string }` (same shape as `SeedResult`).

- [ ] **Step 1: Write the failing builder + pusher tests**

```js
// test/claudeStatusline.test.js
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStatuslineInstallScript, createStatuslinePusher } from '../src/server/claudeStatusline.js';

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}

test('builder emits the claude presence check and the status markers', () => {
  const s = buildStatuslineInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('$HOME/.local/bin/claude');
  expect(s).toContain('STATUSLINE: skipped-no-claude');
  expect(s).toContain('STATUSLINE: applied');
  // The literal command value whose ${...} is expanded only at render time.
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh');
});

test('on a box without claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  // PATH without claude, and HOME with no ~/.local/bin/claude.
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: '/usr/bin:/bin' }, 'SCRIPT-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('STATUSLINE: skipped-no-claude');
  // No statusline file created.
  await expect(fs.access(path.join(dir, '.claude', 'statusline-command.sh'))).rejects.toBeTruthy();
});

test('on a box with claude: writes the script from stdin, writes fresh settings.json, prints applied', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cfg = path.join(dir, '.claude');
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}:/usr/bin:/bin` }, '#!/bin/bash\necho hi\n');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('STATUSLINE: applied');
  const sl = await fs.readFile(path.join(cfg, 'statusline-command.sh'), 'utf8');
  expect(sl).toContain('echo hi');
  const settings = JSON.parse(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8'));
  expect(settings.statusLine.type).toBe('command');
  expect(settings.statusLine.command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh');
});

test('on a box with claude and an existing settings.json: merges .statusLine, preserving other keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cfg = path.join(dir, '.claude');
  await fs.mkdir(cfg, { recursive: true });
  await fs.writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'xhigh' }, null, 2));
  const res = await runShell(buildStatuslineInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}:/usr/bin:/bin` }, 'SL');
  expect(res.code).toBe(0);
  const settings = JSON.parse(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8'));
  expect(settings.model).toBe('opus');            // preserved
  expect(settings.effortLevel).toBe('xhigh');     // preserved
  expect(settings.statusLine.command).toContain('statusline-command.sh');
});

test('pusher maps applied → ok', async () => {
  const p = createStatuslinePusher({
    runStdin: async () => ({ ok: true, code: 0, stdout: 'noise\nSTATUSLINE: applied\n', stderr: '' }),
    readAsset: async () => Buffer.from('SCRIPT'),
  });
  expect(await p.push({ id: 'b' })).toEqual({ target: 'statusline', ok: true });
});

test('pusher maps skipped-no-claude → skipped', async () => {
  const p = createStatuslinePusher({
    runStdin: async () => ({ ok: true, code: 0, stdout: 'STATUSLINE: skipped-no-claude\n', stderr: '' }),
    readAsset: async () => Buffer.from('SCRIPT'),
  });
  expect(await p.push({ id: 'b' })).toEqual({ target: 'statusline', ok: false, skipped: 'no Claude on the box' });
});

test('pusher maps non-zero exit → error, and pipes the asset bytes', async () => {
  let piped = null;
  const p = createStatuslinePusher({
    runStdin: async (_box, _script, input) => { piped = input; return { ok: false, code: 4, stdout: 'STATUSLINE: error-no-json-tool\n', stderr: '' }; },
    readAsset: async () => Buffer.from('ASSET-BYTES'),
  });
  const r = await p.push({ id: 'b' });
  expect(r).toEqual({ target: 'statusline', ok: false, error: 'statusline push failed' });
  expect(piped.toString()).toBe('ASSET-BYTES');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claudeStatusline.test.js`
Expected: FAIL — `Failed to resolve import '../src/server/claudeStatusline.js'`.

- [ ] **Step 3: Implement `src/server/claudeStatusline.js`**

```js
// src/server/claudeStatusline.js
//
// Push the operator's custom Claude Code statusline to a box. Structural twin
// of aiAuthSeed.js: a pure remote-installer builder + a small DI pusher, run as
// a post-setup step. The apply-or-skip decision is made ON THE BOX by a
// command -v claude presence check, so one rule covers both "new box without
// Claude → nothing happens" and "edit of a box that already has Claude → apply".
//
// The installer script text goes into ssh argv and interpolates NO input; the
// statusline file content arrives on stdin.

// The settings.json command value, written LITERALLY — its ${...} is expanded
// later by the shell that runs the statusline, not at install time. Single
// quotes in the script keep the box's shell from expanding it here.
const CMD_LITERAL = 'bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh"';

export function buildStatuslineInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'SL="$DIR/statusline-command.sh"',
    'SETTINGS="$DIR/settings.json"',
    `CMD='${CMD_LITERAL}'`,
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',   // drain the piped script so the writer sees no EPIPE
    "  echo 'STATUSLINE: skipped-no-claude'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the statusline script from stdin.',
    'mkdir -p "$DIR"',
    'cat > "$SL"',
    'chmod 755 "$SL"',
    '',
    '# 3. Ensure jq best-effort — the statusline needs it at render time for the',
    '#    model/dir/version fields (the git segment does not).',
    'if ! command -v jq >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq || { $SUDO apt-get update || true; $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq || true; }',
    '  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y jq || true',
    '  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y jq || true',
    '  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm jq || true',
    '  elif command -v apk >/dev/null 2>&1; then $SUDO apk add jq || true',
    '  elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install jq || true',
    '  fi',
    'fi',
    '',
    '# 4. Merge the statusLine block into settings.json.',
    'if [ ! -f "$SETTINGS" ]; then',
    '  # No file yet — write it fresh via a quoted heredoc: no shell expansion',
    '  # (${...} and \\" land literally) and no JSON parser needed, so this works',
    '  # even if jq/node/python are all absent. The heredoc body and terminator',
    '  # sit at column 0 because <<\'EOF\' (no dash) strips nothing.',
    "  cat > \"$SETTINGS\" <<'STATUSLINE_EOF'",
    '{',
    '  "statusLine": {',
    '    "type": "command",',
    '    "command": "bash \\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh\\""',
    '  }',
    '}',
    'STATUSLINE_EOF',
    '  chmod 600 "$SETTINGS"',
    "  echo 'STATUSLINE: applied'",
    '  exit 0',
    'fi',
    '',
    '# File exists — set .statusLine, preserving other keys, atomically.',
    'TMP="$SETTINGS.tmuxifier.tmp"',
    'if command -v jq >/dev/null 2>&1; then',
    '  jq --arg cmd "$CMD" \'.statusLine = {type:"command",command:$cmd}\' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"',
    'elif command -v node >/dev/null 2>&1; then',
    '  node -e \'const fs=require("fs");const p=process.argv[1];const cmd=process.argv[2];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.statusLine={type:"command",command:cmd};const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p)\' "$SETTINGS" "$CMD"',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 -c \'import json,sys,os;p=sys.argv[1];cmd=sys.argv[2];d=json.load(open(p));d["statusLine"]={"type":"command","command":cmd};t=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p)\' "$SETTINGS" "$CMD"',
    'else',
    "  echo 'STATUSLINE: error-no-json-tool'",
    '  exit 4',
    'fi',
    "echo 'STATUSLINE: applied'",
  ].join('\n');
}

export function createStatuslinePusher({ runStdin, readAsset }) {
  return {
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'statusline', ok: false, error: 'statusline asset unavailable' }; }
      const res = await runStdin(box, buildStatuslineInstallScript(), bytes);
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/STATUSLINE:\s*skipped-no-claude/.test(out)) return { target: 'statusline', ok: false, skipped: 'no Claude on the box' };
        if (/STATUSLINE:\s*applied/.test(out)) return { target: 'statusline', ok: true };
      }
      return { target: 'statusline', ok: false, error: 'statusline push failed' };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/claudeStatusline.test.js`
Expected: PASS (all 7). If a shell test fails on a machine without `jq`/`node`/`python3`, note the fresh-write path is parser-free and should still pass; the merge test needs one of the three (this dev host has node).

- [ ] **Step 5: Commit**

```bash
git add src/server/claudeStatusline.js test/claudeStatusline.test.js
git commit -m "feat(setup): add claudeStatusline installer builder and pusher"
```

---

### Task 3: Extend `execScriptStdin` to surface code/stdout/stderr

**Files:**
- Modify: `src/server/boxActions.js` (the `execScriptStdin` method, ~L494-508)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Produces: `boxActions.execScriptStdin(box, script, input)` now resolves `{ ok, code, stdout, stderr, error? }` (was `{ ok }` / `{ ok, error }`). This is what the Task 2 pusher's `runStdin` needs. Backward-compatible: the only other caller (`aiAuthSeed.js`) reads `res.ok` only.

- [ ] **Step 1: Write the failing test**

```js
// Append to test/boxActions.test.js
import { test as _t, expect as _e } from 'vitest'; // (use existing imports if present)

test('execScriptStdin surfaces code/stdout/stderr on success', async () => {
  const box = { id: 'b1', label: 'x', host: '192.168.1.10', user: 'root', sessionName: 'web' };
  const actions = createBoxActions({
    run: async () => ({ code: 0 }),
    runStdin: async () => ({ code: 0, stdout: 'OUT', stderr: '' }),
  });
  const res = await actions.execScriptStdin(box, 'echo OUT', Buffer.from('x'));
  expect(res.ok).toBe(true);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe('OUT');
  expect(res.stderr).toBe('');
});

test('execScriptStdin surfaces code/stdout/stderr on non-zero exit and sets ok=false', async () => {
  const box = { id: 'b1', label: 'x', host: '192.168.1.10', user: 'root', sessionName: 'web' };
  const actions = createBoxActions({
    run: async () => ({ code: 0 }),
    runStdin: async () => ({ code: 4, stdout: 'MARKER', stderr: 'boom' }),
  });
  const res = await actions.execScriptStdin(box, 'exit 4', Buffer.from('x'));
  expect(res.ok).toBe(false);
  expect(res.code).toBe(4);
  expect(res.stdout).toBe('MARKER');
  expect(res.stderr).toBe('boom');
});
```

Note: if `test/boxActions.test.js` does not already import `createBoxActions`, add `import { createBoxActions } from '../src/server/boxActions.js';` at the top (do not duplicate the vitest import).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/boxActions.test.js`
Expected: FAIL — `res.code` / `res.stdout` are `undefined`.

- [ ] **Step 3: Implement the change**

Replace the body of `execScriptStdin` (in `src/server/boxActions.js`) with:

```js
    async execScriptStdin(box, script, input, { timeoutMs = 60000 } = {}) {
      if (typeof runStdin !== 'function') return { ok: false, error: 'stdin exec not supported' };
      let argv;
      try {
        argv = buildProbeArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid box' };
      }
      const res = await runStdin(argv, input, { timeout: timeoutMs });
      const code = res ? res.code : null;
      const stdout = String((res && res.stdout) || '');
      const stderr = String((res && res.stderr) || '');
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, code, stdout, stderr, error: msg || `ssh exited ${res ? res.code : 'unknown'}` };
      }
      return { ok: true, code, stdout, stderr };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js test/aiAuthSeed.test.js`
Expected: PASS — new fields present; AI-auth seed (which reads `ok` only) still green.

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js
git commit -m "feat(ssh): surface code/stdout/stderr from execScriptStdin"
```

---

### Task 4: Wire the statusline step into `setupManager`

**Files:**
- Modify: `src/server/setupManager.js` (`normalizeOptions`, `summary`, `completeDone`, factory params)
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes (from Task 2): an injected `pushStatusline(box) => Promise<StatuslineResult>` (default `null` → step skipped).
- Produces: `job.options.claudeStatusline: boolean`, `job.statusline: StatuslineResult | null` (in `summary`), and a `phase: 'statusline'` while the push runs.

- [ ] **Step 1: Write the failing tests**

```js
// Append to test/setupManager.test.js (make() already exists; extend overrides pass-through
// already spreads ...overrides, so pushStatusline can be passed via make({ pushStatusline })).

test('claudeStatusline on + pusher wired: runs, records result, reaches done', async () => {
  const seen = [];
  const m = make({ pushStatusline: async (box) => { seen.push(box.id); return { target: 'statusline', ok: true }; } });
  const s = m.start(BOX, { tools: [], claudeStatusline: true });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(seen).toEqual([BOX.id]);
  expect(job.statusline).toEqual({ target: 'statusline', ok: true });
  expect(m.listJobs()[0].statusline).toEqual({ target: 'statusline', ok: true });
});

test('claudeStatusline off: the push never runs', async () => {
  let calls = 0;
  const m = make({ pushStatusline: async () => { calls += 1; return { target: 'statusline', ok: true }; } });
  const s = m.start(BOX, { tools: [], claudeStatusline: false });
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).statusline).toBeUndefined();
  expect(m.getJob(s.id).status).toBe('done');
});

test('no pusher wired: claudeStatusline is skipped rather than failing', async () => {
  const m = make();
  const s = m.start(BOX, { tools: [], claudeStatusline: true });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('done');
  expect(m.getJob(s.id).statusline).toBeUndefined();
});

test('statusline push failure is recorded, never promoted to a job failure', async () => {
  const m = make({ pushStatusline: async () => { throw new Error('boom'); } });
  const s = m.start(BOX, { tools: [], claudeStatusline: true });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.statusline).toEqual({ target: 'statusline', ok: false, error: 'statusline push failed' });
});

test('statusline runs before ensureSession', async () => {
  const order = [];
  const m = make({
    pushStatusline: async () => { order.push('statusline'); return { target: 'statusline', ok: true }; },
    ensureSession: async () => { order.push('ensureSession'); },
  });
  const s = m.start(BOX, { tools: [], claudeStatusline: true });
  await m._settled(s.id);
  expect(order).toEqual(['statusline', 'ensureSession']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js`
Expected: FAIL — `job.statusline` undefined / push never called (no wiring yet).

- [ ] **Step 3: Add the factory param and normalize/summary fields**

In `src/server/setupManager.js`, add `pushStatusline = null,` to the destructured factory params (next to `ensureSession = null,`):

```js
  ensureSession = null,
  // Post-setup Claude statusline push. Default null: an unwired manager skips
  // the step, which is what existing tests construct.
  pushStatusline = null,
```

In `normalizeOptions`, add the new option:

```js
  function normalizeOptions(o = {}) {
    return {
      ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash,
      tools: Array.isArray(o.tools) ? o.tools : [],
      seedAiAuth: !!o.seedAiAuth,
      claudeStatusline: !!o.claudeStatusline,
    };
  }
```

In `summary`, add `statusline`:

```js
  function summary(j) {
    return { id: j.id, boxId: j.boxId, boxLabel: j.boxLabel, status: j.status, phase: j.phase, options: j.options, error: j.error, seed: j.seed ?? null, statusline: j.statusline ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt };
  }
```

- [ ] **Step 4: Add the push step in `completeDone`**

In `completeDone`, insert this block **between** the `seed` block and the `ensureSession` block (so it runs after seeding and strictly before the session is created):

```js
    // Push the Claude statusline (opt-in). The box itself decides via a
    // command -v claude check whether to apply, so this yields "nothing
    // happens" for a box without Claude and "apply" for one that has it — no
    // add-vs-edit branching. A skip/failure is recorded, never promoted: setup
    // succeeded, and a box without Claude Code must not turn red.
    if (pushStatusline && j.options.claudeStatusline && box && !j.cancelled) {
      j.phase = 'statusline';
      persist();
      try { j.statusline = await pushStatusline(box); }
      catch { j.statusline = { target: 'statusline', ok: false, error: 'statusline push failed' }; }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS (all new + existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/setupManager.js test/setupManager.test.js
git commit -m "feat(setup): run the Claude statusline push as a post-setup step"
```

---

### Task 5: Wire the pusher in `index.js`

**Files:**
- Modify: `src/server/index.js` (near the `aiAuthSeeder` / `createSetupManager` wiring, ~L96-125)

**Interfaces:**
- Consumes (from Task 2): `createStatuslinePusher`. `fs` is already imported (`import fs from 'node:fs'`, L1).
- Produces: `pushStatusline` passed into `createSetupManager`.

- [ ] **Step 1: Import the pusher**

Add to the imports near `import { createAiAuthSeeder } from './aiAuthSeed.js';`:

```js
import { createStatuslinePusher } from './claudeStatusline.js';
```

- [ ] **Step 2: Construct the pusher**

After the `aiAuthSeeder` construction (~L96-99), add:

```js
const statuslinePusher = createStatuslinePusher({
  runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
  readAsset: () => fs.promises.readFile(new URL('./assets/claude-statusline.sh', import.meta.url)),
});
```

- [ ] **Step 3: Pass it into `createSetupManager`**

In the `createSetupManager({ … })` call, add after the `ensureSession: …` entry:

```js
  pushStatusline: (box) => statuslinePusher.push(box),
```

- [ ] **Step 4: Verify the server boots and the full suite is green**

Run:
```bash
node -e "import('./src/server/index.js').then(()=>{console.log('IMPORT_OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})" 2>&1 | tail -3
npx vitest run
```
Expected: `IMPORT_OK` (module loads without throwing — it does not auto-listen on import; if it does attempt to bind, instead run `npm test` and rely on the suite), and the vitest suite passes. If the import attempts to start the server/listen, skip the node import check and rely on `npx vitest run` alone.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js
git commit -m "feat(setup): wire the statusline pusher into the setup manager"
```

---

### Task 6: Web — types + `setupStatus` render helpers

**Files:**
- Modify: `src/web/api.ts` (`SetupSummary` phase + `statusline` field)
- Modify: `src/web/setupStatus.ts` (phase label + `formatStatuslineResult`)
- Test: `test/setupStatus.test.js` (create if absent; otherwise extend)

**Interfaces:**
- Consumes (from Task 4): the `statusline` field on setup summaries; `SeedResult` (already defined in `api.ts`).
- Produces: `formatStatuslineResult(statusline: SeedResult | null | undefined): string`.

- [ ] **Step 1: Extend the API types**

In `src/web/api.ts`, first broaden `SeedResult`'s `target` union to include `'statusline'` (the push result reuses this shape, and `'statusline'` is not otherwise in the union — without this, the `statusline?: SeedResult` field below fails to typecheck):

```ts
export interface SeedResult { target: 'claude' | 'codex' | 'all' | 'statusline'; ok: boolean; skipped?: string; error?: string }
```

Then update `SetupSummary` — add `'statusline'` to the phase union and a `statusline` field:

```ts
export interface SetupSummary {
  id: string; boxId: string; boxLabel: string; status: SetupStatus;
  phase: 'waiting-ssh' | 'running' | 'seeding' | 'statusline' | null; options: SetupOptions; error: string | null;
  seed?: SeedResult[] | null;
  // Present once a job that asked for the statusline push has attempted it.
  statusline?: SeedResult | null;
  createdAt: string; finishedAt: string | null;
}
```

And add `claudeStatusline` to `SetupOptions`:

```ts
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth?: boolean; claudeStatusline?: boolean }
```

- [ ] **Step 2: Write the failing `setupStatus` test**

```js
// test/setupStatus.test.js  (create if it does not exist)
import { test, expect } from 'vitest';
import { setupStatusText, formatStatuslineResult } from '../src/web/setupStatus.ts';

test('statusline phase renders a configuring label', () => {
  expect(setupStatusText({ status: 'running', phase: 'statusline', error: null })).toBe('Configuring statusline…');
});

test('formatStatuslineResult: applied / skipped / failed / empty', () => {
  expect(formatStatuslineResult({ target: 'statusline', ok: true })).toBe('statusline ✓');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, skipped: 'no Claude on the box' })).toBe('statusline skipped (no Claude on the box)');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, error: 'statusline push failed' })).toBe('statusline failed (statusline push failed)');
  expect(formatStatuslineResult(null)).toBe('');
  expect(formatStatuslineResult(undefined)).toBe('');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/setupStatus.test.js`
Expected: FAIL — `formatStatuslineResult` not exported; label not `Configuring statusline…`.

- [ ] **Step 4: Implement the label + helper**

In `src/web/setupStatus.ts`, add the phase label to `setupStatusText`'s `running` case:

```ts
    case 'running':
      return job.phase === 'waiting-ssh' ? 'Waiting for SSH…'
        : job.phase === 'seeding' ? 'Seeding AI credentials…'
        : job.phase === 'statusline' ? 'Configuring statusline…'
        : 'Running setup…';
```

And add the formatter next to `formatSeedResults`:

```ts
// One-line summary of a job's statusline-push outcome, e.g.
// "statusline ✓" / "statusline skipped (no Claude on the box)".
// Empty string when nothing was pushed, so callers test it for truthiness and
// old jobs without a statusline field render nothing.
export function formatStatuslineResult(statusline: SeedResult | null | undefined): string {
  if (!statusline) return '';
  const r = statusline;
  return `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`;
}
```

- [ ] **Step 5: Run the test + typecheck**

Run:
```bash
npx vitest run test/setupStatus.test.js
npm run typecheck
```
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/setupStatus.ts test/setupStatus.test.js
git commit -m "feat(ui): statusline setup phase label and result formatter"
```

---

### Task 7: Web — the checkbox, the option value, and the panel render

**Files:**
- Modify: `src/web/setupOptions.ts` (`SetupOptionsValues` + checkbox in the Additional tools fieldset + `values()`)
- Modify: `src/web/main.ts` (setup gate ~L1481; result render ~L1192)

**Interfaces:**
- Consumes (from Task 6): `formatStatuslineResult`; `SetupOptions.claudeStatusline`.
- Produces: `SetupOptionsValues.claudeStatusline: boolean`, submitted to `api.startSetup` as part of the options object.

- [ ] **Step 1: Add `claudeStatusline` to the values type**

In `src/web/setupOptions.ts`:

```ts
export interface SetupOptionsValues { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean; claudeStatusline: boolean }
```

- [ ] **Step 2: Render the checkbox inside the Additional tools fieldset**

In `createSetupOptionsForm`, after `const tools = toolsCheckboxGroup(); tools.element.classList.add('setup-section');`, add:

```ts
  // Claude Code statusline push. Lives visually under Additional tools but is
  // read as its own boolean — NOT a TOOL_IDS entry, so resolveTools (the
  // command-injection chokepoint) is untouched. The box decides at push time
  // whether Claude Code is present, so no coupling to the claude checkbox here.
  const statuslineInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const statuslineField = el('label', {
    class: 'check-field',
    title: 'Copies this host’s custom Claude Code statusline to the box — applied only when Claude Code is installed there',
  }, [statuslineInput, el('span', {}, ['Push Claude Code statusline'])]);
  const statuslineHint = el('div', { class: 'seed-status' }, ['Applied only when Claude Code is installed on the box.']);
  tools.element.append(statuslineField, statuslineHint);
```

- [ ] **Step 3: Read it in `values()`**

In the returned `values: () => ({ … })`, add the field:

```ts
    values: () => ({
      ohMyTmux: omt.checked,
      ohMyZsh: shZsh.input.checked,
      ohMyBash: shBash.input.checked,
      tools: tools.selected(),
      seedAiAuth: seedInput.checked,
      claudeStatusline: statuslineInput.checked,
    }),
```

- [ ] **Step 4: Extend the Edit-box setup gate in `main.ts`**

At ~L1481, add `|| so.claudeStatusline` so re-running setup with only the statusline checked still opens the provision panel:

```ts
        const so = setupForm.values();
        if (so.ohMyTmux || so.ohMyZsh || so.ohMyBash || so.tools.length || so.seedAiAuth || so.claudeStatusline) {
          openProvisionPanel(updatedBox, so);
        }
```

- [ ] **Step 5: Render the statusline outcome in the provision panel**

In `main.ts`, first ensure `formatStatuslineResult` is imported from `./setupStatus` (add it to the existing `formatSeedResults` import). Then at the `job.status === 'done'` branch (~L1192-1195), extend the summary line:

```ts
        const seedTxt = formatSeedResults(job.seed);
        if (seedTxt) status.textContent = `${status.textContent} · auth: ${seedTxt}`;
        const slTxt = formatStatuslineResult(job.statusline);
        if (slTxt) status.textContent = `${status.textContent} · ${slTxt}`;
        // An outcome deserves longer on screen than a bare success.
        autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), (seedTxt || slTxt) ? 5000 : 2000);
```

- [ ] **Step 6: Typecheck and run the web unit tests**

Run:
```bash
npm run typecheck
npx vitest run test/setupOptions.test.js test/setupStatus.test.js
```
Expected: typecheck clean; the existing pure-function tests still pass. (The checkbox/`values()` wiring is DOM-bound and covered by typecheck, matching the repo's node-only test env.)

- [ ] **Step 7: Commit**

```bash
git add src/web/setupOptions.ts src/web/main.ts
git commit -m "feat(ui): add the Push Claude Code statusline checkbox to setup"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite + typecheck**

Run:
```bash
npm test
```
Expected: typecheck clean + all vitest suites pass.

- [ ] **Step 2: Production build**

Run:
```bash
npm run build
```
Expected: Vite build succeeds into `dist/`.

- [ ] **Step 3: Optional live smoke on a trusted box**

Only if a reachable test box with Claude Code is available. In the UI: Edit box → check "Push Claude Code statusline" (leave Claude unchecked) → Save → watch the provision panel report `statusline ✓`. On the box, confirm `~/.claude/statusline-command.sh` exists and `~/.claude/settings.json` has the `statusLine` block. On a box without Claude, confirm the panel reports `statusline skipped (no Claude on the box)` and no files were written.

- [ ] **Step 4: Final commit if any verification fixes were needed**

```bash
git add -A
git commit -m "test(setup): verify statusline push end-to-end"
```

---

## Notes for the executor

- **PII:** never let a real box name/host/IP into a test or commit. Use `192.168.1.10`, `example.com`.
- **Do not** add `statusline` to `TOOL_IDS`/`PROVISION_TOOLS` — it is deliberately a separate boolean so `resolveTools` (the command-injection chokepoint) stays untouched.
- **Ordering:** the statusline push must stay between the seed and `ensureSession` in `completeDone` — `ensureSession` must remain the last step (its comments explain why).
- The spec is `docs/superpowers/specs/2026-07-21-claude-statusline-push-design.md`.
