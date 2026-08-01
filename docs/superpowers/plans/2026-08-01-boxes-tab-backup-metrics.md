# Boxes Tab Backup Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings → Boxes show what the box-list export actually contains (stat grid + real file size), what import actually does, and what the backup does *not* cover.

**Architecture:** The tab fetches `GET /api/export` — the same payload the Export button downloads — and derives its stats client-side with pure, vitest-tested helpers in `settingsBoxes.ts`. A new `api.exportPreview()` is the only `api.ts` change; the server is untouched. Exclusions are static text.

**Tech Stack:** TypeScript web client (Vite), vitest (node environment — no DOM), existing `el()` DOM builders, existing `fmtBytes` formatter.

Spec: `docs/superpowers/specs/2026-08-01-boxes-tab-backup-metrics-design.md`.

## Global Constraints

- ESM everywhere; Node 20+; server is plain `.js`, web client is `.ts`.
- TDD with real code, not mocks. Tests run in vitest `environment: 'node'` — there is no jsdom, so DOM-rendering code is deliberately untested; only pure helpers get unit tests.
- Server untouched: no new endpoints, no change to export/import semantics (`GET /api/export`, `POST /api/import` stay exactly as they are).
- No new dependencies.
- Committed docs use placeholders only (`example.com`, RFC1918 IPs) — never real hostnames/IPs/emails.
- Conventional-commit messages (`feat(ui): …`, `docs: …`).
- Visuals follow DESIGN.md (the instrument idiom): engraved labels are 10px uppercase letter-spaced `var(--dim)`; live figures are amber (`var(--amber)`) with `tabular-nums`. Green/red/violet are machine-state only — never used here.
- Do not run `graphify update .` by hand (a Stop hook refreshes the graph automatically).

---

### Task 1: Pure export-preview helpers in `settingsBoxes.ts`

**Files:**
- Modify: `src/web/settingsBoxes.ts` (add exports; do not touch `renderBoxesSection` yet)
- Test: `test/settingsBoxes.test.js` (extend the existing file)

**Interfaces:**
- Consumes: `Box` type from `src/web/api.ts` (fields: `id`, `label`, `host`, `user?`, `port?`, `proxyJump?`, `sessionName`, `startupCommand?`, `tags: string[]`, `source`, `proxmox?`).
- Produces (Task 3 relies on these exact names):
  - `interface ExportStats { total: number; manual: number; proxmox: number; tagged: number; proxyJump: number; startupCommand: number; customPort: number; customUser: number }`
  - `exportStats(payload: unknown): ExportStats`
  - `exportSizeBytes(text: string): number`
  - `exportFilename(exportedAt: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/settingsBoxes.test.js` (its import line currently reads `import { importSummary } from '../src/web/settingsBoxes.ts';` — extend it):

```js
import { test, expect } from 'vitest';
import { importSummary, exportStats, exportSizeBytes, exportFilename } from '../src/web/settingsBoxes.ts';
```

New tests:

