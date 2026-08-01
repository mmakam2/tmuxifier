# Agent-State Ground Truth via Claude Code Hooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-01-agent-state-hooks-design.md`

**Goal:** Replace the output-idle heuristic for Claude agent state with ground truth from Claude Code lifecycle hooks, delivered via a marker file on the box that the existing SSH status probe reads.

**Architecture:** A new `claudeAgentHooks.js` (structural twin of `claudeStatusline.js`) pushes a POSIX-sh hook script to the box and merges five hook entries into Claude's settings.json (remove-then-append, jq → node → python3 chain). The hook writes `<session>:<state>:<epoch>` marker files under `~/.tmuxifier-agent/`; `PROBE_REMOTE` gains a static `__AGENT__` emitter; `parseAgentMarks` allowlists the content; `sampleOf` prefers a marker over the heuristic (`agentSrc: 'hook'`); `classifyTransitions` skips the anti-blip streak for hook-sourced samples. `setupManager` runs the push as an always-on `agent-hooks` phase (no option flag — the box decides via `command -v claude`).

**Tech Stack:** Node 20+ ESM, plain `.js` server, POSIX sh assets, vitest (environment: node — no DOM), TypeScript web client.

## Global Constraints

- TDD with real code, not mocks (dependency-injected factories; shell scripts run for real via `/bin/sh` in tests).
- No PII in committed files: hosts are `192.168.1.10`-style placeholders, labels generic.
- The installer script text interpolates NO input; the hook script bytes travel on stdin (`boxActions.execScriptStdin`).
- Hook `matcher` field is OMITTED everywhere: unsupported on `UserPromptSubmit`/`Stop`, optional on `Notification`/`SessionStart`/`SessionEnd` (verified against current Claude Code docs 2026-08-01).
- settings.json writes are atomic (temp + rename); fresh files are `chmod 600`.
- A push failure/skip is recorded on the job, never promoted to a job failure.
- `SessionEnd` hooks share a ~1.5s budget in Claude Code — the `end` path must stay one `rm -f`.
- Marker content is box-controlled input: state is a closed `working|waiting` allowlist, ts must be a finite positive number, lines capped at 200 bytes on the box.
- Existing behavior must not change for boxes/sessions without markers (heuristic path untouched; no `agentSrc` field on heuristic samples — existing `toEqual` tests rely on exact sample shapes).

---

### Task 1: Hook script asset

**Files:**
- Create: `src/server/assets/tmuxifier-agent-hook.sh`
- Test: `test/claudeAgentHooks.test.js` (hook-script section)

**Interfaces:**
- Produces: the asset file whose bytes Task 2's pusher pipes to the box; marker file format `<session>:<state>:<epoch>\n` at `~/.tmuxifier-agent/<sanitized-session>`; event args `prompt|stop|notify|start|end`.

- [ ] **Step 1: Write the failing tests**

Create `test/claudeAgentHooks.test.js`:

```js
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));

// Run the real asset under /bin/sh with a controlled env. stdin carries a
// fake event JSON, as Claude Code does; the script must drain and ignore it.
function runHook(arg, env) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK_ASSET, arg], { env }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end('{"session_id":"x","hook_event_name":"Stop"}');
  });
}

// A fake tmux on PATH: the hook only calls `tmux display-message -p '#S'`.
async function hookEnv(sessionName) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenthook-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' '${sessionName}'\n`, { mode: 0o755 });
  return { dir, env: { HOME: dir, TMUX: '/tmp/tmux-0/default,123,0', PATH: `${bin}:/usr/bin:/bin` } };
}

test('outside tmux: exits 0 and writes nothing', async () => {
  const { dir, env } = await hookEnv('web');
  delete env.TMUX;
  const res = await runHook('prompt', env);
  expect(res.code).toBe(0);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent'))).rejects.toBeTruthy();
});

test('prompt writes a working marker named after the session', async () => {
  const { dir, env } = await hookEnv('web');
  const res = await runHook('prompt', env);
  expect(res.code).toBe(0);
  const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'web'), 'utf8');
  expect(content).toMatch(/^web:working:\d+\n$/);
});

test('stop, notify and start all write waiting', async () => {
  const { dir, env } = await hookEnv('web');
  for (const ev of ['stop', 'notify', 'start']) {
    await runHook(ev, env);
    const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'web'), 'utf8');
    expect(content).toMatch(/^web:waiting:\d+\n$/);
  }
});

test('end deletes the marker', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('stop', env);
  await runHook('end', env);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent', 'web'))).rejects.toBeTruthy();
});

