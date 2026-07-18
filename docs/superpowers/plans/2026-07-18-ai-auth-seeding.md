# AI CLI Auth Seeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in per-provision seeding of Claude Code (via a `claude setup-token` token in `.env`) and Codex CLI (via the host's live `~/.codex/auth.json`) onto boxes, with secrets travelling stdin-only over the existing ControlMaster.

**Architecture:** New `src/server/aiAuthSeed.js` holds pure seed-script builders and a DI seeder. `boxActions` gains a generic `execScriptStdin` (the `uploadFile` transport minus upload specifics). A `POST /api/boxes/:id/seed-ai-auth` route runs the seeder after the client's provision terminal exits clean; a checkbox in both provision surfaces opts in. The Claude token is config (`TMUXIFIER_CLAUDE_OAUTH_TOKEN`); Codex bytes are read fresh from the host home at seed time and never stored.

**Tech Stack:** Node 20 ESM server (`.js`), TypeScript web client, vitest, real-shell tests via the existing `runShell` pattern.

**Spec:** `docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md`

## Global Constraints

- Secrets (token, auth.json bytes) travel **stdin-only**: never in script text, never in argv, never logged, never in any API response body.
- Codex credentials are read fresh from the service user's home at seed time and are **never stored** in Tmuxifier config or `data/`.
- Per-target skip is non-fatal: claude skips with `'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured'` when no token; codex skips with `'no codex auth on the Tmuxifier host'` when the local file is missing/unreadable.
- A token containing `'` is refused (`skipped: 'unsupported token characters'`) — the rc line single-quotes the value.
- On-box writes use `umask 077`; the `~/.claude.json` onboarding file is written only if absent.
- Seeding is opt-in per provision (checkbox); `__local__` boxes are rejected with 400.
- Tests use real code with DI fakes, TDD. Conventional-commit messages.
- Public repo: `.env.example` placeholder only; docs/tests use dummy tokens (e.g. `sk-ant-oat-EXAMPLE`).

---

### Task 1: Config — `claudeOauthToken`