```js
test('exportStats: counts totals, source split, and optional-field usage', () => {
  const payload = {
    type: 'tmuxifier-boxes', version: 1, exportedAt: '2026-08-01T10:00:00.000Z',
    boxes: [
      // manual box using every optional field
      { id: 'a', label: 'one', host: '192.168.1.10', user: 'ops', port: 2222,
        proxyJump: 'jump.example.com', sessionName: 'web', startupCommand: 'htop',
        tags: ['lab'], source: 'manual' },
      // proxmox-linked box using none of them
      { id: 'b', label: 'two', host: '192.168.1.11', sessionName: 'web',
        tags: [], source: 'proxmox',
        proxmox: { hostId: 'h', node: 'n', vmid: 101, kind: 'lxc' } },
      // manual box with only a tag
      { id: 'c', label: 'three', host: '192.168.1.12', sessionName: 'web',
        tags: ['lab'], source: 'manual' },
    ],
  };
  expect(exportStats(payload)).toEqual({
    total: 3, manual: 2, proxmox: 1, tagged: 2,
    proxyJump: 1, startupCommand: 1, customPort: 1, customUser: 1,
  });
});

test('exportStats: a malformed payload yields zeroed counts, not a throw', () => {
  const zero = { total: 0, manual: 0, proxmox: 0, tagged: 0, proxyJump: 0, startupCommand: 0, customPort: 0, customUser: 0 };
  expect(exportStats(null)).toEqual(zero);
  expect(exportStats({})).toEqual(zero);
  expect(exportStats({ boxes: 'not an array' })).toEqual(zero);
  expect(exportStats([])).toEqual(zero); // a bare array is not the wrapped payload
});

test('exportStats: empty strings do not count as field usage; any present port does', () => {
  const payload = { boxes: [
    { host: 'h1', sessionName: 'web', tags: [], source: 'manual', user: '  ', proxyJump: '', startupCommand: '' },
    { host: 'h2', sessionName: 'web', tags: [], source: 'manual', port: 22 },
    null, // a junk row is skipped-as-empty, not fatal
  ] };
  const s = exportStats(payload);
  expect(s.total).toBe(3);
  expect(s.customUser).toBe(0);
  expect(s.proxyJump).toBe(0);
  expect(s.startupCommand).toBe(0);
  expect(s.customPort).toBe(1); // present = custom, even the default 22
});

test('exportSizeBytes: UTF-8 bytes, not string length', () => {
  expect(exportSizeBytes('abc')).toBe(3);
  expect(exportSizeBytes('ü')).toBe(2);
  expect(exportSizeBytes('')).toBe(0);
});

test('exportFilename: mirrors the server Content-Disposition date stamp', () => {
  expect(exportFilename('2026-08-01T10:00:00.000Z')).toBe('tmuxifier-boxes-2026-08-01.json');
  expect(exportFilename('garbage')).toBe('tmuxifier-boxes.json');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/settingsBoxes.test.js`
Expected: FAIL — `exportStats` (and the others) have no export in `settingsBoxes.ts`.

- [ ] **Step 3: Write the implementation**

Add to `src/web/settingsBoxes.ts`, below `importSummary` (keep the existing `// Pure so it can be tested without a DOM` convention comment style). Also add `import type { Box } from './api';` — the file already has `import { api } from './api';`, so change that line to `import { api, type Box } from './api';`.

```ts
// The export-preview figures. Derived from the literal /api/export payload so
// the numbers describe the actual backup file, not a parallel computation.
export interface ExportStats {
  total: number; manual: number; proxmox: number; tagged: number;
  proxyJump: number; startupCommand: number; customPort: number; customUser: number;
}

const usedString = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

export function exportStats(payload: unknown): ExportStats {
  const stats: ExportStats = {
    total: 0, manual: 0, proxmox: 0, tagged: 0,
    proxyJump: 0, startupCommand: 0, customPort: 0, customUser: 0,
  };
  const boxes = (payload as { boxes?: unknown } | null)?.boxes;
  if (!Array.isArray(boxes)) return stats;
  stats.total = boxes.length;
  for (const raw of boxes) {
    const box = (raw ?? {}) as Partial<Box>;
    if (box.source === 'proxmox') stats.proxmox += 1; else stats.manual += 1;
    if (Array.isArray(box.tags) && box.tags.length > 0) stats.tagged += 1;
    if (usedString(box.proxyJump)) stats.proxyJump += 1;
    if (usedString(box.startupCommand)) stats.startupCommand += 1;
    if (box.port != null) stats.customPort += 1; // present = custom, even 22
    if (usedString(box.user)) stats.customUser += 1;
  }
  return stats;
}

export function exportSizeBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Mirrors the filename the server mints in its Content-Disposition
// (server.js: `tmuxifier-boxes-${payload.exportedAt.slice(0, 10)}.json`).
export function exportFilename(exportedAt: string): string {
  const stamp = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0];
  return stamp ? `tmuxifier-boxes-${stamp}.json` : 'tmuxifier-boxes.json';
}
```