test('unknown event is a no-op; session name is sanitized in the filename but exact in the content', async () => {
  const { dir, env } = await hookEnv('a b/c');
  await runHook('bogus', env);
  await expect(fs.access(path.join(dir, '.tmuxifier-agent'))).rejects.toBeTruthy();
  await runHook('stop', env);
  const content = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'a_b_c'), 'utf8');
  expect(content).toMatch(/^a b\/c:waiting:\d+\n$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: FAIL — `/bin/sh` cannot open the missing asset (non-zero exit / ENOENT).

- [ ] **Step 3: Write the asset**

Create `src/server/assets/tmuxifier-agent-hook.sh`:

```sh
#!/bin/sh
# Tmuxifier agent-state hook (installed by box setup; safe to delete — the
# next setup run reinstalls it). Claude Code invokes it with the event name
# as $1 and the event JSON on stdin; the JSON is drained and discarded.
# Writes one line — <session>:<state>:<epoch> — to ~/.tmuxifier-agent/<file>
# for the Tmuxifier status probe. Colons are safe separators: tmux forbids
# them in session names. No set -e: a hook failure must never surface into
# the Claude session, so every path is guarded instead.
cat >/dev/null 2>&1 || true
[ -n "${TMUX:-}" ] || exit 0
SESSION=$(tmux display-message -p '#S' 2>/dev/null) || exit 0
[ -n "$SESSION" ] || exit 0
DIR="$HOME/.tmuxifier-agent"
SAFE=$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9._-' '_')
FILE="$DIR/$SAFE"
case "${1:-}" in
  prompt) STATE=working ;;
  stop|notify|start) STATE=waiting ;;
  end) rm -f "$FILE"; exit 0 ;;
  *) exit 0 ;;
esac
mkdir -p "$DIR"
# Self-prune markers for sessions that died without a SessionEnd.
find "$DIR" -type f -mtime +7 -exec rm -f {} + 2>/dev/null || true
printf '%s:%s:%s\n' "$SESSION" "$STATE" "$(date +%s)" > "$FILE.$$.tmp" && mv "$FILE.$$.tmp" "$FILE"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/assets/tmuxifier-agent-hook.sh test/claudeAgentHooks.test.js
git commit -m "feat(agent-hooks): on-box hook script writing per-session state markers"
```

---

### Task 2: Installer builder + pusher (`claudeAgentHooks.js`)

**Files:**
- Create: `src/server/claudeAgentHooks.js`
- Test: `test/claudeAgentHooks.test.js` (append installer/pusher sections)

**Interfaces:**
- Consumes: the Task 1 asset (via injected `readAsset`).
- Produces: `buildAgentHooksInstallScript(): string`; `createAgentHooksPusher({ runStdin, readAsset })` → `{ push(box): Promise<{ target: 'agent-hooks', ok: boolean, skipped?: string, error?: string }> }`. Output markers `AGENTHOOKS: applied | skipped-no-claude | error-no-json-tool`.

- [ ] **Step 1: Write the failing tests**

Append to `test/claudeAgentHooks.test.js` (reuse the existing imports; add the module import and the `runShell` helper copied from `test/claudeStatusline.test.js`):

```js
import { buildAgentHooksInstallScript, createAgentHooksPusher } from '../src/server/claudeAgentHooks.js';

function runShell(script, env, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}

async function claudeBox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  return { dir, cfg: path.join(dir, '.claude'), env: (extra = '') => ({ HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: `${bin}${extra}:/usr/bin:/bin` }) };
}

const TMUXIFIER_CMD = 'tmuxifier-agent-hook.sh';

test('builder emits the presence check, the literal config-dir command, and matcher-free entries', () => {
  const s = buildAgentHooksInstallScript();
  expect(s).toContain('command -v claude');
  expect(s).toContain('AGENTHOOKS: skipped-no-claude');
  expect(s).toContain('AGENTHOOKS: applied');
  expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh');
  expect(s).not.toContain('"matcher"');
});

test('installer without claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ah-'));
  const res = await runShell(buildAgentHooksInstallScript(), { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), PATH: '/usr/bin:/bin' }, 'HOOK-BYTES');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: skipped-no-claude');
  await expect(fs.access(path.join(dir, '.claude'))).rejects.toBeTruthy();
});

test('installer with claude, no settings.json: writes hook script + fresh settings with all five events', async () => {
  const b = await claudeBox();
  const res = await runShell(buildAgentHooksInstallScript(), b.env(), '#!/bin/sh\necho hook\n');
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('AGENTHOOKS: applied');
  const hook = await fs.readFile(path.join(b.cfg, 'tmuxifier-agent-hook.sh'), 'utf8');
  expect(hook).toContain('echo hook');
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd']) {
    expect(settings.hooks[ev]).toHaveLength(1);
    expect(settings.hooks[ev][0].hooks[0].command).toContain(TMUXIFIER_CMD);
    expect(settings.hooks[ev][0]).not.toHaveProperty('matcher');
  }
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/ prompt$/);
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toMatch(/ end$/);
});

test('installer merge preserves foreign keys and foreign hooks, and is idempotent across reruns', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  await fs.writeFile(path.join(b.cfg, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop-hook.sh' }] }] },
  }, null, 2));
  await runShell(buildAgentHooksInstallScript(), b.env(), 'H');
  await runShell(buildAgentHooksInstallScript(), b.env(), 'H'); // rerun: must not duplicate
  const settings = JSON.parse(await fs.readFile(path.join(b.cfg, 'settings.json'), 'utf8'));
  expect(settings.model).toBe('opus');
  const stopCmds = settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
  expect(stopCmds.filter((c) => c.includes('my-own-stop-hook'))).toHaveLength(1);
  expect(stopCmds.filter((c) => c.includes(TMUXIFIER_CMD))).toHaveLength(1);
  expect(settings.hooks.UserPromptSubmit.flatMap((e) => e.hooks).filter((h) => h.command.includes(TMUXIFIER_CMD))).toHaveLength(1);
});

test('pusher maps applied → ok, skipped → skipped, failure → error, and pipes the asset bytes', async () => {
  const ok = createAgentHooksPusher({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: applied\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await ok.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: true });
  const skip = createAgentHooksPusher({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: skipped-no-claude\n' }),
    readAsset: async () => Buffer.from('A'),
  });
  expect(await skip.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' });
  let piped = null;
  const fail = createAgentHooksPusher({
    runStdin: async (_box, _script, input) => { piped = input; return { code: 4, stdout: 'AGENTHOOKS: error-no-json-tool\n' }; },
    readAsset: async () => Buffer.from('ASSET-BYTES'),
  });
  expect(await fail.push({ id: 'b' })).toEqual({ target: 'agent-hooks', ok: false, error: 'agent hooks push failed' });
  expect(piped.toString()).toBe('ASSET-BYTES');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: FAIL — `Cannot find module '../src/server/claudeAgentHooks.js'`.

- [ ] **Step 3: Write the module**

Create `src/server/claudeAgentHooks.js`:

```js
// Push the Tmuxifier agent-state hook to a box. Structural twin of
// claudeStatusline.js: a pure remote-installer builder + a small DI pusher,
// run as a post-setup step. The apply-or-skip decision is made ON THE BOX by
// a command -v claude presence check — always-on, no option flag (the
// framework-clamps precedent: run every setup, gate on evidence).
//
// The installer script text goes into ssh argv and interpolates NO input;
// the hook script bytes arrive on stdin.
//
// settings.json's `hooks` entries are ARRAYS of matcher objects (unlike the
// single .statusLine key), so the merge is remove-then-append per event:
// drop any entry whose serialized form mentions tmuxifier-agent-hook, then
// append ours — idempotent across reruns, never touches the operator's own
// hooks. `matcher` is omitted everywhere: unsupported on UserPromptSubmit
// and Stop, optional on the other three.

const HOOK_EVENTS = [
  ['UserPromptSubmit', 'prompt'],
  ['Stop', 'stop'],
  ['Notification', 'notify'],
  ['SessionStart', 'start'],
  ['SessionEnd', 'end'],
];

// The command value, written LITERALLY — its ${...} is expanded later by the
// shell Claude Code spawns for the hook, not at install time.
const hookEntry = (arg) => ({
  hooks: [{ type: 'command', command: 'sh "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh" ' + arg }],
});

const HOOKS_JSON = JSON.stringify(Object.fromEntries(HOOK_EVENTS.map(([ev, arg]) => [ev, [hookEntry(arg)]])));

export function buildAgentHooksInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'HOOK="$DIR/tmuxifier-agent-hook.sh"',
    'SETTINGS="$DIR/settings.json"',
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'AGENTHOOKS: skipped-no-claude'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the hook script from stdin.',
    'mkdir -p "$DIR"',
    'cat > "$HOOK"',
    'chmod 755 "$HOOK"',
    '',
    '# 3. The entries to merge. Quoted heredoc: ${...} stays literal.',
    "NEW=$(cat <<'TMUXIFIER_HOOKS_EOF'",
    HOOKS_JSON,
    'TMUXIFIER_HOOKS_EOF',
    ')',
    '',
    '# 4. Merge into settings.json: remove-then-append per event, atomically.',
    'if [ ! -f "$SETTINGS" ]; then',
    '  printf \'{"hooks":%s}\\n\' "$NEW" > "$SETTINGS"',
    '  chmod 600 "$SETTINGS"',
    "  echo 'AGENTHOOKS: applied'",
    '  exit 0',
    'fi',
    'TMP="$SETTINGS.tmuxifier.tmp"',
    'if command -v jq >/dev/null 2>&1; then',
    '  jq --argjson new "$NEW" \'.hooks = (.hooks // {}) | reduce ($new | keys_unsorted[]) as $ev (.; .hooks[$ev] = ([(.hooks[$ev] // [])[] | select((tojson | contains("tmuxifier-agent-hook")) | not)] + $new[$ev]))\' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"',
    'elif command -v node >/dev/null 2>&1; then',
    '  node -e \'const fs=require("fs");const p=process.argv[1];const add=JSON.parse(process.argv[2]);const d=JSON.parse(fs.readFileSync(p,"utf8"));d.hooks=(d.hooks&&typeof d.hooks==="object"&&!Array.isArray(d.hooks))?d.hooks:{};for(const ev of Object.keys(add)){const cur=Array.isArray(d.hooks[ev])?d.hooks[ev]:[];d.hooks[ev]=cur.filter((e)=>!JSON.stringify(e).includes("tmuxifier-agent-hook")).concat(add[ev]);}const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p)\' "$SETTINGS" "$NEW"',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 -c \'import json,sys,os',
    'p=sys.argv[1];add=json.loads(sys.argv[2]);d=json.load(open(p))',
    'h=d.get("hooks") if isinstance(d.get("hooks"),dict) else {}',
    'd["hooks"]=h',
    'for ev,entries in add.items():',
    '    cur=h.get(ev) if isinstance(h.get(ev),list) else []',
    '    h[ev]=[e for e in cur if "tmuxifier-agent-hook" not in json.dumps(e)]+entries',
    't=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p)\' "$SETTINGS" "$NEW"',
    'else',
    "  echo 'AGENTHOOKS: error-no-json-tool'",
    '  exit 4',
    'fi',
    "echo 'AGENTHOOKS: applied'",
  ].join('\n');
}

