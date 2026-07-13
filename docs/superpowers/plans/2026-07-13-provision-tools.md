# Additional Tools at Provision Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user check off common tools (system upgrade, curl, git, gh, node/npm, bubblewrap, Codex CLI, Claude Code, Antigravity CLI) in the provision form and Add/Edit Box modal, installed live by the existing provision-terminal script.

**Architecture:** A server-side `TOOLS` catalog in `src/server/boxActions.js` maps curated tool ids to idempotent shell blocks appended into `buildEnsureTmuxRemote`. The selection travels as a `tools=` CSV WebSocket query param (validated by `resolveTools` — unknown ids reject the request), mirroring how `ohMyZsh=1` works today. Nothing is persisted. The web client renders checkboxes from a shared `PROVISION_TOOLS` list whose ids a parity test locks to the server catalog.

**Tech Stack:** Node 20 ESM server (`.js`), TypeScript web client, vitest, real-shell tests via `/bin/sh -c` (existing pattern in `test/boxActions.test.js`).

**Spec:** `docs/superpowers/specs/2026-07-13-provision-tools-design.md`

## Global Constraints

- No user-typed string may ever reach the generated shell script — only catalog ids (`resolveTools` throws on anything unknown).
- Every install block follows the existing conventions in `boxActions.js`: `SUDO` detection via `id -u`, the six package managers in order (apt-get, dnf, yum, pacman, apk, zypper), `DEBIAN_FRONTEND=noninteractive` on apt, `exit 127` + stderr message when no manager is found, `command -v` idempotency guards.
- Dependency implications are server-side: `codex`→`node`; `claude`/`agy`/`gh`→`curl` (gh needs curl to fetch GitHub's apt keyring — amend the spec table accordingly).
- Install order = `TOOL_IDS` order: `upgrade, curl, git, gh, node, bubblewrap, codex, claude, agy`, all before the git/tmux bootstrap and framework blocks.
- Tests use real code, no mocks (vitest, `environment: 'node'` — so web tests cover pure exports only, matching `test/proxmoxPresets.test.js`).
- Conventional-commit messages.

---

### Task 1: `resolveTools` + `TOOL_IDS` catalog ids

**Files:**
- Modify: `src/server/boxActions.js` (top of file, near existing imports)
- Modify: `docs/superpowers/specs/2026-07-13-provision-tools-design.md` (add `gh`→`curl` to the implication rules)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Produces: `export const TOOL_IDS: string[]` — `['upgrade','curl','git','gh','node','bubblewrap','codex','claude','agy']` in install order.
- Produces: `export function resolveTools(ids)` — accepts an array of ids **or** a CSV string (or null/undefined/`''` → `[]`); throws `Error('unknown tool: <id>')` on any id not in the catalog; dedupes; adds implications (`gh`→`curl`, `codex`→`node`, `claude`→`curl`, `agy`→`curl`); returns ids sorted in `TOOL_IDS` order.

- [ ] **Step 1: Write the failing tests**

Append to `test/boxActions.test.js` (add `resolveTools, TOOL_IDS` to the existing import from `../src/server/boxActions.js`):

```js
test('resolveTools returns [] for empty input', () => {
  expect(resolveTools(undefined)).toEqual([]);
  expect(resolveTools(null)).toEqual([]);
  expect(resolveTools('')).toEqual([]);
  expect(resolveTools([])).toEqual([]);
});

test('resolveTools rejects unknown ids', () => {
  expect(() => resolveTools(['curl', 'rm -rf /'])).toThrow(/unknown tool/);
  expect(() => resolveTools('curl,$(reboot)')).toThrow(/unknown tool/);
});

test('resolveTools parses CSV, dedupes, and orders by TOOL_IDS', () => {
  expect(resolveTools('git,curl,git')).toEqual(['curl', 'git']);
  expect(resolveTools(['bubblewrap', 'upgrade'])).toEqual(['upgrade', 'bubblewrap']);
});

test('resolveTools applies dependency implications', () => {
  expect(resolveTools(['codex'])).toEqual(['node', 'codex']);
  expect(resolveTools(['claude'])).toEqual(['curl', 'claude']);
  expect(resolveTools(['agy'])).toEqual(['curl', 'agy']);
  expect(resolveTools(['gh'])).toEqual(['curl', 'gh']);
});

test('TOOL_IDS lists every tool in install order', () => {
  expect(TOOL_IDS).toEqual(['upgrade', 'curl', 'git', 'gh', 'node', 'bubblewrap', 'codex', 'claude', 'agy']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: FAIL — `resolveTools` / `TOOL_IDS` are not exported.

- [ ] **Step 3: Implement**

In `src/server/boxActions.js`, above `buildEnsureTmuxRemote` (line 11), add:

```js
// Curated provision-time tools. Ids are the ONLY strings that ever reach the
// generated shell script — resolveTools throws on anything not in the catalog,
// which is what keeps the tools= query param out of command-injection territory.
export const TOOL_IDS = ['upgrade', 'curl', 'git', 'gh', 'node', 'bubblewrap', 'codex', 'claude', 'agy'];

// gh fetches GitHub's apt keyring with curl; codex is an npm global;
// claude/agy are curl installers.
const TOOL_IMPLIES = { gh: ['curl'], codex: ['node'], claude: ['curl'], agy: ['curl'] };

export function resolveTools(ids) {
  if (ids == null || ids === '') return [];
  const list = typeof ids === 'string' ? ids.split(',').filter(Boolean) : ids;
  if (!Array.isArray(list)) throw new Error('tools must be an array or comma-separated string');
  const want = new Set();
  for (const id of list) {
    if (!TOOL_IDS.includes(id)) throw new Error(`unknown tool: ${id}`);
    want.add(id);
    for (const dep of TOOL_IMPLIES[id] || []) want.add(dep);
  }
  return TOOL_IDS.filter((id) => want.has(id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Amend the spec's implication rule**

In `docs/superpowers/specs/2026-07-13-provision-tools-design.md`, change the dependency-implication bullet to include gh:

```markdown
- **Dependency implication is resolved server-side** before script generation: `gh` adds
  `curl` (it fetches GitHub's apt keyring); `codex` adds `node`; `claude`/`agy` add `curl`.
  The client doesn't need to know.
```

- [ ] **Step 6: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js docs/superpowers/specs/2026-07-13-provision-tools-design.md
git commit -m "feat(provision): resolveTools catalog id validation with implications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Tool install blocks in `buildEnsureTmuxRemote`

**Files:**
- Modify: `src/server/boxActions.js` (`buildEnsureTmuxRemote`, lines 11–169)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Consumes: `resolveTools`, `TOOL_IDS` (Task 1).
- Produces: `buildEnsureTmuxRemote(session, startupCommand, options)` accepts `options.tools: string[] | string | undefined` (passed through `resolveTools` internally, so raw CSV is safe too). Existing callers (`server.js`, `localShellActions.js`) pass no `tools` and are unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `test/boxActions.test.js`:

```js
test('buildEnsureTmuxRemote includes system upgrade block when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['upgrade'] });
  expect(remote).toContain('apt-get -y upgrade');
  expect(remote).toContain('dnf -y upgrade');
  expect(remote).toContain('pacman -Syu --noconfirm');
  expect(remote).toContain('apk upgrade --update-cache');
  expect(remote).toContain('zypper --non-interactive update');
});

test('buildEnsureTmuxRemote installs distro packages with command guards', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['curl', 'bubblewrap'] });
  expect(remote).toContain('if ! command -v curl >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends curl');
  expect(remote).toContain('if ! command -v bwrap >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends bubblewrap');
});

test('buildEnsureTmuxRemote sets up the GitHub apt repo for gh', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['gh'] });
  expect(remote).toContain('https://cli.github.com/packages/githubcli-archive-keyring.gpg');
  expect(remote).toContain('/etc/apt/sources.list.d/github-cli.list');
  expect(remote).toContain('apt-get install -y --no-install-recommends gh');
  expect(remote).toContain('pacman -Sy --noconfirm github-cli');
  // gh implies curl (fetches the keyring with it)
  expect(remote).toContain('if ! command -v curl >/dev/null 2>&1; then');
});

test('buildEnsureTmuxRemote installs codex via npm with node implied', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['codex'] });
  expect(remote).toContain('if ! command -v npm >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends nodejs npm');
  expect(remote).toContain('npm install -g @openai/codex');
});

test('buildEnsureTmuxRemote installs claude and agy via their curl installers', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['claude', 'agy'] });
  expect(remote).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  expect(remote).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
  expect(remote).toContain('$HOME/.local/bin:$PATH');
});

test('buildEnsureTmuxRemote runs tools before the git/tmux bootstrap', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['upgrade'] });
  expect(remote.indexOf('apt-get -y upgrade')).toBeLessThan(remote.indexOf('command -v tmux'));
});

test('buildEnsureTmuxRemote omits tool blocks and PATH line when no tools selected', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('@openai/codex');
  expect(remote).not.toContain('cli.github.com');
  expect(remote).not.toContain('.local/bin');
  expect(remote).not.toContain('upgrade');
});

test('buildEnsureTmuxRemote rejects unknown tool ids', () => {
  expect(() => buildEnsureTmuxRemote('web', undefined, { tools: ['evil'] })).toThrow(/unknown tool/);
});

test('local-bin PATH line is delete-then-append idempotent (real sed)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-path-'));
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['claude'] });
  // Extract just the PATH-maintenance block (from the .profile guard through done).
  const lines = remote.split('\n');
  const start = lines.findIndex((l) => l.includes('$HOME/.profile'));
  const end = lines.findIndex((l, i) => i > start && l === 'done');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = lines.slice(start, end + 1).join('\n');
  const env = { HOME: dir };
  await runShell(block, env);
  await runShell(block, env);
  const profile = await fs.readFile(path.join(dir, '.profile'), 'utf8');
  const count = profile.split('\n').filter((l) => l.includes('.local/bin')).length;
  expect(count).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: FAIL — the tool tests find none of the new strings.

- [ ] **Step 3: Implement the catalog blocks**

In `src/server/boxActions.js`, after `resolveTools`, add:

```js
// Multi-package-manager install, mirroring the git/tmux bootstrap blocks below.
// guard: binary checked with `command -v`; pkgs: per-manager package name(s).
function installPackagesBlock(guard, pkgs, label) {
  return [
    `if ! command -v ${guard} >/dev/null 2>&1; then`,
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO apt-get update || true',
    `    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs.apt}`,
    '  elif command -v dnf >/dev/null 2>&1; then',
    `    $SUDO dnf install -y ${pkgs.dnf}`,
    '  elif command -v yum >/dev/null 2>&1; then',
    `    $SUDO yum install -y ${pkgs.yum}`,
    '  elif command -v pacman >/dev/null 2>&1; then',
    `    $SUDO pacman -Sy --noconfirm ${pkgs.pacman}`,
    '  elif command -v apk >/dev/null 2>&1; then',
    `    $SUDO apk add ${pkgs.apk}`,
    '  elif command -v zypper >/dev/null 2>&1; then',
    `    $SUDO zypper --non-interactive install ${pkgs.zypper}`,
    '  else',
    `    echo '${label} is not installed and no supported package manager was found' >&2`,
    '    exit 127',
    '  fi',
    'fi',
  ];
}

function samePkg(name) {
  return { apt: name, dnf: name, yum: name, pacman: name, apk: name, zypper: name };
}

const TOOLS = {
  upgrade: () => [
    "SUDO=''",
    "if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    'if command -v apt-get >/dev/null 2>&1; then',
    '  $SUDO apt-get update',
    '  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  $SUDO dnf -y upgrade',
    'elif command -v yum >/dev/null 2>&1; then',
    '  $SUDO yum -y update',
    'elif command -v pacman >/dev/null 2>&1; then',
    '  $SUDO pacman -Syu --noconfirm',
    'elif command -v apk >/dev/null 2>&1; then',
    '  $SUDO apk upgrade --update-cache',
    'elif command -v zypper >/dev/null 2>&1; then',
    '  $SUDO zypper --non-interactive update',
    'else',
    "  echo 'no supported package manager was found for system upgrade' >&2",
    '  exit 127',
    'fi',
  ],
  curl: () => installPackagesBlock('curl', samePkg('curl'), 'curl'),
  git: () => installPackagesBlock('git', samePkg('git'), 'git'),
  gh: () => [
    'if ! command -v gh >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    // Debian/Ubuntu archives don't carry gh — use GitHub's official apt repo.
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO mkdir -p -m 755 /etc/apt/keyrings',
    '    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null',
    '    $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
    '    $SUDO apt-get update',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    $SUDO dnf install -y gh',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    $SUDO yum install -y gh',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm github-cli',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add github-cli',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install gh',
    '  else',
    "    echo 'gh is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
  ],
  node: () => installPackagesBlock('npm', samePkg('nodejs npm'), 'npm'),
  bubblewrap: () => installPackagesBlock('bwrap', samePkg('bubblewrap'), 'bubblewrap'),
  codex: () => [
    'if ! command -v codex >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  $SUDO npm install -g @openai/codex',
    'fi',
  ],
  claude: () => [
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  curl -fsSL https://claude.ai/install.sh | bash',
    'fi',
  ],
  agy: () => [
    'if ! command -v agy >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/agy" ]; then',
    '  curl -fsSL https://antigravity.google/cli/install.sh | bash',
    'fi',
  ],
};

// claude/agy land in ~/.local/bin. Same delete-then-append pattern as the
// default-shell line in .tmux.conf.local: exactly one PATH line per rc file,
// no matter how many times setup re-runs.
const LOCAL_BIN_PATH_BLOCK = [
  'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
  'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
  '  if [ -f "$rc" ]; then',
  "    sed -i '/# tmuxifier-local-bin$/d' \"$rc\" 2>/dev/null || true",
  '    echo \'export PATH="$HOME/.local/bin:$PATH" # tmuxifier-local-bin\' >> "$rc"',
  '  fi',
  'done',
];
```

- [ ] **Step 4: Wire the blocks into `buildEnsureTmuxRemote`**

At the top of `buildEnsureTmuxRemote` (after the `startup` const, line 13), add:

```js
  const tools = resolveTools(options.tools);
  const toolBlocks = tools.flatMap((id) => TOOLS[id]());
  const localBinPath = tools.includes('claude') || tools.includes('agy') ? LOCAL_BIN_PATH_BLOCK : [];
```

In the returned array (line 106), insert the blocks right after `'set -eu'`:

```js
  return [
    'set -eu',
    ...toolBlocks,
    ...localBinPath,
    // Ensure git is available before oh-my-tmux / oh-my-zsh
    'if ! command -v git >/dev/null 2>&1; then',
    // …rest unchanged…
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js test/localShellActions.test.js`
Expected: PASS (including the untouched localShellActions callers).

Note: the "omits tool blocks" test asserts `not.toContain('upgrade')` — if that collides with any existing script text, scope the assertion to `'apt-get -y upgrade'` instead.

- [ ] **Step 6: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js
git commit -m "feat(provision): tool install blocks in the ensure-tmux setup script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Server WS `tools` query param

**Files:**
- Modify: `src/server/server.js:10` (import) and `src/server/server.js:638-644` (provision-mode handler)
- Test: covered by Task 1's `resolveTools` tests (the handler is a thin passthrough, same as the existing `ohMyZsh === '1'` params); full suite run guards regressions.

**Interfaces:**
- Consumes: `resolveTools`, `buildEnsureTmuxRemote({ …, tools })` (Tasks 1–2).
- Produces: WS `GET /term?mode=provision&tools=<csv>` — invalid ids close the socket `1008 'invalid tools'` before any script is built.

- [ ] **Step 1: Update the import**

`src/server/server.js:10`:

```js
import { buildEnsureTmuxRemote, resolveTools } from './boxActions.js';
```

- [ ] **Step 2: Parse and validate the param**

Replace `src/server/server.js:638-644` with:

```js
      if (mode === 'provision') {
        const { ohMyTmux, ohMyZsh, ohMyBash, tools } = req.query;
        // Reject unknown ids outright — catalog ids are the only strings that
        // may reach the generated script (see resolveTools in boxActions.js).
        let toolIds;
        try {
          toolIds = resolveTools(typeof tools === 'string' ? tools : '');
        } catch {
          socket.close(1008, 'invalid tools');
          return;
        }
        const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
          installOhMyTmux: ohMyTmux === '1',
          installOhMyZsh: ohMyZsh === '1',
          installOhMyBash: ohMyBash === '1',
          tools: toolIds,
        });
```

- [ ] **Step 3: Run the full server suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/server.js
git commit -m "feat(provision): accept validated tools param on the provision WebSocket

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web tool list + checkbox group + WS plumbing

**Files:**
- Create: `src/web/provisionTools.ts`
- Modify: `src/web/terminal.ts:147-151` (ProvisionOptions) and `src/web/terminal.ts:242-250` (query string)
- Test: `test/provisionTools.test.js`

**Interfaces:**
- Consumes: `TOOL_IDS` from `src/server/boxActions.js` (parity test only).
- Produces: `PROVISION_TOOLS: { id: string; label: string }[]`; `toolsCheckboxGroup(): { element: HTMLFieldSetElement; selected(): string[] }`; `ProvisionOptions.tools?: string[]` honored by `openProvisionTerminal`.

- [ ] **Step 1: Write the failing parity test**

Create `test/provisionTools.test.js`:

```js
import { test, expect } from 'vitest';
import { TOOL_IDS } from '../src/server/boxActions.js';
import { PROVISION_TOOLS } from '../src/web/provisionTools.ts';

test('client tool list mirrors the server catalog, in order', () => {
  expect(PROVISION_TOOLS.map((t) => t.id)).toEqual(TOOL_IDS);
});

test('every tool has a human label', () => {
  for (const t of PROVISION_TOOLS) expect(t.label.trim().length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/provisionTools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/provisionTools.ts`**

```ts
// Curated provision-time tools. Ids must mirror TOOL_IDS in
// src/server/boxActions.js (locked by test/provisionTools.test.js); the server
// is the validation authority.
export const PROVISION_TOOLS: { id: string; label: string }[] = [
  { id: 'upgrade', label: 'System update & upgrade' },
  { id: 'curl', label: 'curl' },
  { id: 'git', label: 'git' },
  { id: 'gh', label: 'GitHub CLI (gh)' },
  { id: 'node', label: 'Node.js + npm' },
  { id: 'bubblewrap', label: 'Bubblewrap' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'agy', label: 'Antigravity CLI (agy)' },
];

// Shared "Additional tools" checkbox group for the provision form and the
// Add/Edit Box modal. DOM-building only — keep logic out so the node-env
// tests can import PROVISION_TOOLS without a document.
export function toolsCheckboxGroup(): { element: HTMLFieldSetElement; selected: () => string[] } {
  const group = document.createElement('fieldset');
  group.className = 'radio-group';
  const legend = document.createElement('legend');
  legend.textContent = 'Additional tools';
  group.append(legend);
  const inputs: { id: string; input: HTMLInputElement }[] = [];
  for (const t of PROVISION_TOOLS) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = t.id;
    const span = document.createElement('span');
    span.textContent = t.label;
    wrap.append(input, span);
    group.append(wrap);
    inputs.push({ id: t.id, input });
  }
  return {
    element: group,
    selected: () => inputs.filter((x) => x.input.checked).map((x) => x.id),
  };
}
```

- [ ] **Step 4: Thread `tools` through `openProvisionTerminal`**

`src/web/terminal.ts:147-151` — extend the interface:

```ts
interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
  tools?: string[];
}
```

`src/web/terminal.ts:242-250` — append the param to `qs`:

```ts
  const qs = [
    `box=${encodeURIComponent(boxId)}`,
    `mode=provision`,
    `cols=${term.cols}`,
    `rows=${term.rows}`,
    `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
    `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
    `ohMyBash=${options.ohMyBash ? '1' : '0'}`,
    ...(options.tools && options.tools.length ? [`tools=${encodeURIComponent(options.tools.join(','))}`] : []),
  ].join('&');
```

- [ ] **Step 5: Verify**

Run: `npx vitest run test/provisionTools.test.js && npm run typecheck`
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/provisionTools.ts src/web/terminal.ts test/provisionTools.test.js
git commit -m "feat(ui): shared additional-tools list and provision WS plumbing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Provision form (Proxmox hub)

**Files:**
- Modify: `src/web/proxmoxUi.ts:10` (SetupOptions), `:81-117` (form), `:153` (phase text)

**Interfaces:**
- Consumes: `toolsCheckboxGroup` (Task 4); `openProvisionTerminal` already accepts `tools` via `SetupOptions` spread.
- Produces: `SetupOptions` gains required `tools: string[]`.

- [ ] **Step 1: Extend SetupOptions and import**

`src/web/proxmoxUi.ts:10`:

```ts
type SetupOptions = { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[] };
```

Add to the imports at the top:

```ts
import { toolsCheckboxGroup } from './provisionTools';
```

- [ ] **Step 2: Add the checkbox group to the form**

In `renderProvision`, after the `shNone/shZsh/shBash` radios (line 83):

```ts
    const toolsGroup = toolsCheckboxGroup();
```

In the `box.append(...)` call (lines 104-115), insert `toolsGroup.element` after the shell-framework `div` and before `modal-actions`:

```ts
      el('div', { class: 'field' }, [el('span', {}, ['Shell framework']),
        el('label', { class: 'check-field' }, [shNone, el('span', {}, ['None'])]),
        el('label', { class: 'check-field' }, [shZsh, el('span', {}, ['Oh My Zsh'])]),
        el('label', { class: 'check-field' }, [shBash, el('span', {}, ['Oh My Bash'])]),
      ]),
      toolsGroup.element,
      el('div', { class: 'modal-actions' }, [go]),
```

- [ ] **Step 3: Pass the selection on submit**

Line 100, add `tools`:

```ts
        showJob(job.id, { ohMyTmux: (omt as HTMLInputElement).checked, ohMyZsh: (shZsh as HTMLInputElement).checked, ohMyBash: (shBash as HTMLInputElement).checked, tools: toolsGroup.selected() });
```

- [ ] **Step 4: Mention tools in the setup phase text**

Line 153:

```ts
      phase.textContent = `Container ${vmid ?? ''} — running setup (tmux${opt.ohMyTmux ? ' + oh-my-tmux' : ''}${opt.ohMyZsh ? ' + oh-my-zsh' : ''}${opt.ohMyBash ? ' + oh-my-bash' : ''}${opt.tools.length ? ` + ${opt.tools.join(', ')}` : ''})…`;
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. (`runSetup` already forwards the whole `SetupOptions` object to `openProvisionTerminal`, so no further change there.)

- [ ] **Step 6: Commit**

```bash
git add src/web/proxmoxUi.ts
git commit -m "feat(ui): additional-tools checkboxes on the provision form

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Add/Edit Box modal

**Files:**
- Modify: `src/web/main.ts:935` (openProvisionPanel signature), `:1107-1111` (group creation), `:1166` (setupGrid), `:1240-1248` (edit submit), `:1278-1282` (add submit)

**Interfaces:**
- Consumes: `toolsCheckboxGroup` (Task 4).
- Produces: no exports — end-user flow only.

- [ ] **Step 1: Import and widen openProvisionPanel**

Add to `src/web/main.ts` imports:

```ts
import { toolsCheckboxGroup } from './provisionTools';
```

Line 935:

```ts
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools?: string[] }) {
```

(`options` is passed straight to `openProvisionTerminal` at line 952 — no other change.)

- [ ] **Step 2: Create the group in openBoxDialog**

After `shellGroup.append(...)` (line 1111):

```ts
  const toolsGroup = toolsCheckboxGroup();
```

Line 1166:

```ts
  setupGrid.append(shellGroup, installOhMyTmux, toolsGroup.element);
```

- [ ] **Step 3: Edit-path submit (lines 1240-1248)**

```ts
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        const selectedTools = toolsGroup.selected();
        if (installOhMyTmuxInput.checked || installOhMyZsh || installOhMyBash || selectedTools.length) {
          openProvisionPanel(updatedBox, {
            ohMyTmux: installOhMyTmuxInput.checked,
            ohMyZsh: installOhMyZsh,
            ohMyBash: installOhMyBash,
            tools: selectedTools,
          });
        }
```

- [ ] **Step 4: Add-path submit (lines 1278-1282)**

```ts
        openProvisionPanel(newBox, {
          ohMyTmux: installOhMyTmuxInput.checked,
          ohMyZsh: installOhMyZsh,
          ohMyBash: installOhMyBash,
          tools: toolsGroup.selected(),
        });
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(ui): additional-tools checkboxes in the add/edit box modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs true-up + full verification

**Files:**
- Modify: `CLAUDE.md` (boxActions bullet, "Architecture" section)
- Modify: `AGENTS.md` (same bullet — kept in sync with CLAUDE.md)
- Modify: `README.md` (wherever the shell-framework setup options are described — locate with `grep -n "Oh My" README.md`)

- [ ] **Step 1: Update the boxActions description in CLAUDE.md and AGENTS.md**

Change the `boxActions.js` bullet's opening clause to:

```markdown
- `boxActions.js` — `createBoxActions`: per-box SSH operations over the shared ControlMaster —
  ensure/install tmux, selected shell frameworks, and the curated provision-time tool catalog
  (`TOOL_IDS`/`resolveTools`: system upgrade, curl, git, gh, node/npm, bubblewrap, and the
  Codex/Claude/Antigravity CLIs — ids validated server-side, nothing user-typed reaches the
  script), the non-interactive `execCommand` that Fleet Command runs, and ControlMaster
  liveness/stale-socket reaping (`isMasterAlive`/`reapStaleMaster`).
```

Apply the same wording to the matching bullet in `AGENTS.md`.

- [ ] **Step 2: Update README**

Find the setup-options passage (`grep -n "Oh My" README.md`) and add one sentence after it:

```markdown
An "Additional tools" checklist can also install common tooling during setup — a full system
update/upgrade, curl, git, the GitHub CLI, Node.js + npm, Bubblewrap, and the Codex, Claude
Code, and Antigravity CLIs — using the same idempotent multi-distro install script.
```

(Adjust placement to fit the surrounding prose; keep placeholders/PII rules — no real hosts.)

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: typecheck + vitest all green; vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: document the provision-time additional-tools catalog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