**Files:**
- Modify: `src/server/config.js` (DEFAULTS ~line 16 area; env mapping ~line 116 area)
- Modify: `.env.example` (append near the PVE notes at the end)
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config.claudeOauthToken: string | null` (trimmed; empty/absent → `null`).

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js` (mirror the file's existing `loadConfig({}, { env, cwd })` style):

```js
test('claudeOauthToken comes from TMUXIFIER_CLAUDE_OAUTH_TOKEN, trimmed', () => {
  const cfg = loadConfig({}, { env: { TMUXIFIER_CLAUDE_OAUTH_TOKEN: '  sk-ant-oat-EXAMPLE  ' }, cwd: '/nonexistent' });
  expect(cfg.claudeOauthToken).toBe('sk-ant-oat-EXAMPLE');
});

test('claudeOauthToken defaults to null and empty string stays null', () => {
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).claudeOauthToken).toBe(null);
  expect(loadConfig({}, { env: { TMUXIFIER_CLAUDE_OAUTH_TOKEN: '   ' }, cwd: '/nonexistent' }).claudeOauthToken).toBe(null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `claudeOauthToken` undefined.

- [ ] **Step 3: Implement**

In `DEFAULTS` add `claudeOauthToken: null,` with a one-line comment (`// claude setup-token output for seeding boxes — see docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md`). In the env mapping add:

```js
    claudeOauthToken: e.TMUXIFIER_CLAUDE_OAUTH_TOKEN && e.TMUXIFIER_CLAUDE_OAUTH_TOKEN.trim() ? e.TMUXIFIER_CLAUDE_OAUTH_TOKEN.trim() : undefined,
```

(`undefined` so the merge falls back to the `null` default — matching the file's `clean()`/merge conventions; verify how sibling optional strings are folded and copy exactly.)

Append to `.env.example`:

```
# Long-lived Claude Code OAuth token (output of `claude setup-token`) used to
# seed provisioned boxes when "Seed AI CLI auth" is ticked. Full-account
# credential — treat like the password hash above.
#TMUXIFIER_CLAUDE_OAUTH_TOKEN=sk-ant-oat-EXAMPLE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js .env.example test/config.test.js
git commit -m "feat(config): TMUXIFIER_CLAUDE_OAUTH_TOKEN for AI auth seeding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `boxActions.execScriptStdin`

**Files:**
- Modify: `src/server/boxActions.js` (next to `uploadFile`)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Produces: `boxActions.execScriptStdin(box, script, input, { timeoutMs = 60000 } = {})` → `{ ok: boolean, error?: string }`. Builds argv via the same `buildProbeArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist })` call `uploadFile` uses, pipes `input` via the injected `runStdin`, returns `{ ok: res.code === 0 }` with a trimmed 300-char error like `uploadFile`. No stdout parsing.

- [ ] **Step 1: Write the failing test**

Append to `test/boxActions.test.js` (mirror the existing uploadFile DI tests — find them with `grep -n "uploadFile" test/boxActions.test.js` and copy the `createBoxActions({ run, runStdin, … })` fixture shape):

```js
test('execScriptStdin pipes input on stdin and never embeds it in argv', async () => {
  const calls = [];
  const actions = createBoxActions({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runStdin: async (argv, input) => { calls.push({ argv, input }); return { code: 0, stdout: '', stderr: '' }; },
  });
  const res = await actions.execScriptStdin({ host: 'h1' }, 'umask 077; cat > /tmp/x', Buffer.from('SECRET'));
  expect(res.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(String(calls[0].input)).toBe('SECRET');
  expect(calls[0].argv.join(' ')).not.toContain('SECRET');
});

test('execScriptStdin reports failure without throwing', async () => {
  const actions = createBoxActions({
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runStdin: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
  });
  const res = await actions.execScriptStdin({ host: 'h1' }, 'cat > /dev/null', Buffer.from('x'));
  expect(res).toEqual({ ok: false, error: 'boom' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: FAIL — `execScriptStdin` is not a function.

- [ ] **Step 3: Implement**

In `createBoxActions`'s returned object, next to `uploadFile`:

```js
    // Generic stdin-piped remote script (the uploadFile transport minus upload
    // specifics). Secrets travel on stdin only — the script text goes into ssh
    // argv, so callers must never interpolate secret material into it.
    async execScriptStdin(box, script, input, { timeoutMs = 60000 } = {}) {
      if (typeof runStdin !== 'function') return { ok: false, error: 'stdin exec not supported' };
      let argv;
      try {
        argv = buildProbeArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid box' };
      }
      const res = await runStdin(argv, input, { timeout: timeoutMs });
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || `ssh exited ${res ? res.code : 'unknown'}` };
      }
      return { ok: true };
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js
git commit -m "feat(ssh): generic stdin-piped remote script runner on boxActions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `aiAuthSeed.js` — builders + seeder

**Files:**
- Create: `src/server/aiAuthSeed.js`
- Test: `test/aiAuthSeed.test.js` (new)

**Interfaces:**
- Consumes: `execScriptStdin`-shaped `runStdin(box, script, input)` (Task 2; wired in Task 4).
- Produces:
  - `buildClaudeSeedScript(): string` — stdin = token bytes.
  - `buildCodexSeedScript(): string` — stdin = auth.json bytes.
  - `createAiAuthSeeder({ runStdin, token = null, readLocal })` → `{ seed(box): Promise<Array<{ target, ok, skipped? , error? }>> }`. `readLocal` defaults to reading `path.join(os.homedir(), '.codex', 'auth.json')`.

- [ ] **Step 1: Write the failing tests**

Create `test/aiAuthSeed.test.js`:

```js
import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildClaudeSeedScript, buildCodexSeedScript, createAiAuthSeeder } from '../src/server/aiAuthSeed.js';

function runShell(script, env) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

test('claude script reads token from stdin, tags rc lines, and skips existing ~/.claude.json', () => {
  const s = buildClaudeSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('token="$(cat)"');
  expect(s).toContain('# tmuxifier-claude-token');
  expect(s).toContain('hasCompletedOnboarding');
  expect(s).toContain('.claude.json');
});

test('codex script writes ~/.codex/auth.json from stdin with 0600', () => {
  const s = buildCodexSeedScript();
  expect(s).toContain('umask 077');
  expect(s).toContain('mkdir -p "$HOME/.codex"');
  expect(s).toContain('cat > "$HOME/.codex/auth.json"');
  expect(s).toContain('chmod 600 "$HOME/.codex/auth.json"');
});

test('claude rc line is delete-then-append idempotent and onboarding file is guarded (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-'));
  await fs.writeFile(path.join(dir, '.bashrc'), '# existing\n');
  const script = buildClaudeSeedScript();
  const env = { HOME: dir };
  for (let i = 0; i < 2; i++) {
    const res = await runShell(`printf %s 'sk-ant-oat-EXAMPLE' | ( ${script} )`, env);
    expect(res.code).toBe(0);
  }
  const rc = await fs.readFile(path.join(dir, '.bashrc'), 'utf8');
  expect(rc.split('\n').filter((l) => l.includes('tmuxifier-claude-token'))).toHaveLength(1);
  expect(rc).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat-EXAMPLE'");
  const onboarding = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  expect(onboarding.hasCompletedOnboarding).toBe(true);
  // guarded: pre-existing .claude.json must never be overwritten
  await fs.writeFile(path.join(dir, '.claude.json'), '{"custom":true}');
  await runShell(`printf %s 'sk-ant-oat-EXAMPLE' | ( ${script} )`, env);
  expect(await fs.readFile(path.join(dir, '.claude.json'), 'utf8')).toBe('{"custom":true}');
});

test('codex script round-trips bytes with 0600 (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-seed-cx-'));
  const payload = JSON.stringify({ tokens: { refresh: 'r-EXAMPLE' } });
  const res = await runShell(`printf %s '${payload.replace(/'/g, "'\\''")}' | ( ${buildCodexSeedScript()} )`, { HOME: dir });
  expect(res.code).toBe(0);
  const out = path.join(dir, '.codex', 'auth.json');
  expect(await fs.readFile(out, 'utf8')).toBe(payload);
  expect(((await fs.stat(out)).mode & 0o777)).toBe(0o600);
});