export function createAgentHooksPusher({ runStdin, readAsset }) {
  return {
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'agent-hooks', ok: false, error: 'agent hook asset unavailable' }; }
      const res = await runStdin(box, buildAgentHooksInstallScript(), bytes);
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/AGENTHOOKS:\s*skipped-no-claude/.test(out)) return { target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' };
        if (/AGENTHOOKS:\s*applied/.test(out)) return { target: 'agent-hooks', ok: true };
      }
      return { target: 'agent-hooks', ok: false, error: 'agent hooks push failed' };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: PASS. Note the merge test exercises whichever of jq/node/python3 is first on the dev host; the chain order itself is covered by the statusline precedent and the fresh-file path needs none of them.

- [ ] **Step 5: Commit**

```bash
git add src/server/claudeAgentHooks.js test/claudeAgentHooks.test.js
git commit -m "feat(agent-hooks): installer builder + pusher with remove-then-append settings merge"
```

---

### Task 3: Probe line + `parseAgentMarks` (`status.js`)

**Files:**
- Modify: `src/server/status.js` (PROBE_REMOTE composition ~line 51, `parseTmuxSessions` ~line 114, `probe()` return ~line 180)
- Test: `test/status.test.js`

**Interfaces:**
- Produces: `parseAgentMarks(stdout): { [session]: { state: 'working'|'waiting', ts: number } } | null` (exported); probe status objects gain optional `agentMarks`.

