# Provision Form Redesign + AI-Auth Seed Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the provision form (Proxmox hub Provision tab + Add/Edit Box modal) into grouped sections via one shared component, and surface per-CLI AI-auth host readiness (with exact fix-it commands) next to the seed checkbox.

**Architecture:** A new shared DOM component `src/web/setupOptions.ts` renders the Terminal / Tools / AI-auth sections and replaces the hand-rolled blocks in `main.ts` and `proxmoxUi.ts`. The server's `createAiAuthSeeder` gains a `status()` method exposed through a new auth-gated `GET /api/ai-auth/status` route; the component fetches it on render. A pure `presetSummary()` builder adds a live one-line preset description to the hub's new Container section.

**Tech Stack:** Node 20+ ESM, Fastify (server, plain `.js`), TypeScript + Vite (web client), vitest.

Spec: `docs/superpowers/specs/2026-07-19-provision-ui-redesign-design.md`

## Global Constraints

- TDD everywhere a node-env test can exist; DOM assembly itself stays untested (existing convention — `toolsCheckboxGroup`, `sparkline.ts`).
- Tests use real code, no mocks; server modules are factory functions with injected deps.
- No secret material (token bytes, auth.json contents) may ever appear in an API response body or test fixture assertion path.
- Reason strings must exactly mirror the existing seeder skip strings: `TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured`, `unsupported token characters`, `no codex auth on the Tmuxifier host`.
- Conventional-commit messages.
- Web tests import TS sources with explicit `.ts` extension (see `test/provisionTools.test.js`).
- Gate for every task: the task's own test command; final task runs `npm test` (typecheck + vitest) and `npm run build`.
- This is a public repo: no real IPs/domains/hostnames in code, tests, or docs — placeholders only.

---

### Task 1: `status()` on the AI-auth seeder

**Files:**
- Modify: `src/server/aiAuthSeed.js` (factory at `createAiAuthSeeder`, line ~64)
- Test: `test/aiAuthSeed.test.js` (append)

**Interfaces:**
- Consumes: existing `createAiAuthSeeder({ runStdin, token, readLocal })`.
- Produces: `seeder.status(): Promise<{ claude: { ready: boolean, reason?: string }, codex: { ready: boolean, reason?: string } }>` — Task 2's route and Task 4's `AiAuthStatus` client type depend on exactly this shape.

- [ ] **Step 1: Write the failing test**

Append to `test/aiAuthSeed.test.js`:

```js
test('status reports per-CLI readiness with the seeder skip reasons, no secret material', async () => {
  const ready = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: 'sk-ant-oat-EXAMPLE', readLocal: async () => Buffer.from('{"codex":true}') });
  expect(await ready.status()).toEqual({ claude: { ready: true }, codex: { ready: true } });
  expect(JSON.stringify(await ready.status())).not.toContain('EXAMPLE');

  const none = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: null, readLocal: async () => { throw new Error('ENOENT'); } });
  expect(await none.status()).toEqual({
    claude: { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  });

  const bad = createAiAuthSeeder({ runStdin: async () => ({ ok: true }), token: "bad'token", readLocal: async () => Buffer.from('') });
  expect(await bad.status()).toEqual({
    claude: { ready: false, reason: 'unsupported token characters' },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/aiAuthSeed.test.js -t 'status reports'`
Expected: FAIL — `ready.status is not a function`

- [ ] **Step 3: Implement `status()`**

In `src/server/aiAuthSeed.js`, inside the object returned by `createAiAuthSeeder` (after the `seed(box)` method, same level):

```js
    // Host-side readiness for the provision forms. Reasons reuse the exact
    // skip strings seed() emits; no secret bytes ever appear in the result.
    async status() {
      const claude = !token
        ? { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' }
        : /['\r\n]/.test(token)
          ? { ready: false, reason: 'unsupported token characters' }
          : { ready: true };
      let codexBytes = null;
      try { codexBytes = await readLocal(); } catch { /* no local auth */ }
      const codex = codexBytes && codexBytes.length
        ? { ready: true }
        : { ready: false, reason: 'no codex auth on the Tmuxifier host' };
      return { claude, codex };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/aiAuthSeed.test.js`