test('seeder routes secrets via stdin, never into script text', async () => {
  const calls = [];
  const seeder = createAiAuthSeeder({
    runStdin: async (box, script, input) => { calls.push({ script, input: String(input) }); return { ok: true }; },
    token: 'sk-ant-oat-EXAMPLE',
    readLocal: async () => Buffer.from('{"codex":true}'),
  });
  const results = await seeder.seed({ id: 'b1', host: 'h1' });
  expect(results).toEqual([{ target: 'claude', ok: true }, { target: 'codex', ok: true }]);
  expect(calls).toHaveLength(2);
  for (const c of calls) expect(c.script).not.toContain('EXAMPLE');
  expect(calls[0].input).toBe('sk-ant-oat-EXAMPLE');
  expect(calls[1].input).toBe('{"codex":true}');
});

test('seeder skips per target: no token, missing local codex auth, quote in token', async () => {
  const none = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: null, readLocal: async () => { throw new Error('ENOENT'); } });
  expect(await none.seed({ host: 'h1' })).toEqual([
    { target: 'claude', ok: false, skipped: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ]);
  const quoted = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: "bad'token", readLocal: async () => { throw new Error('ENOENT'); } });
  expect((await quoted.seed({ host: 'h1' }))[0]).toEqual({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
});

test('seeder reports transport failure without secret material', async () => {
  const seeder = createAiAuthSeeder({
    runStdin: async () => ({ ok: false, error: 'ssh exited 255' }),
    token: 'sk-ant-oat-EXAMPLE',
    readLocal: async () => Buffer.from('x'),
  });
  const results = await seeder.seed({ host: 'h1' });
  expect(results[0]).toEqual({ target: 'claude', ok: false, error: 'seed failed' });
  expect(results[1]).toEqual({ target: 'codex', ok: false, error: 'seed failed' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/aiAuthSeed.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/aiAuthSeed.js`**

```js
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Seed scripts for AI CLI auth. Secrets arrive on STDIN — the script text goes
// into ssh argv, so nothing secret may ever be interpolated into it (see
// docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md).

// stdin = the `claude setup-token` token. Same delete-then-append idiom as
// LOCAL_BIN_PATH_BLOCK in boxActions.js: exactly one tagged line per rc file.
// ~/.claude.json is written only when absent so an existing config (theme,
// onboarding state) is never clobbered.
export function buildClaudeSeedScript() {
  return [
    'set -eu',
    'umask 077',
    'token="$(cat)"',
    '[ -n "$token" ]',
    'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
    'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  if [ -f "$rc" ]; then',
    "    sed -i '/# tmuxifier-claude-token$/d' \"$rc\" 2>/dev/null || true",
    '    printf \'export CLAUDE_CODE_OAUTH_TOKEN=%s # tmuxifier-claude-token\\n\' "\'$token\'" >> "$rc"',
    '  fi',
    'done',
    'if [ ! -f "$HOME/.claude.json" ]; then',
    '  printf \'{"hasCompletedOnboarding": true}\\n\' > "$HOME/.claude.json"',
    'fi',
  ].join('\n');
}

// stdin = the raw ~/.codex/auth.json bytes from the Tmuxifier host.
export function buildCodexSeedScript() {
  return [
    'set -eu',
    'umask 077',
    'mkdir -p "$HOME/.codex"',
    'cat > "$HOME/.codex/auth.json"',
    'chmod 600 "$HOME/.codex/auth.json"',
  ].join('\n');
}

const CODEX_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

export function createAiAuthSeeder({ runStdin, token = null, readLocal = () => fs.readFile(CODEX_AUTH_PATH()) } = {}) {
  return {
    async seed(box) {
      const results = [];
      if (!token) {
        results.push({ target: 'claude', ok: false, skipped: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' });
      } else if (token.includes("'")) {
        results.push({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
      } else {
        const res = await runStdin(box, buildClaudeSeedScript(), Buffer.from(token));
        results.push(res && res.ok ? { target: 'claude', ok: true } : { target: 'claude', ok: false, error: 'seed failed' });
      }
      let codexBytes = null;
      try { codexBytes = await readLocal(); } catch { /* no local auth */ }
      if (!codexBytes || !codexBytes.length) {
        results.push({ target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' });
      } else {
        const res = await runStdin(box, buildCodexSeedScript(), codexBytes);
        results.push(res && res.ok ? { target: 'codex', ok: true } : { target: 'codex', ok: false, error: 'seed failed' });
      }
      return results;
    },
  };
}
```

Note on the claude rc line: the printf writes `export CLAUDE_CODE_OAUTH_TOKEN='…token…' # tmuxifier-claude-token` — the `"'$token'"` argument wraps the runtime value in literal single quotes; the seeder refuses tokens containing `'` before dispatch. Verify the exact quoting against the real-shell test before committing (the test asserts the final rc line byte-for-byte).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/aiAuthSeed.test.js`
Expected: PASS (7/7). Then `npx vitest run` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/server/aiAuthSeed.js test/aiAuthSeed.test.js
git commit -m "feat(seed): AI CLI auth seed scripts and DI seeder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Route + wiring

**Files:**
- Modify: `src/server/server.js` (route next to `/api/boxes/:id/forget-hostkey`; `buildServer` params gain `aiAuthSeeder`)
- Modify: `src/server/index.js` (create seeder, pass to `buildServer`)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `createAiAuthSeeder` (Task 3), `boxActions.execScriptStdin` (Task 2), `config.claudeOauthToken` (Task 1).
- Produces: `POST /api/boxes/:id/seed-ai-auth` → `{ results }` | 404 | 400 for local shell.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js` next to the forget-hostkey tests (reuse `makeApp`/`login` exactly as those tests do; check how `makeApp` accepts extra collaborators and mirror it):

```js
test('seed-ai-auth runs the seeder and returns redacted results only', async () => {
  const seeded = [];
  const aiAuthSeeder = { async seed(box) { seeded.push(box.host); return [
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ]; } };
  app = await makeApp({ aiAuthSeeder });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', sessionName: 'work' } });
  const box = created.json();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/seed-ai-auth`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ results: [
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ] });
  expect(seeded).toEqual(['h1']);
  expect(res.body).not.toContain('sk-ant');
});

test('seed-ai-auth 404s unknown box and requires auth', async () => {
  app = await makeApp({ aiAuthSeeder: { seed: async () => [] } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/seed-ai-auth', headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/seed-ai-auth' })).statusCode).toBe(401);
});
```

(If the app exposes a local-shell pseudo-box route path, add the 400 case the same way the local-shell tests address it — `grep -n "__local__" test/server.test.js` and mirror; if no addressable local box exists via `/api/boxes/:id`, note that the 400 branch is unreachable and drop it from route + spec erratum.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — 404 on the new URL.

- [ ] **Step 3: Implement**

`buildServer` destructured options gain `aiAuthSeeder`. Route after forget-hostkey:

```js
  // Seeds subscription credentials for the AI CLIs onto the box (opt-in
  // checkbox in the provision flows). Response is redacted to target/ok/skip —
  // secret material never appears in any API body.
  app.post('/api/boxes/:id/seed-ai-auth', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (!aiAuthSeeder?.seed) return reply.code(503).send({ error: 'seeding unavailable' });
    const results = await aiAuthSeeder.seed(box);
    return { results };
  });
```

`src/server/index.js`:

```js
import { createAiAuthSeeder } from './aiAuthSeed.js';
// after boxActions is created:
const aiAuthSeeder = createAiAuthSeeder({
  runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
  token: config.claudeOauthToken,
});
// add `aiAuthSeeder` to the buildServer({ ... }) call
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js test/server.test.js
git commit -m "feat(seed): seed-ai-auth route wired to the stdin seeder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: UI — checkbox + post-setup seeding

**Files:**
- Modify: `src/web/api.ts` (`seedAiAuth` helper + result types, next to `forgetHostKey`)
- Modify: `src/web/proxmoxUi.ts` (`SetupOptions` gains `seedAiAuth: boolean`; checkbox in `renderProvision`; call after setup exit 0)
- Modify: `src/web/main.ts` (checkbox in `openBoxDialog` setup grid; `openProvisionPanel` options gain `seedAiAuth?: boolean`; call after setup exit 0; seed-only selection still opens the panel)

**Interfaces:**
- Consumes: `POST /api/boxes/:id/seed-ai-auth` (Task 4).
- Produces: no exports.

- [ ] **Step 1: api.ts**

```ts
export interface SeedResult { target: 'claude' | 'codex'; ok: boolean; skipped?: string; error?: string }
// in the api object, next to forgetHostKey:
  async seedAiAuth(id: string) { return j<{ results: SeedResult[] }>(await fetch(`/api/boxes/${id}/seed-ai-auth`, { method: 'POST' })); },
```

- [ ] **Step 2: Shared result formatter + checkbox in both surfaces**

Both surfaces build the checkbox inline (matching each file's existing checkbox idiom — `check-field` label + input): label text `Seed AI CLI auth (claude/codex) from this host`, `title` = `Copies subscription credentials from the Tmuxifier host to this box — seed only boxes you trust with your own login`.

`proxmoxUi.ts`: extend `SetupOptions` with `seedAiAuth: boolean`; create the checkbox after `toolsGroup` in `renderProvision`; pass `seedAiAuth: seedBox.checked` in the `showJob(job.id, {...})` payload. In `runSetup`'s `openProvisionTerminal` exit callback, when `code === 0 && opt.seedAiAuth`, call `api.seedAiAuth(boxId)` and append the outcome to `phase.textContent`:

```ts
        if (code === 0 && opt.seedAiAuth) {
          void api.seedAiAuth(boxId).then(({ results }) => {
            const txt = results.map((r) => `${r.target} ${r.ok ? '✓' : `skipped (${r.skipped ?? r.error ?? 'failed'})`}`).join(' · ');
            phase.textContent = `${phase.textContent} · auth: ${txt}`;
          }).catch(() => { phase.textContent = `${phase.textContent} · auth: request failed`; });
        }
```

`main.ts`: same checkbox appended to `setupGrid` after `toolsGroup.element`; `openProvisionPanel` options gain `seedAiAuth?: boolean` (passed through to the same exit-callback pattern where the panel's provision terminal completes — locate the `openProvisionTerminal` call inside `openProvisionPanel` and mirror the proxmoxUi handler); edit-path submit condition gains `|| seedAiAuthInput.checked` so a seed-only tick still opens the panel; both submit paths pass `seedAiAuth: seedAiAuthInput.checked`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS (no new unit tests — DOM wiring; the seeding logic is server-tested).

- [ ] **Step 4: Commit**

```bash
git add src/web/api.ts src/web/proxmoxUi.ts src/web/main.ts
git commit -m "feat(ui): seed AI CLI auth checkbox on both provision surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` + `AGENTS.md` (module list bullet for `aiAuthSeed.js`; Security notes sentence)
- Modify: `README.md` (setup-options passage + one-time host setup instructions)

- [ ] **Step 1: CLAUDE.md / AGENTS.md** (identical wording in both)

Module bullet after the `knownHosts.js` bullet:

```markdown
- `aiAuthSeed.js` — `createAiAuthSeeder` + pure seed-script builders: opt-in copying of the
  host's AI CLI subscription credentials to a box (Claude via the `.env`
  `TMUXIFIER_CLAUDE_OAUTH_TOKEN` from `claude setup-token`; Codex via the host's live
  `~/.codex/auth.json`, never stored). Secrets travel stdin-only over the ControlMaster
  (`boxActions.execScriptStdin`) — never in script text, argv, logs, or API responses.
```

Security notes: one sentence noting the token joins the `.env` secret class and the seeding
blast radius (ground the wording in the shipped code, adjust the spec's phrasing minimally).

- [ ] **Step 2: README**

In the setup-options passage (near the Additional-tools sentence): describe the checkbox, the
one-time host setup (`claude setup-token` → `.env`; `codex login` on the host), and the plain
blast-radius warning. Placeholders only.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: document AI CLI auth seeding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