Note: with `verbatimModuleSyntax`-style setups `import { api, type Box }` is the safe form; if `npm run typecheck` objects, use a separate `import type { Box } from './api';` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/settingsBoxes.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/web/settingsBoxes.ts test/settingsBoxes.test.js
git commit -m "feat(ui): pure export-preview stats helpers for the Boxes tab"
```

---

### Task 2: `api.exportPreview()` fetch method

**Files:**
- Modify: `src/web/api.ts`

**Interfaces:**
- Consumes: `httpError` from `src/web/http.ts` (`httpError(res: Response): Promise<HttpError>` — fires the shared 401 seam and builds the error). `api.ts` currently imports `import { jsonOf as j } from './http';`.
- Produces (Task 3 relies on these exact names):
  - `interface BoxExportPayload { type: string; version: number; exportedAt: string; boxes: Box[] }`
  - `api.exportPreview(): Promise<{ payload: BoxExportPayload; text: string }>`

No unit test: this is the fetch layer, which the repo does not unit test (no DOM/network in vitest); `npm run typecheck` is the verification, per every other `api` method.

- [ ] **Step 1: Add the payload type**

In `src/web/api.ts`, next to the other interface declarations (e.g. below `AddBoxSpec` near the top):

```ts
// The wrapped shape GET /api/export returns (store.exportBoxes()).
export interface BoxExportPayload { type: string; version: number; exportedAt: string; boxes: Box[] }
```

- [ ] **Step 2: Route the raw-text fetch through the 401 seam**

Change the http import line:

```ts
import { jsonOf as j, httpError } from './http';
```

Add to the `api` object, next to `importBoxes` (which handles the other half of the same feature):

```ts
// The export payload as text + parsed, for the Boxes tab's preview. Fetched
// as text (not j<T>) because the preview reports the file's true byte size;
// a non-ok response still routes through the shared 401 seam via httpError.
async exportPreview(): Promise<{ payload: BoxExportPayload; text: string }> {
  const res = await fetch('/api/export');
  if (!res.ok) throw await httpError(res);
  const text = await res.text();
  return { payload: JSON.parse(text) as BoxExportPayload, text };
},
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(ui): api.exportPreview fetches the export payload as text for the Boxes tab"
```

---

### Task 3: Render the preview, import caveat, and exclusions note

**Files:**
- Modify: `src/web/settingsBoxes.ts` (`renderBoxesSection`)
- Modify: `src/web/style.css` (new scoped classes, next to the `.pve-sub`/`.pve-inline` settings styles around line 1488)

**Interfaces:**
- Consumes: `api.exportPreview()` (Task 2), `exportStats`/`exportSizeBytes`/`exportFilename` (Task 1), `fmtBytes` from `src/web/fmt.ts` (`fmtBytes(n: number | null | undefined): string`), `el` from `src/web/dom.ts`.
- Produces: the final tab DOM. No later task consumes code from this one.

No unit test: vitest has no DOM (`environment: 'node'`); DOM layers are untested by design in this repo. Verification is typecheck + the full suite staying green + a build.

- [ ] **Step 1: Rewrite `renderBoxesSection`**

Replace the body of `renderBoxesSection` in `src/web/settingsBoxes.ts` so the whole file (imports + Task 1 helpers + this) reads:

```ts
// Settings → Boxes: export/import the box list as a JSON file, fronted by a
// preview of what the export actually contains and a note on what it doesn't.
// Relocated out of the sidebar brand actions, which are reserved for the
// routinely used controls (collapse, settings, logout).
import { el } from './dom';
import { api, type Box } from './api';
import { fmtBytes } from './fmt';
```

(then the Task 1 pure helpers and `importSummary` unchanged, then:)

```ts
export function renderBoxesSection(content: HTMLElement): void {
  // Settings sections have no access to main.ts's private showToast, so results
  // land on an inline status line — the convention every other section follows.
  const status = el('div', { class: 'pve-sub' });
  const setStatus = (msg: string, isError = false) => {
    status.className = isError ? 'pve-err' : 'pve-sub';
    status.textContent = msg;
  };

  // Export preview: filename, true byte size, and a stat grid, filled async.
  // The Export/Import buttons never depend on this fetch — backup and restore
  // must keep working when the preview doesn't.
  const previewHead = el('div', { class: 'boxes-stats-head' }, ['measuring…']);
  const previewGrid = el('div', { class: 'boxes-stats-grid' });
  const preview = el('div', { class: 'boxes-stats' }, [previewHead, previewGrid]);

  const statCell = (label: string, value: string) =>
    el('div', { class: 'boxes-stat' }, [
      el('span', { class: 'boxes-stat-label' }, [label]),
      el('span', { class: 'boxes-stat-value' }, [value]),
    ]);

  const loadPreview = async () => {
    try {
      const { payload, text } = await api.exportPreview();
      const s = exportStats(payload);
      previewHead.replaceChildren(
        el('span', {}, [exportFilename(payload.exportedAt)]),
        el('span', { class: 'boxes-stats-size' }, [fmtBytes(exportSizeBytes(text))]),
      );
      previewGrid.replaceChildren(
        statCell('boxes', String(s.total)),
        statCell('manual · pve', `${s.manual} · ${s.proxmox}`),
        statCell('tagged', String(s.tagged)),
        statCell('proxy jump', String(s.proxyJump)),
        statCell('startup command', String(s.startupCommand)),
        statCell('custom port', String(s.customPort)),
        statCell('custom user', String(s.customUser)),
      );
    } catch {
      previewHead.textContent = "Couldn't load export preview";
      previewGrid.replaceChildren();
    }
  };
  void loadPreview();

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true }) as HTMLInputElement;
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = ''; // reset so re-selecting the same file fires change again
    if (!picked) return;
    try {
      const payload = JSON.parse(await picked.text());
      const { added, skipped } = await api.importBoxes(payload);
      // The dashboard owns the box list and repaints on this event (main.ts).
      window.dispatchEvent(new Event('tmuxifier:boxes-changed'));
      setStatus(importSummary(added.length, skipped));
      void loadPreview(); // the figures should visibly reflect the new state
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`, true);
    }
  });

  const exportBtn = el('button', {
    type: 'button', class: 'pve-primary', onclick: () => {
      // Same-origin GET navigation: the session cookie rides along and the
      // server's Content-Disposition names the saved file.
      const a = document.createElement('a');
      a.href = '/api/export';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  }, ['Export boxes']);

  const importBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => file.click() }, ['Import boxes…']);

  content.replaceChildren(
    el('h3', {}, ['Boxes']),
    el('p', { class: 'pve-sub' }, ['Export writes your box list to a JSON file — a portable backup you can move between Tmuxifier instances. It carries no SSH secrets; boxes rely on your keys, agent, and ~/.ssh/config at connect time.']),
    el('div', { class: 'boxes-legend' }, ['What gets exported']),
    preview,
    el('div', { class: 'pve-inline' }, [exportBtn, importBtn]),
    el('p', { class: 'pve-sub' }, ['Import re-mints each id and skips duplicates (same host or label). Proxmox links are not restored — re-link from the box\'s Edit dialog afterwards.']),
    el('div', { class: 'boxes-legend' }, ['Not in this backup']),
    el('p', { class: 'pve-sub' }, ['Proxmox host profiles & presets, service tiles, fleet scripts & job history, NetBox settings, passkeys, and voice configuration live only in the data/ directory on the Tmuxifier host.']),
    status,
    file,
  );
}
```

- [ ] **Step 2: Add the CSS**

In `src/web/style.css`, immediately after the `.pve-inline` rule (~line 1492), add:

```css
/* Settings → Boxes: the export preview. Same figure grammar as the dashboard
   cards — engraved label, amber tabular value — scaled to the modal. */
.boxes-legend { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); margin-top: 14px; }
.boxes-stats { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-top: 6px; background: var(--panel-2); }
.boxes-stats-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.boxes-stats-size { color: var(--amber); }
.boxes-stats-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 18px; margin-top: 8px; }
.boxes-stats-grid:empty { display: none; }
.boxes-stat { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
.boxes-stat-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
.boxes-stat-value { font-size: 13px; color: var(--amber); font-variant-numeric: tabular-nums; }
```

(All variables — `--border`, `--panel-2`, `--muted`, `--dim`, `--amber` — already exist; they are the same ones `.dash-card-*` and `.fleet-job-status` use.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: clean typecheck, full suite green (the Task 1 tests included).

Run: `npm run build`
Expected: vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/web/settingsBoxes.ts src/web/style.css
git commit -m "feat(ui): Boxes tab shows export contents, size, import caveats and backup scope"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/configuration.md` (the "Settings → Boxes" paragraph under "## The settings modal", ~line 104)
- Modify: `CLAUDE.md` and `AGENTS.md` (the `settingsBoxes.ts` entry inside the web-client paragraph; the two files are kept in sync)

**Interfaces:** none — prose only.

- [ ] **Step 1: Update `docs/configuration.md`**

Replace the current paragraph:

> **Settings → Boxes** has **export** and **import** buttons that download and upload the full box
> list as a JSON file — a portable backup you can move between Tmuxifier instances. Import adds boxes
> from the file, re-minting each id and skipping any whose host/label already exists (so re-importing
> is safe).
> It carries no SSH secrets; boxes still rely on your keys/agent/`~/.ssh/config` at connect time.

with:

```markdown
**Settings → Boxes** has **export** and **import** buttons that download and upload the full box
list as a JSON file — a portable backup you can move between Tmuxifier instances. The tab previews
what the export contains before you download it: the file's name and true size, plus a stat grid
(box count, manual vs Proxmox-linked, and how many boxes use tags, a proxy jump, a startup
command, or a custom port/user). Import adds boxes from the file, re-minting each id and skipping
any whose host/label already exists (so re-importing is safe); **Proxmox links are not restored** —
re-link from the box's Edit dialog afterwards. The tab also lists what the backup does *not*
cover: Proxmox host profiles & presets, service tiles, fleet scripts & job history, NetBox
settings, passkeys, and voice configuration all live only in `data/` on the Tmuxifier host.
It carries no SSH secrets; boxes still rely on your keys/agent/`~/.ssh/config` at connect time.
```

(Keep the following sentence about sidebar collapsing untouched.)

- [ ] **Step 2: Update `CLAUDE.md` and `AGENTS.md`**

In both files, the web-client paragraph's Boxes entry currently reads:

> Boxes
> (`settingsBoxes.ts`: the leftmost tab, box-list JSON export/import moved out of the sidebar brand
> actions, which stay reserved for the routinely used controls; pure `importSummary`),

Replace with (reflow to the file's line width):

```markdown
Boxes
(`settingsBoxes.ts`: the leftmost tab — box-list JSON export/import moved out of the sidebar brand
actions, which stay reserved for the routinely used controls, fronted by an export preview that
fetches `GET /api/export` itself so the stat grid and byte size describe the literal backup file,
plus import caveats (ids re-minted, Proxmox links dropped) and a static not-in-this-backup note;
pure `importSummary`/`exportStats`/`exportSizeBytes`/`exportFilename`),
```

- [ ] **Step 3: Verify and commit**

Run: `npm test`
Expected: green (docs changes cannot break it; this is the pre-commit habit).

Review the staged diff for PII (no real hostnames/IPs/emails — the examples above use RFC1918/`example.com` only):

```bash
git add docs/configuration.md CLAUDE.md AGENTS.md
git diff --cached
git commit -m "docs: Boxes tab export preview, import caveats and backup scope"
```

---

## After the plan

Per the repo's standing workflow, this feature is validated on the **live app before it merges/ships**: build, `rsync -a --delete <worktree>/dist/ ./dist/`, restart the service (only when no setup/provision/lifecycle/fleet/voice-install job is running), and have the operator eyeball the tab — server-side green is not evidence a UI works. Ship via the release checklist in CLAUDE.md only after that validation.