Expected: all tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/server/aiAuthSeed.js test/aiAuthSeed.test.js
git commit -m "feat(seed): status() reports per-CLI AI-auth host readiness"
```

---

### Task 2: `GET /api/ai-auth/status` route

**Files:**
- Modify: `src/server/server.js` — add route directly after the existing `POST /api/boxes/:id/seed-ai-auth` handler (ends near line 357)
- Test: `test/server.test.js` (append after the seed-ai-auth tests, near line 557)

**Interfaces:**
- Consumes: `aiAuthSeeder.status()` from Task 1 (the seeder is already a `buildServer` param and already wired in `index.js` — no wiring change needed).
- Produces: `GET /api/ai-auth/status` → 200 `{ claude: {...}, codex: {...} }`, 401 unauthenticated, 503 when no seeder/no `status`, 500 `{ error: 'status failed' }` on throw (never echoes the error). Task 4's `api.aiAuthStatus()` calls this.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js` (uses the file's existing `makeApp(overrides)` and `login()` helpers):

```js
test('ai-auth status returns per-CLI readiness and requires auth', async () => {
  const aiAuthSeeder = { seed: async () => [], status: async () => ({
    claude: { ready: true },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  }) };
  app = await makeApp({ aiAuthSeeder });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ai-auth/status', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    claude: { ready: true },
    codex: { ready: false, reason: 'no codex auth on the Tmuxifier host' },
  });
  expect((await app.inject({ method: 'GET', url: '/api/ai-auth/status' })).statusCode).toBe(401);
});

test('ai-auth status 503s when no seeder is wired', async () => {
  app = await makeApp();
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ai-auth/status', headers });
  expect(res.statusCode).toBe(503);
});

test('ai-auth status never echoes a thrown error into the response body', async () => {
  const aiAuthSeeder = { seed: async () => [], status: async () => { throw new Error('sk-ant-oat-LEAKED'); } };
  app = await makeApp({ aiAuthSeeder });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ai-auth/status', headers });
  expect(res.statusCode).toBe(500);
  expect(res.body).not.toContain('LEAKED');
  expect(res.json()).toEqual({ error: 'status failed' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js -t 'ai-auth status'`
Expected: 3 FAIL — 404 responses (route not mounted)

- [ ] **Step 3: Implement the route**

In `src/server/server.js`, immediately after the closing `});` of the `POST /api/boxes/:id/seed-ai-auth` handler:

```js
  // Host-side AI-auth readiness for the provision forms: is there anything to
  // seed? Reasons are the seeder's fixed skip strings — never secret material,
  // and a rejection must never echo its message into the body.
  app.get('/api/ai-auth/status', { preHandler: requireAuth }, async (req, reply) => {
    if (!aiAuthSeeder?.status) return reply.code(503).send({ error: 'seeding unavailable' });
    try {
      return await aiAuthSeeder.status();
    } catch {
      return reply.code(500).send({ error: 'status failed' });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(api): GET /api/ai-auth/status exposes seed readiness"
```

---

### Task 3: `presetSummary()` pure builder

**Files:**
- Create: `src/web/presetSummary.ts`
- Test: `test/presetSummary.test.js`

**Interfaces:**
- Consumes: `PvePreset` type from `src/web/proxmox.ts` (type-only import; fields used: `template`, `cores`, `memoryMiB`, `diskGiB`, `net.vlan`, `net.ipMode`).
- Produces: `presetSummary(p: PvePreset): string` — Task 6 renders it under the hub's preset select.

- [ ] **Step 1: Write the failing test**

Create `test/presetSummary.test.js`:

```js
import { test, expect } from 'vitest';
import { presetSummary } from '../src/web/presetSummary.ts';

const base = {
  id: 'p1', name: 'debian_vlan3_autostatic', hostId: 'h1', node: null,
  template: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512,
  unprivileged: true, features: {},
  net: { bridge: 'vmbr0', vlan: 3, ipMode: 'auto-static', cidr: null, gateway: null },
  dns: { nameserver: null, searchdomain: null }, mounts: [], onboot: false,
  startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  createdAt: '2026-07-19T00:00:00.000Z',
};

test('full auto-static preset: basename, cores/mem, disk, vlan, ip mode', () => {
  expect(presetSummary(base)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 2 GiB · disk 8 GiB · vlan 3 · IP auto (NetBox)');
});

test('no vlan + dhcp drops the vlan part and says DHCP', () => {
  const p = { ...base, net: { ...base.net, vlan: null, ipMode: 'dhcp' } };
  expect(presetSummary(p)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 2 GiB · disk 8 GiB · DHCP');
});

test('static ip mode and fractional GiB memory', () => {
  const p = { ...base, memoryMiB: 1536, net: { ...base.net, ipMode: 'static' } };
  expect(presetSummary(p)).toBe('debian-12-standard_12.7-1_amd64 · 2c / 1.5 GiB · disk 8 GiB · vlan 3 · static IP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/presetSummary.test.js`
Expected: FAIL — cannot resolve `../src/web/presetSummary.ts`

- [ ] **Step 3: Implement**

Create `src/web/presetSummary.ts`:

```ts
import type { PvePreset } from './proxmox';

// One-line description of what a preset provisions, shown live under the
// preset select in the hub's Provision tab. Pure — node tests import this
// without a DOM.
export function presetSummary(p: PvePreset): string {
  const template = (p.template.split('/').pop() ?? p.template).replace(/\.tar\.(gz|xz|zst)$/, '');
  const gib = p.memoryMiB / 1024;
  const mem = Number.isInteger(gib) ? `${gib}` : gib.toFixed(1);
  const parts = [template, `${p.cores}c / ${mem} GiB`, `disk ${p.diskGiB} GiB`];
  if (p.net.vlan != null) parts.push(`vlan ${p.net.vlan}`);
  parts.push(p.net.ipMode === 'auto-static' ? 'IP auto (NetBox)' : p.net.ipMode === 'static' ? 'static IP' : 'DHCP');
  return parts.join(' · ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/presetSummary.test.js`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/presetSummary.ts test/presetSummary.test.js
git commit -m "feat(web): presetSummary — one-line preset description"
```

---

### Task 4: shared setup-options component

**Files:**
- Create: `src/web/setupOptions.ts`
- Modify: `src/web/api.ts` (add `AiAuthStatus` types + `aiAuthStatus()` method near `seedAiAuth`, line ~103)
- Modify: `src/web/provisionTools.ts` (checkboxes into an inner `.tools-grid` div)
- Modify: `src/web/style.css` (section cards, tools grid, seed-status rows — after the `.modal .field-grid` rules, line ~283)
- Test: `test/setupOptions.test.js` (pure `seedStatusLine` only)

**Interfaces:**
- Consumes: `el`, `makeRadio` from `src/web/dom.ts`; `toolsCheckboxGroup` from `src/web/provisionTools.ts`; `api.aiAuthStatus()` (added here) hitting Task 2's route.
- Produces (Tasks 5 and 6 rely on these exact names):
  - `interface SetupOptionsValues { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean }`
  - `createSetupOptionsForm(initial?: { ohMyTmux?: boolean }): { element: HTMLElement; values(): SetupOptionsValues; applySeedStatus(s: AiAuthStatus | null): void }`
  - `seedStatusLine(cli: 'claude' | 'codex', s: { ready: boolean; reason?: string } | null): string`
  - In `api.ts`: `interface AiAuthCliStatus { ready: boolean; reason?: string }`, `interface AiAuthStatus { claude: AiAuthCliStatus; codex: AiAuthCliStatus }`, `api.aiAuthStatus(): Promise<AiAuthStatus>`

- [ ] **Step 1: Write the failing test**

Create `test/setupOptions.test.js`:

```js
import { test, expect } from 'vitest';
import { seedStatusLine } from '../src/web/setupOptions.ts';

test('ready CLI renders a ready row', () => {
  expect(seedStatusLine('claude', { ready: true })).toBe('claude: ● ready');
  expect(seedStatusLine('codex', { ready: true })).toBe('codex: ● ready');
});

test('unready claude names the exact host commands and env var', () => {
  const line = seedStatusLine('claude', { ready: false, reason: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' });
  expect(line).toContain('claude: ○ not set up');
  expect(line).toContain('claude setup-token');
  expect(line).toContain('TMUXIFIER_CLAUDE_OAUTH_TOKEN');
  expect(line).toContain('restart');
});

test('unready codex says to run codex login on the host', () => {
  const line = seedStatusLine('codex', { ready: false, reason: 'no codex auth on the Tmuxifier host' });
  expect(line).toContain('codex: ○ not set up');
  expect(line).toContain('codex login');
});

test('null status renders status unknown', () => {
  expect(seedStatusLine('claude', null)).toBe('claude: status unknown');
  expect(seedStatusLine('codex', null)).toBe('codex: status unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setupOptions.test.js`
Expected: FAIL — cannot resolve `../src/web/setupOptions.ts`

- [ ] **Step 3: Add the client API surface**

In `src/web/api.ts`, next to the existing `SeedResult` interface (line ~66) add:

```ts
export interface AiAuthCliStatus { ready: boolean; reason?: string }
export interface AiAuthStatus { claude: AiAuthCliStatus; codex: AiAuthCliStatus }
```

and in the `api` object, directly after the `seedAiAuth` method (line ~103):

```ts
  async aiAuthStatus() { return j<AiAuthStatus>(await fetch('/api/ai-auth/status')); },
```

- [ ] **Step 4: Create `src/web/setupOptions.ts`**

```ts
import { el, makeRadio } from './dom';
import { toolsCheckboxGroup } from './provisionTools';
import { api, type AiAuthStatus, type AiAuthCliStatus } from './api';

export interface SetupOptionsValues { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean }

// Pure text for one CLI's readiness row — exported for node-env tests, so it
// must stay DOM-free.
export function seedStatusLine(cli: 'claude' | 'codex', s: AiAuthCliStatus | null): string {
  if (!s) return `${cli}: status unknown`;
  if (s.ready) return `${cli}: ● ready`;
  const fix = cli === 'claude'
    ? 'run `claude setup-token` on the Tmuxifier host, put the token in .env as TMUXIFIER_CLAUDE_OAUTH_TOKEN, then restart Tmuxifier'
    : 'run `codex login` on the Tmuxifier host';
  return `${cli}: ○ not set up — ${fix}`;
}

// Two forms can be open at once (hub tab + box modal); a per-instance radio
// name keeps their shell selections independent.
let shellRadioSeq = 0;

// Shared post-create setup options — Terminal (tmux + shell framework),
// Tools, AI auth seeding — used by the Add/Edit Box modal and the Proxmox
// hub's Provision tab. Fetches seed readiness on creation; a failed fetch
// degrades to "status unknown" with the checkbox left enabled (the
// post-provision per-target results still report the truth).
export function createSetupOptionsForm(initial: { ohMyTmux?: boolean } = {}): {
  element: HTMLElement;
  values: () => SetupOptionsValues;
  applySeedStatus: (s: AiAuthStatus | null) => void;
} {
  const section = (title: string, ...children: (Node | string)[]) =>
    el('fieldset', { class: 'setup-section' }, [el('legend', {}, [title]), ...children]);

  const omt = el('input', { type: 'checkbox' }) as HTMLInputElement;
  omt.checked = initial.ohMyTmux !== false;
  const omtField = el('label', { class: 'check-field' }, [omt, el('span', {}, ['Install Oh My Tmux if missing'])]);

  const shellName = `setup-shell-${++shellRadioSeq}`;
  const shNone = makeRadio(shellName, 'none', 'None', true);
  const shZsh = makeRadio(shellName, 'omz', 'Oh My Zsh', false);
  const shBash = makeRadio(shellName, 'omb', 'Oh My Bash', false);
  const shellGroup = el('fieldset', { class: 'radio-group' }, [el('legend', {}, ['Shell framework']), shNone.wrap, shZsh.wrap, shBash.wrap]);

  const tools = toolsCheckboxGroup();
  tools.element.classList.add('setup-section');

  const seedInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const seedField = el('label', {
    class: 'check-field',
    title: 'Copies subscription credentials from the Tmuxifier host to this box — seed only boxes you trust with your own login',
  }, [seedInput, el('span', {}, ['Seed AI CLI auth (claude/codex) from this host'])]);
  const claudeRow = el('div', { class: 'seed-status' }, ['claude: checking…']);
  const codexRow = el('div', { class: 'seed-status' }, ['codex: checking…']);

  function applySeedStatus(s: AiAuthStatus | null) {
    claudeRow.textContent = seedStatusLine('claude', s?.claude ?? null);
    codexRow.textContent = seedStatusLine('codex', s?.codex ?? null);
    const bothUnready = !!s && !s.claude.ready && !s.codex.ready;
    seedInput.disabled = bothUnready;
    if (bothUnready) {
      seedInput.checked = false;
      seedField.title = 'Nothing to seed yet — set up claude and/or codex auth on the Tmuxifier host first';
    }
  }
  void api.aiAuthStatus().then(applySeedStatus).catch(() => applySeedStatus(null));

  const element = el('div', { class: 'setup-options' }, [
    section('Terminal', omtField, shellGroup),
    tools.element,
    section('AI auth seeding', seedField, claudeRow, codexRow),
  ]);

  return {
    element,
    values: () => ({
      ohMyTmux: omt.checked,
      ohMyZsh: shZsh.input.checked,
      ohMyBash: shBash.input.checked,
      tools: tools.selected(),
      seedAiAuth: seedInput.checked,
    }),
    applySeedStatus,
  };
}
```

- [ ] **Step 5: Put the tool checkboxes in a grid container**

In `src/web/provisionTools.ts`, `toolsCheckboxGroup()`: append the labels to an inner grid div instead of the fieldset. Replace the loop/append portion so the function body reads:

```ts
export function toolsCheckboxGroup(): { element: HTMLFieldSetElement; selected: () => string[] } {
  const group = document.createElement('fieldset');
  group.className = 'radio-group';
  const legend = document.createElement('legend');
  legend.textContent = 'Additional tools';
  const grid = document.createElement('div');
  grid.className = 'tools-grid';
  group.append(legend, grid);
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
    grid.append(wrap);
    inputs.push({ id: t.id, input });
  }
  return {
    element: group,
    selected: () => inputs.filter((x) => x.input.checked).map((x) => x.id),
  };
}
```

- [ ] **Step 6: Add the CSS**

In `src/web/style.css`, after the `.modal .field-grid` media-query rule (line ~283):

```css
.modal .setup-options { display: flex; flex-direction: column; gap: 12px; }
.modal fieldset.setup-section { margin: 0; padding: 10px 12px; border: 1px solid #30363d; border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
.modal fieldset.setup-section > legend { padding: 0 4px; font-size: 12px; color: #8b949e; }
.modal .tools-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 620px) { .modal .tools-grid { grid-template-columns: 1fr; } }
.modal .seed-status { font-size: 12px; color: #8b949e; line-height: 1.4; }
```

(`fieldset.setup-section`'s selector out-specifies `.modal .radio-group`, so the tools fieldset — which carries both classes — gets the card border while the nested shell `radio-group` keeps its borderless look.)

- [ ] **Step 7: Run test + typecheck**

Run: `npx vitest run test/setupOptions.test.js && npm run typecheck`
Expected: 4 PASS, typecheck clean

- [ ] **Step 8: Commit**

```bash
git add src/web/setupOptions.ts src/web/api.ts src/web/provisionTools.ts src/web/style.css test/setupOptions.test.js
git commit -m "feat(web): shared setup-options component with AI-auth readiness rows"
```

---

### Task 5: wire the component into the Add/Edit Box modal

**Files:**
- Modify: `src/web/main.ts` — `openBoxDialog()` (lines ~1149-1449)

**Interfaces:**
- Consumes: `createSetupOptionsForm` + `SetupOptionsValues` from Task 4.
- Produces: no new exports. `openProvisionPanel(box, options)`'s `options` shape (`{ ohMyTmux, ohMyZsh, ohMyBash, tools?, seedAiAuth? }`) is satisfied by `SetupOptionsValues` — do not change `openProvisionPanel`.

- [ ] **Step 1: Replace the hand-rolled setup blocks**

In `src/web/main.ts`:

1. Add the import near the other web-module imports (line ~21):

```ts
import { createSetupOptionsForm } from './setupOptions';
```

2. Delete the `installOhMyTmux` label block (lines ~1167-1174: `const installOhMyTmux = document.createElement('label'); … installOhMyTmux.append(installOhMyTmuxInput, installOhMyTmuxText);`).

3. Delete the shell-framework block, tools group, and seed checkbox block (lines ~1258-1280: `const shellGroup = …` through `seedAiAuth.append(seedAiAuthInput, seedAiAuthText);`). In their place put:

```ts
  // Shared setup-options component (Terminal / Tools / AI auth seeding).
  // Edit mode defaults Oh My Tmux off — the box already went through setup.
  const setupForm = createSetupOptionsForm({ ohMyTmux: !isEdit });
```

4. Replace the `setupGrid` block (lines ~1331-1333):

```ts
  const setupGrid = document.createElement('div');
  setupGrid.className = 'field-grid';
  setupGrid.append(shellGroup, installOhMyTmux, toolsGroup.element, seedAiAuth);
```

with nothing — and in `modalBody.append(...)` (line ~1337) replace `setupGrid` with `setupForm.element`:

```ts
  modalBody.append(
    fieldGrid,
    tagDatalist,
    sessionWrap,
    setupForm.element,
    proxmoxAssociation.element,
  );
```

5. Delete the edit-mode reset block (lines ~1356-1360):

```ts
  // Default checkboxes/radios to unchecked/None in edit mode
  if (isEdit) {
    installOhMyTmuxInput.checked = false;
    shellNone.input.checked = true;
  }
```

(the `{ ohMyTmux: !isEdit }` initial covers it; shell always defaults to None).

6. In the edit-mode submit branch, replace the reads (lines ~1395-1406):

```ts
        const so = setupForm.values();
        if (so.ohMyTmux || so.ohMyZsh || so.ohMyBash || so.tools.length || so.seedAiAuth) {
          openProvisionPanel(updatedBox, so);
        }
```

7. In the add-mode submit branch, delete the two `const installOhMy…` lines (~1410-1411) and replace the `openProvisionPanel(newBox, {...})` call (lines ~1436-1442):

```ts
        openProvisionPanel(newBox, setupForm.values());
```

- [ ] **Step 2: Remove now-unused imports**

Run: `grep -n "toolsCheckboxGroup\|makeRadio" src/web/main.ts`
Remove `toolsCheckboxGroup` from the `provisionTools` import (delete the whole import line if it's the only named import). Remove `makeRadio` from the `dom` import ONLY if the grep shows no remaining uses in `main.ts`.

- [ ] **Step 3: Typecheck + full unit suite**

Run: `npm test`
Expected: typecheck clean, all vitest suites PASS

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts
git commit -m "refactor(web): box modal uses the shared setup-options component"
```

---

### Task 6: wire the component + Container section into the hub Provision tab

**Files:**
- Modify: `src/web/proxmoxUi.ts` — imports (lines 1-15) and `renderProvision()` (lines ~67-125)

**Interfaces:**
- Consumes: `createSetupOptionsForm`, `SetupOptionsValues` (Task 4), `presetSummary` (Task 3).
- Produces: no new exports. `showJob(id, setup?)` keeps its `SetupOptions` param name via a type alias.

- [ ] **Step 1: Rewrite `renderProvision()`**

In `src/web/proxmoxUi.ts`:

1. Imports: drop `toolsCheckboxGroup` from `./provisionTools` (delete the import line), and add:

```ts
import { createSetupOptionsForm, type SetupOptionsValues } from './setupOptions';
import { presetSummary } from './presetSummary';
```

2. Replace the local type (line 15):

```ts
type SetupOptions = { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean };
```

with:

```ts
type SetupOptions = SetupOptionsValues;
```

3. Replace the body of `renderProvision()` (keep the function name and `async`):

```ts
  async function renderProvision() {
    const [presets, boxes] = await Promise.all([pve.presets().catch(() => []), api.boxes().catch(() => [] as Box[])]);
    if (!presets.length) { setContent(el('div', { class: 'pve-sub' }, ['Create a preset first.'])); return; }
    const sel = el('select', {}, presets.map((p) => el('option', { value: p.id }, [p.name]))) as HTMLSelectElement;
    const hostname = input('', { placeholder: 'dev-01' });
    const ip = input('', { placeholder: 'override IP/CIDR (static only)' });
    const ipField = field('IP/CIDR', ip);

    // Tag input with a datalist of existing box tags (same single-tag pattern as the box modal).
    const tagListId = 'pve-tag-options';
    const tagOptions = [...new Set(boxes.flatMap((b) => b.tags || []))].sort();
    const tagDatalist = el('datalist', { id: tagListId }, tagOptions.map((t) => el('option', { value: t })));
    const tag = input('', { placeholder: 'prod, staging (optional)', list: tagListId });

    const setupForm = createSetupOptionsForm();

    const box = el('div', {});
    const curPreset = (): PvePreset | undefined => presets.find((p) => p.id === sel.value);
    // Live one-line description of the selected preset; also decides whether
    // the static-IP override field applies.
    const summary = el('div', { class: 'pve-sub' });
    const syncPreset = () => {
      const p = curPreset();
      summary.textContent = p ? presetSummary(p) : '';
      ipField.style.display = p?.net.ipMode === 'static' ? '' : 'none';
    };
    sel.addEventListener('change', syncPreset);

    const go = el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); box.querySelector('.pve-err')?.remove();
      const t = tag.value.trim();
      const setupOptions: SetupOptions = setupForm.values();
      try {
        const job = await pve.createProvision({ presetId: sel.value, hostname: hostname.value.trim(), ip: curPreset()?.net.ipMode === 'static' ? (ip.value.trim() || undefined) : undefined, tags: t ? [t] : [], setupOptions });
        showJob(job.id, setupOptions);
      } catch (er) { box.append(err((er as Error).message)); }
    } }, ['Provision']);

    box.append(
      el('h3', {}, ['Provision a container']),
      el('fieldset', { class: 'setup-section' }, [
        el('legend', {}, ['Container']),
        field('Preset', sel), summary,
        field('Hostname', hostname), ipField,
        field('Tag', tag), tagDatalist,
      ]),
      setupForm.element,
      el('div', { class: 'modal-actions' }, [go]),
    );
    setContent(box);
    syncPreset();
  }
```

(The old `ipAutoNote` / `syncStatic` pair is gone — the summary line's ip-mode phrase covers "IP: auto-allocated from NetBox".)

- [ ] **Step 2: Typecheck + full unit suite**

Run: `npm test`
Expected: typecheck clean, all vitest suites PASS

- [ ] **Step 3: Commit**

```bash
git add src/web/proxmoxUi.ts
git commit -m "feat(web): hub Provision tab — Container section, preset summary, shared setup options"
```

---

### Task 7: docs, build, graph refresh

**Files:**
- Modify: `CLAUDE.md` + `AGENTS.md` (web-client module list; the `server.js` bullet's route mention; keep the two files in sync)
- Modify: `README.md` (seeding section, near line 185)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-6.
- Produces: docs consistent with the code; a green build.

- [ ] **Step 1: Update CLAUDE.md and AGENTS.md**

In both files' web-client paragraph (the `src/web/` listing), add after the `notifyPrefs.ts` entry style, alongside the other feature modules:

```
`setupOptions.ts` (the shared post-create setup form — Terminal/Tools/AI-auth sections —
used by the Add/Edit Box modal and the hub's Provision tab; fetches `GET /api/ai-auth/status`
to show per-CLI seed readiness with fix-it commands, and disables the seed checkbox only when
both CLIs are unready), `presetSummary.ts` (pure one-line preset description builder),
```

And in the `aiAuthSeed.js` server bullet, append one sentence:

```
`status()` reports per-CLI host readiness (no secret material) and is served by the
auth-gated `GET /api/ai-auth/status` for the provision forms' readiness rows.
```

- [ ] **Step 2: Update README.md seeding section**

After the sentence describing the seed checkbox (line ~185), add:

```
The form shows per-CLI readiness next to the checkbox — a CLI that isn't set up on the
Tmuxifier host shows the exact command to run (`claude setup-token` / `codex login`), and the
checkbox is disabled when there is nothing to seed yet.
```

- [ ] **Step 3: Full gate + build + graph**

Run: `npm test && npm run build && graphify update .`
Expected: tests PASS, vite build succeeds, graph updated

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md graphify-out
git commit -m "docs: setup-options component, ai-auth status route, seed readiness UX"
```

---

## Verification (manual, post-implementation)

1. `npm run dev`, open the dashboard → Add box: setup options render as three titled cards; seed rows show readiness (on a host without `claude setup-token`/`codex login`, both rows show fix-it commands and the checkbox is disabled).
2. Proxmox hub → Provision: Container card with live preset summary; switching presets updates the summary and static-IP field visibility.
3. With a configured host, provision with seed checked → post-setup phase text still appends `auth: claude ✓ · codex ✓` (unchanged path).