- [ ] **Step 1: Write the failing tests**

Append to `test/status.test.js` (add `parseAgentMarks` to the existing import from `../src/server/status.js`):

```js
test('PROBE_REMOTE emits __AGENT__ lines from the marker dir, statically', () => {
  expect(PROBE_REMOTE).toContain('.tmuxifier-agent');
  expect(PROBE_REMOTE).toContain('__AGENT__');
  expect(PROBE_REMOTE).toContain('head -c 200');
});

test('parseAgentMarks extracts allowlisted marker lines', () => {
  const out = '__META__ cpus=2\n__AGENT__ web:working:1718000000\n__AGENT__ ops:waiting:1718000001\nweb:2:1:1718000000:claude\n';
  expect(parseAgentMarks(out)).toEqual({
    web: { state: 'working', ts: 1718000000 },
    ops: { state: 'waiting', ts: 1718000001 },
  });
});

test('parseAgentMarks drops bad state, bad ts, malformed lines, and returns null when nothing survives', () => {
  expect(parseAgentMarks('__AGENT__ web:running:1718000000\n')).toBeNull();   // state not in allowlist
  expect(parseAgentMarks('__AGENT__ web:working:soon\n')).toBeNull();          // non-numeric ts
  expect(parseAgentMarks('__AGENT__ web:working:0\n')).toBeNull();             // non-positive ts
  expect(parseAgentMarks('__AGENT__ web:working\n')).toBeNull();               // missing field
  expect(parseAgentMarks('__AGENT__ :working:5\n')).toBeNull();                // empty session
  expect(parseAgentMarks('web:2:1:1718000000:claude\n')).toBeNull();           // no marker line at all
});

test('parseTmuxSessions ignores __AGENT__ lines', () => {
  const out = '__AGENT__ web:working:1718000000\nweb:2:1:1718000000:claude\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/status.test.js`
Expected: FAIL — `parseAgentMarks` is not exported; the PROBE_REMOTE assertions fail.

- [ ] **Step 3: Implement**

In `src/server/status.js`, insert after the `META_PROBE` constant:

```js
// Marker files written by the on-box Claude Code hook (claudeAgentHooks.js):
// one `__AGENT__ <session>:<state>:<epoch>` line each. Static and
// non-interpolated like META_PROBE — no box field reaches it — and fully
// stderr-silenced so a missing dir or unreadable file can't disturb the
// reachability classifier. head caps a corrupted marker before it can flood
// probe stdout; tr strips the trailing newline so each marker is one line.
const AGENT_PROBE =
  `if [ -d "$HOME/.tmuxifier-agent" ]; then for f in "$HOME"/.tmuxifier-agent/*; do ` +
  `[ -f "$f" ] && { printf '__AGENT__ '; head -c 200 "$f" | tr -d '\\n'; echo; }; done; fi 2>/dev/null; `;
```

Change the `PROBE_REMOTE` export to include it:

```js
export const PROBE_REMOTE =
  `${META_PROBE} ${AGENT_PROBE}if command -v tmux >/dev/null 2>&1; then tmux ls -F '${STATUS_FMT}' 2>/dev/null || true; else echo __NO_TMUX__; fi`;
```

Add the parser (near `parseMeta`):

```js
// Pull `__AGENT__` marker lines into { session: { state, ts } }. Marker
// content is a file on the box, so it is input — state is a closed two-value
// allowlist and ts must be a finite positive number; anything else drops.
// Colons cannot appear in tmux session names (the invariant STATUS_FMT
// already relies on), so the split is unambiguous.
export function parseAgentMarks(stdout) {
  const out = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('__AGENT__ ')) continue;
    const parts = line.slice('__AGENT__ '.length).split(':');
    if (parts.length !== 3) continue;
    const [session, state, tsRaw] = parts;
    const ts = Number(tsRaw);
    if (!session || (state !== 'working' && state !== 'waiting') || !Number.isFinite(ts) || ts <= 0) continue;
    out[session] = { state, ts };
  }
  return Object.keys(out).length ? out : null;
}
```

In `parseTmuxSessions`, extend the filter:

```js
    .filter((l) => l.trim() && !l.includes('__NO_TMUX__') && !l.startsWith('__META__') && !l.startsWith('__AGENT__'))
```

In `probe()` (inside `createStatusChecker`), attach the marks:

```js
      const metrics = parseMeta(res.stdout);
      deriveCpuPct(box, metrics);
      const agentMarks = parseAgentMarks(res.stdout);
      const base = String(res.stdout).includes('__NO_TMUX__')
        ? { reachable: true, tmux: false, sessions: [] }
        : { reachable: true, tmux: true, sessions: parseTmuxSessions(res.stdout) };
      const withMeta = metrics ? { ...base, metrics } : base;
      return agentMarks ? { ...withMeta, agentMarks } : withMeta;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/status.test.js`
Expected: PASS, including all pre-existing tests (the `__AGENT__`-free fixtures are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js test/status.test.js
git commit -m "feat(status): read agent-state markers in the probe (__AGENT__ line + parseAgentMarks)"
```

---

### Task 4: Marker-wins derivation (`healthHistory.js`)

**Files:**
- Modify: `src/server/healthHistory.js` (`sampleOf` claude branch ~lines 56–69; `classifyTransitions` agent-input condition ~line 145)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- Consumes: `status.agentMarks` from Task 3.
- Produces: samples gain `agentSrc: 'hook'` ONLY when marker-sourced (heuristic samples keep their exact current shape); hook-sourced working→waiting edges fire `agent-input` without the streak requirement.

- [ ] **Step 1: Write the failing tests**

Append to `test/healthHistory.test.js` (the file already defines `TH`, `AGENT = { agentIdleSec: 45, sessionName: 'web' }` and a `withAgent()` fixture helper around line 181 — reuse its shape):

```js
test('sampleOf: a hook marker wins over the idle heuristic in both directions', () => {
  // Marker says waiting although output is fresh (the parked-pane blip shape).
  const busy = {
    reachable: true, tmux: true,
    metrics: { boxNowSec: 1000 },
    sessions: [{ name: 'web', windows: 1, attached: false, activity: 999, paneCmd: 'claude' }],
    agentMarks: { web: { state: 'waiting', ts: 990 } },
  };
  const s1 = sampleOf(busy, 5, AGENT);
  expect(s1.agent).toBe('waiting');
  expect(s1.agentSrc).toBe('hook');
  // Marker says working although output has been idle past the threshold.
  const quiet = {
    ...busy,
    sessions: [{ name: 'web', windows: 1, attached: false, activity: 100, paneCmd: 'claude' }],
    agentMarks: { web: { state: 'working', ts: 90 } },
  };
  const s2 = sampleOf(quiet, 5, AGENT);
  expect(s2.agent).toBe('working');
  expect(s2.agentSrc).toBe('hook');
});

test('sampleOf: hook marker needs no box clock (no unknown on the hook path)', () => {
  const noClock = {
    reachable: true, tmux: true,
    sessions: [{ name: 'web', windows: 1, attached: false, activity: 999, paneCmd: 'claude' }],
    agentMarks: { web: { state: 'working', ts: 990 } },
  };
  expect(sampleOf(noClock, 5, AGENT).agent).toBe('working');
});

test('sampleOf: marker for another session is ignored, and no claude pane means no agent at all', () => {
  const otherSession = {
    reachable: true, tmux: true, metrics: { boxNowSec: 1000 },
    sessions: [{ name: 'web', windows: 1, attached: false, activity: 999, paneCmd: 'claude' }],
    agentMarks: { ops: { state: 'waiting', ts: 990 } },
  };
  const s = sampleOf(otherSession, 5, AGENT);
  expect(s.agent).toBe('working');          // falls back to the heuristic
  expect(s.agentSrc).toBeUndefined();       // heuristic samples carry no source tag
  const noClaude = {
    reachable: true, tmux: true, metrics: { boxNowSec: 1000 },
    sessions: [{ name: 'web', windows: 1, attached: false, activity: 100, paneCmd: 'bash' }],
    agentMarks: { web: { state: 'working', ts: 90 } },
  };
  expect(sampleOf(noClaude, 5, AGENT).agent).toBeUndefined(); // stale marker for an exited claude is inert
});

test('classifyTransitions: hook-sourced working→waiting fires agent-input without the streak', () => {
  let st = initThresholdState();
  st.agentWorkStreak = 1; // below AGENT_WORK_MIN_SAMPLES
  const r = classifyTransitions(
    { up: true, agent: 'working', agentSrc: 'hook' },
    { up: true, agent: 'waiting' },
    TH, st,
  );
  expect(r.events).toEqual([{ kind: 'agent-input' }]);
});

test('classifyTransitions: heuristic-sourced short run still needs the streak (blip guard intact)', () => {
  let st = initThresholdState();
  st.agentWorkStreak = 1;
  const r = classifyTransitions(
    { up: true, agent: 'working' },
    { up: true, agent: 'waiting' },
    TH, st,
  );
  expect(r.events).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthHistory.test.js`
Expected: FAIL — `agentSrc` undefined on the marker samples; the hook-source edge test emits no event.

- [ ] **Step 3: Implement**

In `sampleOf`, replace the body of the `if (/^claude(-|$)/...)` branch:

```js
      if (/^claude(-|$)/.test(String(sess.paneCmd || ''))) {
        const mark = s.agentMarks && s.agentMarks[sessionName];
        if (mark) {
          // Hook-sourced ground truth (claudeAgentHooks.js): the on-box hook
          // recorded the last lifecycle edge, so no clock math and no
          // 'unknown' path. Presence still comes from paneCmd above — a
          // stale marker for an exited claude is inert. The source tag is
          // only set here so heuristic samples keep their exact shape.
          sample.agent = mark.state;
          sample.agentSrc = 'hook';
        } else {
          // `sess.activity` is the pane's last-OUTPUT time (status.js probes
          // #{window_activity}, not #{session_activity} — see the note there).
          // An absent or unparseable timestamp gets the same 'unknown' treatment
          // as a missing clock: reading it as 0 would make the idle interval
          // enormous and report a confident 'waiting' for a working agent.
          const activity = Number(sess.activity);
          if (m && m.boxNowSec != null && Number.isFinite(activity) && activity > 0) {
            const idleSec = m.boxNowSec - activity;
            sample.agent = idleSec >= Number(agentIdleSec ?? 20) ? 'waiting' : 'working';
          } else {
            sample.agent = 'unknown';
          }
        }
      }
```

In `classifyTransitions`, change the agent-input condition (and extend the comment above it with one sentence: hook-sourced samples skip the streak because the blip false-positive is a heuristic-only artifact):

```js
    if (prev.agent === 'working' && next.agent === 'waiting' && !next.agentAttached
        && (prev.agentSrc === 'hook' || observedRun >= AGENT_WORK_MIN_SAMPLES)) {
      events.push({ kind: 'agent-input' });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthHistory.test.js`
Expected: PASS, including every pre-existing sample-shape test (no `agentSrc` leaks onto heuristic samples).

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): hook markers override the agent idle heuristic; hook edges skip the blip streak"
```

---

### Task 5: `agent-hooks` setup phase + wiring

**Files:**
- Modify: `src/server/setupManager.js` (factory params ~line 53, `summary()` ~line 100, `completeDone()` ~line 146)
- Modify: `src/server/index.js` (imports ~line 42, pusher construction ~line 114, setupManager wiring ~line 143)
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes: `createAgentHooksPusher(...).push(box)` from Task 2.
- Produces: `createSetupManager({ ..., pushAgentHooks })`; job phase `'agent-hooks'`; `job.agentHooks` in `summary()` (shape: the pusher result object).

- [ ] **Step 1: Write the failing tests**

Append to `test/setupManager.test.js` (uses the existing `make`, `BOX`, `waitFor` helpers):

```js
test('agent-hooks push runs on done with NO option gate, and lands in the summary', async () => {
  const seen = [];
  const m = make({ pushAgentHooks: async (box) => { seen.push(box.id); return { target: 'agent-hooks', ok: true }; } });
  const s = m.start(BOX, {}); // empty options: the push must still run
  await m._settled(s.id);
  expect(seen).toEqual(['b1']);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.agentHooks).toEqual({ target: 'agent-hooks', ok: true });
  expect(m.listJobs()[0].agentHooks).toEqual({ target: 'agent-hooks', ok: true });
});

test('agent-hooks push failure is recorded, never promoted to a job failure', async () => {
  const m = make({ pushAgentHooks: async () => { throw new Error('boom'); } });
  const s = m.start(BOX, {});
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.agentHooks).toEqual({ target: 'agent-hooks', ok: false, error: 'agent hooks push failed' });
});

test('agent-hooks runs after statusline and before ensureSession', async () => {
  const order = [];
  const m = make({
    pushStatusline: async () => { order.push('statusline'); return { target: 'statusline', ok: true }; },
    pushAgentHooks: async () => { order.push('agent-hooks'); return { target: 'agent-hooks', ok: true }; },
    ensureSession: async () => { order.push('session'); },
  });
  const s = m.start(BOX, { claudeStatusline: true });
  await m._settled(s.id);
  expect(order).toEqual(['statusline', 'agent-hooks', 'session']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js`
Expected: FAIL — `job.agentHooks` undefined (the unknown `pushAgentHooks` override is ignored by the factory).

- [ ] **Step 3: Implement**

In `createSetupManager`'s parameters, after `pushStatusline = null,` add:

```js
  // Post-setup agent-state hooks push (claudeAgentHooks.js). Default null:
  // an unwired manager skips the step, which is what existing tests
  // construct. Unlike seed/statusline there is NO options gate — the push is
  // always-on and the box decides via its own command -v claude check.
  pushAgentHooks = null,
```

In `completeDone()`, after the `pushStatusline` block and before the `ensureSession` block, add:

```js
    // Push the agent-state hooks (always-on; see claudeAgentHooks.js). The
    // box decides via a command -v claude check, so a box without Claude
    // yields a recorded skip. A skip/failure is recorded, never promoted.
    if (pushAgentHooks && box && !j.cancelled) {
      j.phase = 'agent-hooks';
      persist();
      try { j.agentHooks = await pushAgentHooks(box); }
      catch { j.agentHooks = { target: 'agent-hooks', ok: false, error: 'agent hooks push failed' }; }
    }
```

In `summary()`, add `agentHooks: j.agentHooks ?? null,` after `statusline: j.statusline ?? null,`.

In `src/server/index.js`: add the import

```js
import { createAgentHooksPusher } from './claudeAgentHooks.js';
```

after the `createStatuslinePusher` import; construct the pusher directly below `statuslinePusher`:

```js
const agentHooksPusher = createAgentHooksPusher({
  runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input),
  readAsset: () => fs.promises.readFile(new URL('./assets/tmuxifier-agent-hook.sh', import.meta.url)),
});
```

and wire it into `createSetupManager` after `pushStatusline`:

```js
  pushAgentHooks: (box) => agentHooksPusher.push(box),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS, all pre-existing tests included (unwired managers skip the phase).

- [ ] **Step 5: Commit**

```bash
git add src/server/setupManager.js src/server/index.js test/setupManager.test.js
git commit -m "feat(setup): always-on agent-hooks phase after statusline, recorded on the job"
```

---

### Task 6: Web client surface

**Files:**
- Modify: `src/web/api.ts` (SetupJob ~line 189, SeedResult ~line 204)
- Modify: `src/web/setupStatus.ts` (phase text ~line 8)
- Modify: `src/web/main.ts` (done-outcome rendering ~lines 1787–1790)
- Test: `test/setupStatus.test.js`

**Interfaces:**
- Consumes: `job.agentHooks` and phase `'agent-hooks'` from Task 5's API responses.
- Produces: `setupStatusText` returns `'Installing agent hooks…'` for the phase; the done-status line appends the agent-hooks outcome via the existing `formatStatuslineResult` (its input shape is target-generic).

- [ ] **Step 1: Write the failing test**

Append to `test/setupStatus.test.js`:

```js
test('running job in the agent-hooks phase reads as installing agent hooks', () => {
  expect(setupStatusText({ status: 'running', phase: 'agent-hooks', error: null, needs: null }))
    .toBe('Installing agent hooks…');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setupStatus.test.js`
Expected: FAIL — returns the generic `'Running setup…'` fallback.

- [ ] **Step 3: Implement**

`src/web/api.ts` — extend the phase union and SeedResult target, and add the field:

```ts
  phase: 'waiting-ssh' | 'running' | 'seeding' | 'statusline' | 'agent-hooks' | null; options: SetupOptions; error: string | null;
```

```ts
  // Present once the always-on agent-hooks push has attempted (done jobs).
  agentHooks?: SeedResult | null;
```

```ts
export interface SeedResult { target: 'claude' | 'codex' | 'all' | 'statusline' | 'agent-hooks'; ok: boolean; skipped?: string; error?: string }
```

`src/web/setupStatus.ts` — add the phase branch after the statusline one:

```ts
        : job.phase === 'statusline' ? 'Configuring statusline…'
        : job.phase === 'agent-hooks' ? 'Installing agent hooks…'
```

Also update `formatStatuslineResult`'s comment to note it formats any single push result (statusline or agent-hooks) — the body is already target-generic.

`src/web/main.ts` — in the `job.status === 'done'` branch, after the `slTxt` lines:

```ts
        const ahTxt = formatStatuslineResult(job.agentHooks);
        if (ahTxt) status.textContent = `${status.textContent} · ${ahTxt}`;
        // An outcome deserves longer on screen than a bare success.
        autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), (seedTxt || slTxt || ahTxt) ? 5000 : 2000);
```

(replacing the existing `autoCloseTimer` line so the condition includes `ahTxt`).

- [ ] **Step 4: Run test and typecheck to verify they pass**

Run: `npx vitest run test/setupStatus.test.js && npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/setupStatus.ts src/web/main.ts test/setupStatus.test.js
git commit -m "feat(ui): agent-hooks setup phase label and done-outcome line"
```

---

### Task 7: Integration round trip (localBox)

**Files:**
- Create: `test/agentHooks.integration.test.js`

**Interfaces:**
- Consumes: Task 1's asset, Task 3's `PROBE_REMOTE`/`parseAgentMarks`, `test/helpers/localBox.js` (`setupLocalBox()` → `{ home, env, box, sshConfigFile, cleanup }`).

- [ ] **Step 1: Write the test**

Create `test/agentHooks.integration.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { PROBE_REMOTE, parseAgentMarks } from '../src/server/status.js';

let lb; let teardown;
afterEach(async () => {
  if (lb) {
    try { await sshRun(['-F', lb.sshConfigFile, lb.box.host, 'tmux kill-session -t agenthooks 2>/dev/null || true'], { env: lb.env }); } catch {}
  }
  if (teardown) await teardown();
  teardown = null;
});

test('hook script → marker file → PROBE_REMOTE → parseAgentMarks round trip', async () => {
  lb = await setupLocalBox();
  teardown = lb.cleanup;
  // Install the real asset into the box home (the same bytes setup pushes).
  const asset = await fs.readFile(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url), 'utf8');
  await fs.writeFile(path.join(lb.home, 'tmuxifier-agent-hook.sh'), asset, { mode: 0o755 });
  // Real tmux session; run the hook INSIDE the pane so $TMUX and the session
  // name resolve exactly as they do under a live claude. </dev/null because
  // send-keys gives the script a tty stdin the drain would otherwise block on.
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, 'tmux new-session -d -s agenthooks'], { env: lb.env });
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, "tmux send-keys -t agenthooks 'sh ~/tmuxifier-agent-hook.sh stop </dev/null' Enter"], { env: lb.env });
  // Poll for the marker (send-keys is asynchronous).
  const marker = path.join(lb.home, '.tmuxifier-agent', 'agenthooks');
  let content = '';
  for (let i = 0; i < 30 && !content; i++) {
    await new Promise((r) => setTimeout(r, 200));
    content = await fs.readFile(marker, 'utf8').catch(() => '');
  }
  expect(content).toMatch(/^agenthooks:waiting:\d+\n$/);
  // Full probe over real ssh: the marker line and the session line coexist.
  const res = await sshRun(['-F', lb.sshConfigFile, lb.box.host, PROBE_REMOTE], { env: lb.env });
  const marks = parseAgentMarks(res.stdout);
  expect(marks).toBeTruthy();
  expect(marks.agenthooks).toMatchObject({ state: 'waiting' });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/agentHooks.integration.test.js`
Expected: PASS. If it fails on the marker poll, debug the hook script against the fixture home before touching the probe half (the two halves fail independently by design).

- [ ] **Step 3: Commit**

```bash
git add test/agentHooks.integration.test.js
git commit -m "test(agent-hooks): end-to-end marker → probe round trip on the isolated local box"
```

---

### Task 8: Docs + full suite

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (module list), `docs/boxes-and-setup.md`, `docs/fleet-and-health.md`

- [ ] **Step 1: CLAUDE.md and AGENTS.md module entries**

In both files' architecture module list, insert after the `claudeStatusline.js` entry:

```markdown
- `claudeAgentHooks.js` — `buildAgentHooksInstallScript` (pure) + `createAgentHooksPusher`: the
  always-on push of the agent-state hook (`src/server/assets/tmuxifier-agent-hook.sh`) to a box.
  Structural twin of `claudeStatusline.js` — script text interpolates nothing, the hook file
  arrives on stdin, the box decides via `command -v claude` — but with no option gate (the
  framework-clamps precedent) and an array-aware settings.json merge: `hooks` entries are
  arrays, so the merge is remove-then-append per event (drop entries mentioning
  `tmuxifier-agent-hook`, append ours), idempotent across reruns and blind to the operator's
  own hooks. The hook writes `<session>:<state>:<epoch>` markers under `~/.tmuxifier-agent/`
  on UserPromptSubmit/Stop/Notification/SessionStart and deletes on SessionEnd; the status
  probe reads them back (`parseAgentMarks` in `status.js`) and `sampleOf` prefers a marker
  over the output-idle heuristic (`agentSrc: 'hook'`, no 'unknown' path), which also lets
  `classifyTransitions` skip the anti-blip streak for hook-sourced edges. Run by
  `setupManager.js` as the post-statusline `agent-hooks` phase, recorded on `job.agentHooks`,
  never promoted to a job failure.
```

Also append one sentence to the `status.js` entry: the probe now also emits `__AGENT__` marker lines from `~/.tmuxifier-agent/` (allowlisted by `parseAgentMarks`, same input-distrust as `osId`/`osVer`), and one to the `healthHistory.js` entry: agent state is hook-sourced ground truth when a marker exists, heuristic otherwise.

- [ ] **Step 2: User-facing guides**

`docs/boxes-and-setup.md` — add a short "Agent-state hooks" subsection to the setup-steps area:

```markdown
### Agent-state hooks

Every setup run installs a small Claude Code hook on the box (skipped automatically when
Claude Code is not installed). The hook records whether the agent is working or waiting for
you — the dashboard's agent chip and the "agent needs input" notifications read this instead
of guessing from terminal output, so they react faster and never false-positive on an idle
session. It never blocks or modifies the agent: it only writes a one-line state file under
`~/.tmuxifier-agent/`.

To remove it from a box: delete the five `tmuxifier-agent-hook` entries from
`~/.claude/settings.json` and `rm -rf ~/.tmuxifier-agent`. The next setup run reinstalls it.
```

`docs/fleet-and-health.md` — in the agent idle/done detection section, add:

```markdown
On boxes set up since v1.25, agent state is ground truth: a Claude Code hook on the box
records working/waiting at the moment it changes, and the status probe reads that marker.
The output-idle heuristic (20s threshold, two-poll confirmation) remains the fallback for
boxes without the hook and for Codex sessions.
```

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: typecheck + full vitest suite PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/boxes-and-setup.md docs/fleet-and-health.md
git commit -m "docs: agent-state hooks — module entry, setup guide, health guide"
```

---

## Post-plan validation (per repo workflow, not part of the task cycle)

Build in the worktree, `rsync -a --delete <worktree>/dist/ ./dist/`, restart the service (only when no setup/provision/lifecycle/fleet/voice-install job is running), verify a hashed asset serves with its real content-type, then validate live: run setup on a box with Claude Code, confirm `settings.json` gained the five entries, watch the agent chip flip on a real prompt/stop cycle, and confirm no false agent-input from a parked pane. Only then merge and run the release checklist.
