# Themes Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A theme switcher: the v1.18.0 Instrument look stays the default, an "Original" navy/cyan theme ships beside it, selection persists server-side, and adding a theme is one CSS file + one manifest line.

**Architecture:** Every color in `style.css` flows from the `:root` token block (alpha washes via `color-mix()`); a theme is a `:root[data-theme="<id>"]` token-override CSS file bundled by Vite; a new `data/ui-settings.json` store + `GET/PATCH /api/ui-settings` persists `{ theme, clawdAnim }` (the clawd animation pref migrates server-side); xterm resolves tokens through a probe element; a classic head script applies the localStorage mirror pre-paint.

**Tech Stack:** Node 20+ ESM, Fastify, vitest (env `node` — NO DOM tests), Playwright, Vite 5, TypeScript (web only), xterm.js, CodeMirror 6.

**Spec:** `docs/superpowers/specs/2026-08-08-themes-engine-design.md` — read it first.

## Global Constraints

- Server code is plain `.js` in `src/server/`; web client is `.ts` in `src/web/`. ESM everywhere.
- TDD with real code, no mocks (dependency-injection factories). vitest runs `environment: 'node'` — **never plan a DOM-rendering unit test**; DOM layers are covered by Playwright or live validation.
- **Instrument must remain visually identical.** Parity by construction: every literal collapse is an exact-value move into a token or an exact-alpha `color-mix()` — never an eyeballed near-match.
- CSP is `script-src 'self'` (`src/server/server.js:40`) — no inline scripts, no data:/blob: scripts. The boot script must be an external file.
- Slug validation everywhere: `^[a-z0-9-]{1,32}$`. The server is catalog-agnostic (never knows which themes/variants exist); the client normalizes unknown ids to defaults.
- Every fetch layer routes non-ok responses through `src/web/http.ts` (`test/webHttp.test.js` enforces; new API calls go in `src/web/api.ts` using its existing `j<...>(await fetch(...))` pattern).
- Public repo: no real PII in committed files. Nothing in this feature touches PII.
- Conventional-commit messages. Commit after each task.
- Run tests with `npx vitest run test/<file> --reporter=basic` for a single file; `npm test` = typecheck + full unit/integration suite.

## File Map

| File | Action | Responsibility |
| --- | --- | --- |
| `src/server/uiSettingsStore.js` | create | `data/ui-settings.json` read/patch, slug validation |
| `test/uiSettingsStore.test.js` | create | store unit tests |
| `test/uiSettingsRoutes.test.js` | create | route tests (auth, GET nulls, PATCH, 400) |
| `src/server/server.js` | modify | `uiSettingsStore` param + two routes |
| `src/server/index.js` | modify | construct + inject the store |
| `src/web/api.ts` | modify | `uiSettings()` / `patchUiSettings()` |
| `src/web/style.css` | modify | semantic rename; tokenize all literals; marker comments |
| `test/styleTokens.test.js` | create | convention tests (literals confined; theme files scoped) |
| `src/web/themes.ts` | create | pure manifest + `normalizeThemeId` |
| `src/web/themes/original.css` | create | the Original theme |
| `test/themes.test.js` | create | manifest integrity + normalize tests |
| `src/web/theme.ts` | create | DOM half: apply/subscribe/mirror/probe-resolve |
| `src/web/public/theme-boot.js` | create | pre-paint mirror application (classic script) |
| `src/web/index.html` | modify | boot script tag before the stylesheet |
| `src/web/main.ts` | modify | boot reconcile, settings fetch, clawd migration |
| `src/web/clawd.ts` | modify | server-backed cache (`setClawdVariant`/`currentClawdVariant`) |
| `test/clawd.test.js` | modify | cache behavior tests |
| `src/web/settingsAppearance.ts` | modify | Theme radios + server saves |
| `src/web/terminal.ts` | modify | screen theme from tokens + live update |
| `src/web/fleetEditor.ts` | modify | editor colors via tokens |
| `test/e2e/theme.spec.ts` | create | switch/persist/login-paint e2e |
| `DESIGN.md`, `CLAUDE.md`, `AGENTS.md`, `docs/fleet-and-health.md`, `README.md` | modify | docs |

---

### Task 1: uiSettingsStore

**Files:**
- Create: `src/server/uiSettingsStore.js`
- Test: `test/uiSettingsStore.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from `src/server/jsonFile.js` (usage exactly as `src/server/voiceStore.js`, the sibling pattern).
- Produces: `createUiSettingsStore({ dataDir })` → `{ read(): Promise<{theme: string|null, clawdAnim: string|null}>, update(patch): Promise<same> }`. `update` throws `Error('invalid <key>: …')` on bad values — Task 2's route maps that to 400.

- [ ] **Step 1: Write the failing test**

```js
// test/uiSettingsStore.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUiSettingsStore } from '../src/server/uiSettingsStore.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uiset-'));
  store = createUiSettingsStore({ dataDir: dir });
});

test('reads nulls when nothing is stored (unset is distinguishable from a choice)', async () => {
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('update patches only the provided keys and persists', async () => {
  await store.update({ theme: 'original' });
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: null });
  await store.update({ clawdAnim: 'pace' });
  // omitted key keeps the stored value — the PATCH-merge contract
  expect(await store.read()).toEqual({ theme: 'original', clawdAnim: 'pace' });
});

test('null clears a stored value', async () => {
  await store.update({ theme: 'original' });
  await store.update({ theme: null });
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('rejects non-slug values and unknown keys are ignored', async () => {
  await expect(store.update({ theme: 'Bad Theme!' })).rejects.toThrow(/invalid theme/);
  await expect(store.update({ clawdAnim: 'x'.repeat(33) })).rejects.toThrow(/invalid clawdAnim/);
  await expect(store.update({ theme: 42 })).rejects.toThrow(/invalid theme/);
  await store.update({ nonsense: 'value' }); // ignored, not an error
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('a corrupt file fails open to nulls', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), '{nope');
  expect(await store.read()).toEqual({ theme: null, clawdAnim: null });
});

test('non-slug garbage already in the file reads back as null', async () => {
  await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ theme: '<script>', clawdAnim: 'star' }));
  expect(await store.read()).toEqual({ theme: null, clawdAnim: 'star' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/uiSettingsStore.test.js --reporter=basic`
Expected: FAIL — cannot find module `uiSettingsStore.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/server/uiSettingsStore.js
import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

// data/ui-settings.json — cross-device UI preferences (theme, clawd working
// animation). Single-user app: one record, no per-user keying. Read per
// request like voiceStore.js so a change applies without a restart.
//
// Catalog-agnostic on purpose: the theme/variant catalogs live in the web
// bundle, so the server validates SHAPE only (slug charset/length) and the
// client normalizes unknown ids to defaults — renaming a theme in code can
// never brick the server. `null` means "never set", which the client needs
// to tell a fresh install from an explicit choice (the clawd migration).
const KEYS = ['theme', 'clawdAnim'];
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of KEYS) out[k] = typeof o[k] === 'string' && SLUG_RE.test(o[k]) ? o[k] : null;
  return out;
}

export function createUiSettingsStore({ dataDir }) {
  const file = path.join(dataDir, 'ui-settings.json');

  async function read() {
    // Corrupt file fails open to nulls: this is cosmetic data, and jsonFile.js
    // has already quarantined the unparseable original.
    const raw = await readJson(file, { fallback: {}, validate: (v) => v && typeof v === 'object' });
    return normalize(raw);
  }

  return {
    read,
    async update(patch = {}) {
      const current = await read();
      const next = { ...current };
      for (const k of KEYS) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (v === null) { next[k] = null; continue; }
        if (typeof v !== 'string' || !SLUG_RE.test(v)) throw new Error(`invalid ${k}: ${String(v).slice(0, 40)}`);
        next[k] = v;
      }
      await writeJson(file, next);
      return next;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/uiSettingsStore.test.js --reporter=basic`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify the data file is gitignored**

Run: `touch data/ui-settings.json && git check-ignore data/ui-settings.json && rm data/ui-settings.json`
Expected: prints the path (data/ is ignored). If it is NOT ignored, add `data/ui-settings.json` to `.gitignore` in this task.

- [ ] **Step 6: Commit**

```bash
git add src/server/uiSettingsStore.js test/uiSettingsStore.test.js
git commit -m "feat(server): ui-settings store for theme + clawd prefs"
```

---

### Task 2: /api/ui-settings routes + api.ts client

**Files:**
- Modify: `src/server/server.js` (buildServer param list at :118; add routes next to `GET /api/ui-config` at :1343)
- Modify: `src/server/index.js` (construct at ~:84 beside `createVoiceStore`, pass in the `buildServer({...})` call at ~:319)
- Modify: `src/web/api.ts` (new methods beside `uiConfig()` at :302)
- Test: `test/uiSettingsRoutes.test.js`

**Interfaces:**
- Consumes: `createUiSettingsStore` from Task 1.
- Produces: `GET /api/ui-settings` → `{ theme: string|null, clawdAnim: string|null }`; `PATCH /api/ui-settings` body `{ theme?: string|null, clawdAnim?: string|null }` → updated shape, 400 `{ error }` on invalid value. Client: `api.uiSettings(): Promise<UiSettings>`, `api.patchUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>`, `export interface UiSettings { theme: string | null; clawdAnim: string | null }`.

- [ ] **Step 1: Write the failing route test**

Follow the harness shape of `test/serviceRoutes.test.js` (mkdtemp dir, minimal `config` with `passwordHash: await hashPassword('pw')` and `cookieSecret: 'test-secret'`, stub `sessions`/`statusChecker`, login helper that POSTs `/api/login` and returns the `tmuxifier_session` cookie header):

```js
// test/uiSettingsRoutes.test.js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createUiSettingsStore } from '../src/server/uiSettingsStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uisr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    uiSettingsStore: createUiSettingsStore({ dataDir: dir }),
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('both routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PATCH', url: '/api/ui-settings', payload: {} })).statusCode).toBe(401);
});

test('GET returns nulls when unset; PATCH persists and merges', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json())
    .toEqual({ theme: null, clawdAnim: null });
  const patched = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'original' } });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toEqual({ theme: 'original', clawdAnim: null });
  await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { clawdAnim: 'star' } });
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json())
    .toEqual({ theme: 'original', clawdAnim: 'star' });
});

test('PATCH rejects invalid slugs with 400 and stores nothing', async () => {
  const h = await headers();
  const bad = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'No Spaces' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/invalid theme/);
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json().theme).toBe(null);
});

test('PATCH null clears', async () => {
  const h = await headers();
  await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'original' } });
  const cleared = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: null } });
  expect(cleared.json()).toEqual({ theme: null, clawdAnim: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/uiSettingsRoutes.test.js --reporter=basic`
Expected: FAIL — 404 statuses (routes don't exist).

- [ ] **Step 3: Add the routes and wiring**

In `src/server/server.js`, add `uiSettingsStore = null` to the `buildServer({ ... })` destructured params (:118). Next to the `/api/ui-config` route (:1343), add:

```js
  // Cross-device UI preferences (theme, clawd animation). Server is
  // catalog-agnostic: shape-validated slugs only; the client normalizes
  // unknown ids (see uiSettingsStore.js).
  if (uiSettingsStore) {
    app.get('/api/ui-settings', { preHandler: requireAuth }, async () => uiSettingsStore.read());
    app.patch('/api/ui-settings', { preHandler: requireAuth }, async (req, reply) => {
      try {
        return await uiSettingsStore.update(req.body && typeof req.body === 'object' ? req.body : {});
      } catch (err) {
        reply.code(400);
        return { error: String(err?.message || err) };
      }
    });
  }
```

In `src/server/index.js`: `import { createUiSettingsStore } from './uiSettingsStore.js';` (beside the voiceStore import at :50), `const uiSettingsStore = createUiSettingsStore({ dataDir: config.dataDir });` (beside :84), and add `uiSettingsStore,` to the `buildServer({ ... })` call at :319.

In `src/web/api.ts`, beside `uiConfig()` (:302):

```ts
  async uiSettings() { return j<UiSettings>(await fetch('/api/ui-settings')); },
  async patchUiSettings(patch: Partial<UiSettings>) {
    return j<UiSettings>(await fetch('/api/ui-settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
  },
```

and export the interface near the other exported types at the top:

```ts
export interface UiSettings { theme: string | null; clawdAnim: string | null }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/uiSettingsRoutes.test.js test/webHttp.test.js --reporter=basic && npm run typecheck`
Expected: PASS (webHttp confirms the api layer seam still holds; typecheck covers api.ts).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js src/web/api.ts test/uiSettingsRoutes.test.js
git commit -m "feat(server): GET/PATCH /api/ui-settings routes + web fetch layer"
```

---

### Task 3: Semantic token rename + --bench/--term-sel

**Files:**
- Modify: `src/web/style.css` (the `:root` block at :86 and every use site)
- Modify: `src/web/fleetEditor.ts` (two `var(--amber)` references: `.cm-content` caretColor and `.cm-cursor, .cm-dropCursor` borderLeftColor)

**Interfaces:**
- Produces: tokens `--accent` (was `--amber`), `--accent-deep` (was `--amber-deep`), `--commit` (was `--orange`), new `--term-sel` (terminal selection wash) and `--bench` (the body's full background list). Every later task refers to these names.

No behavior change; this is a pure rename + token extraction. Verification is grep + build, not a new test.

- [ ] **Step 1: Rename in order (deep first, so `--amber` doesn't clobber `--amber-deep`)**

Across `src/web/style.css` and `src/web/fleetEditor.ts`:
1. `--amber-deep` → `--accent-deep`
2. `--amber` → `--accent`
3. `--orange` → `--commit`

Update the `:root` comments to match (e.g. `--accent: #ffb000; /* alive: readouts, engaged modes, focus (Instrument: amber) */`).

- [ ] **Step 2: Add `--term-sel` and `--bench` to `:root`**

```css
  /* Terminal glass selection wash. MUST stay a plain color literal (hex or
     rgba) in every theme: xterm parses this string itself, so color-mix()
     or var() indirection here would not resolve (see theme.ts probe note). */
  --term-sel: rgba(255, 176, 0, 0.25);
  /* The bench itself: full background layer list for <body>, so a theme can
     swap the whole treatment (noise + worklight here; Original uses a glow). */
  --bench:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='linear' slope='0.05'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(1100px 640px at 50% -8%, rgba(255, 255, 255, 0.045), transparent 62%),
    var(--bg);
```

Change the `body` rule to use it (keep the existing `background-repeat` — it matches the three layers):

```css
  background: var(--bench);
  background-repeat: repeat, no-repeat, no-repeat;
  background-color: var(--bg);
```

- [ ] **Step 3: Verify**

Run: `grep -c -- '--amber\|--orange' src/web/style.css src/web/fleetEditor.ts; npm run build && npm run typecheck`
Expected: `0` for both files; build and typecheck green.

- [ ] **Step 4: Eyeball via dev server (optional but cheap)**

Run: `npm run dev` briefly; the app must look byte-identical (this was a pure rename).

- [ ] **Step 5: Commit**

```bash
git add src/web/style.css src/web/fleetEditor.ts
git commit -m "refactor(ui): semantic theme tokens — accent/commit rename, bench + term-sel tokens"
```

---

### Task 4: Convention test + collapse every literal into tokens

**Files:**
- Test: `test/styleTokens.test.js`
- Modify: `src/web/style.css`

**Interfaces:**
- Produces: marker comments `/* === THEME TOKENS (color literals allowed) === */` … `/* === END THEME TOKENS === */` fencing the `:root` block; commit-ramp tokens `--commit-hi`, `--commit-hi-2`, `--commit-mid`, `--commit-mid-2`, `--commit-deep`, `--commit-edge`, `--commit-rim`, `--commit-ink`; whatever neutral role tokens the collapse mints (e.g. `--seam`, `--scroll-thumb`). Task 5's theme file overrides these names.

- [ ] **Step 1: Write the failing convention test**

```js
// test/styleTokens.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The themes-engine contract: every color in style.css flows from the token
// block, so a theme file overriding tokens re-skins the whole app. Allowed
// outside the fence: pure black/white washes (highlight/shade "physics" —
// both shipped themes are dark) and non-color text.
const WEB = path.join(process.cwd(), 'src/web');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const OPEN = '/* === THEME TOKENS (color literals allowed) === */';
const CLOSE = '/* === END THEME TOKENS === */';

const BW_WASH = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,[^)]*)?\)|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,[^)]*)?\)/g;
// #hex, rgb()/rgba(), hsl()/hsla(), and %23-encoded hex inside data: URIs.
const COLOR = /#[0-9a-fA-F]{3,8}\b|%23[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

test('style.css: color literals live only inside the token fence', () => {
  const open = css.indexOf(OPEN);
  const close = css.indexOf(CLOSE);
  expect(open, 'token fence opening marker missing').toBeGreaterThan(-1);
  expect(close, 'token fence closing marker missing').toBeGreaterThan(open);
  const outside = (css.slice(0, open) + css.slice(close + CLOSE.length)).replace(BW_WASH, '');
  const hits = outside.match(COLOR) ?? [];
  expect(hits, `color literals outside the token fence (first 15): ${hits.slice(0, 15).join(' ')}`).toEqual([]);
});

test('theme files: every rule is [data-theme]-scoped, no at-rules', () => {
  const dir = path.join(WEB, 'themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')) : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = text.split('}').map((chunk) => chunk.split('{')[0].trim()).filter(Boolean);
    for (const sel of selectors) {
      // An @media line fails this on purpose: theme files hold flat rules only,
      // so this naive parser stays valid.
      expect(sel.includes('[data-theme='), `${f}: unscoped selector "${sel}"`).toBe(true);
    }
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/styleTokens.test.js --reporter=basic`
Expected: FAIL — marker missing, then (after adding markers) ~200+ literals listed.

- [ ] **Step 3: Add the fence and collapse the literals**

Put `OPEN` on the line above `:root {` (style.css:86) and `CLOSE` after its closing `}`. Then collapse every literal outside the fence, file top to bottom, with these rules:

**Rule A — exact token match → `var()`.** These literals ARE token values; replace with the token:
`#101216`→`var(--bg)` · `#16181d`→`var(--panel)` · `#1c1f25`→`var(--panel-2)` · `#0a0b0d`→`var(--screen)` · `#282c33`→`var(--border)` · `#3e4146`→`var(--gunmetal)` · `#343943`→`var(--key-border)` · `#e6e2da`→`var(--text)` · `#b9b4a6`→`var(--muted)` · `#8a8577`→`var(--dim)` · `#ffb000`→`var(--accent)` · `#e09600`→`var(--accent-deep)` · `#ff6a1a`→`var(--commit)` · `#3ecf6e`→`var(--ok)` · `#ff5c47`→`var(--crit)` · `#a98bff`→`var(--auth)`.

**Rule B — accent/status washes → `color-mix()`.** `rgba(255, 176, 0, A)` → `color-mix(in srgb, var(--accent) P%, transparent)` where P = A × 100 (e.g. 0.28 → 28%). Same for `rgba(255, 92, 71, A)` → `var(--crit)`, `rgba(62, 207, 110, A)` → `var(--ok)`, `rgba(169, 139, 255, A)` → `var(--auth)`, `rgba(255, 106, 26, A)` → `var(--commit)` washes if present. This also covers the focus ring, `::selection`, and every glow.

**Rule C — commit-key ramp → fixed new tokens** (mint in the fence with these exact names and today's exact values):

```css
  /* Commit key material ramp (Instrument: safety orange). */
  --commit-hi: #ff8a4d;
  --commit-hi-2: #ff7d38;
  --commit-mid: #fb6c1a;
  --commit-mid-2: #f56413;
  --commit-deep: #c94f0e;
  --commit-edge: #8f3708;
  --commit-rim: #7a2f06;
  --commit-ink: #1a0e05;
```

**Rule D — remaining one-off colors → mint a role-named token.** Same literal everywhere → one token; distinct literals → distinct tokens, even when close (parity by construction — never merge near-matches). Known cases: `#1f2228` (11×, panel seams → `--seam`), `#23262c` (key-face top highlight → `--key-hi`), scrollbar trio `#2a2d33`/`#24272d`/`#2e323a` (→ `--scroll-thumb`, `--scroll-thumb-wk`, `--scroll-thumb-hover`). Name the rest by role after reading each rule; every minted token goes inside the fence with a one-line comment.

**Rule E — a colored `url(data:…)` value that can't take `var()` → move the whole property value into a token** (like `--bench`). The `%23` regex arm catches these.

- [ ] **Step 4: Iterate until green**

Run: `npx vitest run test/styleTokens.test.js --reporter=basic`
Expected: PASS. Then `npm test` — full suite green.

- [ ] **Step 5: Visual parity spot-check**

`npm run dev`; click through login, sidebar, a terminal, the dashboard, Settings, the fleet script editor. Everything must look identical (all edits were exact-value moves).

- [ ] **Step 6: Commit**

```bash
git add src/web/style.css test/styleTokens.test.js
git commit -m "refactor(ui): collapse all style.css color literals into the theme token fence"
```

---

### Task 5: Theme manifest + the Original theme file

**Files:**
- Create: `src/web/themes.ts`
- Create: `src/web/themes/original.css`
- Test: `test/themes.test.js`

**Interfaces:**
- Consumes: token names from Tasks 3–4 (read the current fence in `style.css` for the full list — especially the `--commit-*` ramp and any Rule-D tokens).
- Produces: `THEMES: ThemeDef[]`, `DEFAULT_THEME_ID = 'instrument'`, `normalizeThemeId(raw: unknown): string`, `interface ThemeDef { id: string; label: string; description: string }`. Tasks 7–8 import these.

- [ ] **Step 1: Write the failing tests**

```js
// test/themes.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, DEFAULT_THEME_ID, normalizeThemeId } from '../src/web/themes.ts';

test('manifest: instrument first, ids unique and slug-valid, labels present', () => {
  expect(THEMES[0].id).toBe(DEFAULT_THEME_ID);
  const ids = THEMES.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const t of THEMES) {
    expect(t.id).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(t.label.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
  }
});

test('normalizeThemeId: known ids pass, everything else falls back to the default', () => {
  expect(normalizeThemeId('original')).toBe('original');
  expect(normalizeThemeId('instrument')).toBe('instrument');
  expect(normalizeThemeId('never-heard-of-it')).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(null)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(undefined)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(42)).toBe(DEFAULT_THEME_ID);
});

test('manifest and themes/ dir agree: one CSS file per non-default theme', () => {
  // The lock-together pattern (test/provisionTools.test.js): the picker can
  // never offer a theme whose CSS is missing, or ship an orphan CSS file.
  const dir = path.join(process.cwd(), 'src/web/themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)) : [];
  const nonDefault = THEMES.slice(1).map((t) => t.id);
  expect(files.sort()).toEqual(nonDefault.sort());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/themes.test.js --reporter=basic`
Expected: FAIL — cannot find module `themes.ts`.

- [ ] **Step 3: Write the manifest**

```ts
// src/web/themes.ts
// The theme catalog — pure and node-testable (no DOM, no CSS imports; the
// side-effect CSS imports live in theme.ts, the DOM half). Adding a theme:
// 1. src/web/themes/<id>.css with every rule scoped :root[data-theme="<id>"]
//    (test/styleTokens.test.js enforces the scoping),
// 2. one entry here (+ its import in theme.ts),
// and the Appearance picker, persistence, terminals and editor follow.
export interface ThemeDef { id: string; label: string; description: string }

export const DEFAULT_THEME_ID = 'instrument';

export const THEMES: ThemeDef[] = [
  { id: 'instrument', label: 'Bench Instrument', description: 'charcoal chassis, amber phosphor — the machined desk instrument' },
  { id: 'original', label: 'Original', description: 'the first tmuxifier look: deep navy, cyan glow' },
];

// Unknown/stale ids (removed theme, hand-edited store) read as the default
// rather than propagating an unresolvable id — the clawd normalize pattern.
export function normalizeThemeId(raw: unknown): string {
  return THEMES.some((t) => t.id === raw) ? (raw as string) : DEFAULT_THEME_ID;
}
```

- [ ] **Step 4: Write the Original theme**

`src/web/themes/original.css` — starting values from the spec's palette table (source: `git show 247b906~1:src/web/style.css`); every value here is tuned later during live validation, but the FILE must be complete now. Override at minimum: the chassis neutrals, accent family, commit family + the full `--commit-*` ramp from Task 4 (re-derive in cyan/green family), `--term-sel`, `--face`, `--bench`, and soften the key material (`--key-face`, `--key-border`). Read the fence in `style.css` and consider each token deliberately — inheriting is a decision, not an omission (status LEDs deliberately inherit). Example skeleton with the known values:

```css
/* Original — the pre-v1.18.0 neon-terminal world, reinterpreted as a skin
   over the Instrument layout. Navy field, cyan accent, glow over extrusion,
   sans chrome. Terminal-facing tokens (--term-sel and anything the theme.ts
   probe resolves) must stay plain color literals — no color-mix, no var(). */
:root[data-theme='original'] {
  --bg: #070a0f;
  --panel: #0d121b;
  --panel-2: #111824;
  --gunmetal: #1c2635;
  --border: #202938;
  --screen: #050a12;
  --text: #d8e1ea;
  --muted: #7f8b9a;
  --dim: #5c6878;
  --accent: #24d3e8;
  --accent-deep: #17a8ba;
  --commit: #58e58c;
  --commit-hi: #7deca6;
  --commit-hi-2: #6ae99a;
  --commit-mid: #58e58c;
  --commit-mid-2: #46d97d;
  --commit-deep: #2ca75c;
  --commit-edge: #1d7440;
  --commit-rim: #175c34;
  --commit-ink: #05130b;
  --term-sel: rgba(36, 211, 232, 0.25);
  --face: ui-sans-serif, system-ui, sans-serif;
  --key-border: #223045;
  --key-face: linear-gradient(180deg, #121a28, #0d121b);
  --bench:
    radial-gradient(circle at 50% 12%, rgba(36, 211, 232, 0.12), transparent 34%),
    linear-gradient(180deg, #0a1018 0%, #070a0f 56%, #05070b 100%);
}
```

(Also override any Rule-D tokens from Task 4 — `--seam`, scrollbar trio, etc. — into the navy family.) The two-layer `--bench` needs `body`'s `background-repeat` to still make sense: the first layer isn't a repeating tile here, and `repeat` on a no-repeat-shaped radial gradient is harmless, so no extra rule is required.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/themes.test.js test/styleTokens.test.js --reporter=basic && npm run typecheck`
Expected: PASS — manifest tests green, and the theme-file scoping test now has a real file to check.

- [ ] **Step 6: Commit**

```bash
git add src/web/themes.ts src/web/themes/original.css test/themes.test.js
git commit -m "feat(ui): theme manifest + the Original (navy/cyan) theme file"
```

---

### Task 6: clawd.ts — server-backed cache

**Files:**
- Modify: `src/web/clawd.ts`
- Test: `test/clawd.test.js` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `setClawdVariant(raw: unknown, storage?: PrefStorage): ClawdVariantId` (normalizes, caches, refreshes the localStorage mirror), `currentClawdVariant(): ClawdVariantId` (cache, else mirror, else default), `hasStoredClawdPref(storage?: PrefStorage): boolean`. Existing `loadClawdVariant`/`saveClawdVariant`/`normalizeClawdVariant` keep their exact signatures (their tests must stay green). `buildClawd()` switches to `currentClawdVariant()`.

- [ ] **Step 1: Write the failing tests (append to test/clawd.test.js)**

```js
import { setClawdVariant, currentClawdVariant, hasStoredClawdPref } from '../src/web/clawd.ts';

test('setClawdVariant normalizes, caches, and refreshes the mirror', () => {
  const store = memStorage();
  expect(setClawdVariant('pace', store)).toBe('pace');
  expect(store.getItem('tmuxifier.clawdAnim')).toBe('pace');
  expect(currentClawdVariant()).toBe('pace');
  // junk from the server (stale slug after a rename) falls back to default
  expect(setClawdVariant('gone-variant', store)).toBe(DEFAULT_CLAWD_VARIANT);
  expect(currentClawdVariant()).toBe(DEFAULT_CLAWD_VARIANT);
});

test('hasStoredClawdPref distinguishes never-set from set', () => {
  expect(hasStoredClawdPref(memStorage())).toBe(false);
  expect(hasStoredClawdPref(memStorage({ 'tmuxifier.clawdAnim': 'star' }))).toBe(true);
});
```

(Reuse the file's existing `memStorage` helper; import `DEFAULT_CLAWD_VARIANT` if the new block needs it. Note the module-level cache persists across tests in this file — each test sets it explicitly before reading, as above.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/clawd.test.js --reporter=basic`
Expected: FAIL — `setClawdVariant` not exported.

- [ ] **Step 3: Implement**

In `src/web/clawd.ts`, update the header comment (the pref is now server-side in `data/ui-settings.json`; localStorage is a boot-seed mirror only) and add:

```ts
// The authoritative pref now lives server-side (data/ui-settings.json, one
// setting for every browser). This module keeps a synchronous cache so the
// frequent render sites (sidebar badge, pane chips, fleet strip) never await:
// main.ts seeds it from GET /api/ui-settings at boot, the Appearance tab sets
// it on change. localStorage remains as a mirror that seeds pre-fetch renders.
let cached: ClawdVariantId | null = null;

export function setClawdVariant(raw: unknown, storage?: PrefStorage): ClawdVariantId {
  cached = normalizeClawdVariant(raw);
  saveClawdVariant(cached, storage); // keep the mirror fresh for the next boot
  return cached;
}

export function currentClawdVariant(): ClawdVariantId {
  return cached ?? loadClawdVariant();
}

export function hasStoredClawdPref(storage?: PrefStorage): boolean {
  try { return (storage ?? localStorage).getItem(KEY) !== null; } catch { return false; }
}
```

Change `buildClawd()`'s body to `return buildClawdVariant(currentClawdVariant());`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/clawd.test.js --reporter=basic && npm run typecheck`
Expected: PASS — new tests green, all pre-existing clawd tests untouched and green.

- [ ] **Step 5: Commit**

```bash
git add src/web/clawd.ts test/clawd.test.js
git commit -m "feat(ui): clawd variant becomes a server-backed cached pref"
```

---

### Task 7: theme.ts, boot script, main.ts wiring + migration

**Files:**
- Create: `src/web/theme.ts`
- Create: `src/web/public/theme-boot.js` (Vite `publicDir` — `src/web/public/` doesn't exist yet; creating it is enough, Vite copies its contents to `dist/` root)
- Modify: `src/web/index.html` (script tag in `<head>` BEFORE the stylesheet link)
- Modify: `src/web/main.ts` (top-level reconcile + `start()` fetch/apply/migration at :360-371)

**Interfaces:**
- Consumes: `normalizeThemeId`/`DEFAULT_THEME_ID`/`THEMES` (Task 5), `api.uiSettings`/`api.patchUiSettings` (Task 2), `setClawdVariant`/`hasStoredClawdPref`/`loadClawdVariant` (Task 6).
- Produces: `applyTheme(raw: unknown): void`, `currentTheme(): string`, `onThemeChange(fn: () => void): () => void` (returns unsubscribe), `resolveScreenTheme(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string }`. Tasks 8–9 import these.

- [ ] **Step 1: Write theme.ts**

No unit test — this is the DOM half (vitest has no DOM by repo convention); Playwright covers it in Task 11. The pure parts (`normalizeThemeId`, manifest) were tested in Task 5.

```ts
// src/web/theme.ts
// The DOM half of the themes engine (themes.ts is the pure catalog). Applies
// a theme by stamping data-theme on <html> — :root[data-theme] token blocks
// in themes/*.css do the rest — mirrors the choice into localStorage so
// public/theme-boot.js can paint the login screen pre-auth on the next visit,
// and notifies subscribers (open terminals re-resolve their xterm theme).
//
// Theme CSS side-effect imports live HERE, not in themes.ts: node tests
// import the manifest, and they must never pull CSS through vitest.
import './themes/original.css';
import { DEFAULT_THEME_ID, normalizeThemeId } from './themes';

const KEY = 'tmuxifier.theme';
const listeners = new Set<() => void>();

function readMirror(): string {
  try { return localStorage.getItem(KEY) ?? DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}

let current = normalizeThemeId(readMirror());

export function currentTheme(): string { return current; }

export function applyTheme(raw: unknown): void {
  const id = normalizeThemeId(raw);
  // The default carries no attribute: :root tokens ARE the Instrument theme,
  // and theme-boot.js only ever sets a non-default id.
  if (id === DEFAULT_THEME_ID) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* private mode: login flash only */ }
  if (id === current) return;
  current = id;
  for (const fn of [...listeners]) fn();
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// xterm needs concrete color strings. Reading a raw custom property returns
// its UNRESOLVED text ("color-mix(…)", "var(--x)"), so resolve through a
// probe element instead — computed `color` comes back as usable rgb()/rgba().
// Terminal-facing theme tokens must still be plain literals (see style.css
// --term-sel comment): a color-mix() there can serialize as color(srgb …),
// which xterm's parser refuses — the startsWith guard falls back if so.
const SCREEN_FALLBACK = {
  background: '#0a0b0d',
  foreground: '#e6e2da',
  cursor: '#ffb000',
  cursorAccent: '#0a0b0d',
  selectionBackground: 'rgba(255, 176, 0, 0.25)',
};

function resolveColor(varName: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${varName})`;
    document.documentElement.append(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v && (v.startsWith('rgb') || v.startsWith('#')) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function resolveScreenTheme(): typeof SCREEN_FALLBACK {
  const background = resolveColor('--screen', SCREEN_FALLBACK.background);
  return {
    background,
    foreground: resolveColor('--text', SCREEN_FALLBACK.foreground),
    cursor: resolveColor('--accent', SCREEN_FALLBACK.cursor),
    cursorAccent: background,
    selectionBackground: resolveColor('--term-sel', SCREEN_FALLBACK.selectionBackground),
  };
}
```

- [ ] **Step 2: Write the boot script and reference it**

```js
// src/web/public/theme-boot.js
// Classic blocking script, loaded in <head> BEFORE the stylesheet: stamps the
// mirrored theme onto <html> pre-paint so the body background never flashes
// the default theme. Lives in public/ because CSP is script-src 'self' — this
// must stay an external same-origin file, never inlined into index.html.
// Kept dumb on purpose: unknown-but-well-formed ids stamp an attribute no CSS
// matches (harmless — :root defaults apply); theme.ts normalizes properly
// once the bundle runs.
(function () {
  try {
    var t = localStorage.getItem('tmuxifier.theme');
    if (t && t !== 'instrument' && /^[a-z0-9-]{1,32}$/.test(t)) {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* private mode: default until login */ }
})();
```

In `src/web/index.html`, add above the stylesheet link:

```html
    <script src="/theme-boot.js"></script>
```

- [ ] **Step 3: Wire main.ts**

Add imports: `import { applyTheme, currentTheme } from './theme';` and extend the clawd import line (`buildClawd` is already imported) with `setClawdVariant, hasStoredClawdPref, loadClawdVariant`.

At module top level (right after `const app = document.getElementById('app')!;`):

```ts
// Reconcile whatever theme-boot.js stamped pre-paint: applyTheme normalizes
// stale/unknown mirror ids back to the default and seeds the subscriber state.
applyTheme(currentTheme());
```

In `start()` (:360), inside the authenticated branch, after the existing `uiCfg` try/catch:

```ts
    // Server-side UI prefs: theme + clawd animation. Best-effort — on failure
    // the mirror-painted theme and localStorage-seeded clawd pref stand.
    try {
      const st = await api.uiSettings();
      applyTheme(st.theme);
      if (st.clawdAnim === null && hasStoredClawdPref()) {
        // One-time migration: the pref used to be per-browser localStorage.
        void api.patchUiSettings({ clawdAnim: setClawdVariant(loadClawdVariant()) }).catch(() => {});
      } else {
        setClawdVariant(st.clawdAnim);
      }
    } catch {}
```

Note: `applyTheme(st.theme)` with `st.theme === null` normalizes to the default — correct: server unset means default, and the mirror gets rewritten to match.

- [ ] **Step 4: Verify build + boot artifacts**

Run: `npm run build && ls dist/theme-boot.js && grep -c "theme-boot" dist/index.html && npm run typecheck && npm test`
Expected: `dist/theme-boot.js` exists, `1` reference in built HTML, everything green.

- [ ] **Step 5: Manual boot check**

`npm run dev`; in the browser console: `localStorage.setItem('tmuxifier.theme', 'original')`, hard-reload → `<html data-theme="original">` present before login (Elements panel). Set back to `'instrument'`, reload → attribute gone.

- [ ] **Step 6: Commit**

```bash
git add src/web/theme.ts src/web/public/theme-boot.js src/web/index.html src/web/main.ts
git commit -m "feat(ui): theme apply/subscribe engine, pre-paint boot script, server-pref boot wiring"
```

---

### Task 8: Appearance tab — Theme picker + server saves

**Files:**
- Modify: `src/web/settingsAppearance.ts` (full rewrite below)

**Interfaces:**
- Consumes: `THEMES` (Task 5), `applyTheme`/`currentTheme` (Task 7), `setClawdVariant`/`currentClawdVariant` (Task 6), `api.patchUiSettings` (Task 2).
- Produces: unchanged export `renderAppearanceSection(content: HTMLElement): void` (stays sync — current values come from the module caches reconciled at boot, no fetch in render).

No unit test — DOM layer (no-DOM convention); covered by the Task 11 e2e and live validation.

- [ ] **Step 1: Rewrite settingsAppearance.ts**

```ts
import { el } from './dom';
import { CLAWD_VARIANTS, buildClawdVariant, currentClawdVariant, setClawdVariant } from './clawd';
import { THEMES } from './themes';
import { applyTheme, currentTheme } from './theme';
import { api } from './api';

// Settings → Appearance: theme + working-agent animation. Both persist
// server-side (data/ui-settings.json) so every browser follows one setting;
// no Save button — selecting a row applies instantly and PATCHes. A failed
// save keeps the local apply (it works this session) and says so, rather
// than yanking a theme the operator is already looking at.
export function renderAppearanceSection(content: HTMLElement): void {
  const note = el('p', { class: 'pve-sub appearance-save-note' }, ['']);
  const save = (patch: { theme?: string; clawdAnim?: string }) => {
    api.patchUiSettings(patch)
      .then(() => { note.textContent = ''; })
      .catch(() => { note.textContent = 'Couldn’t save to the server — applied in this browser for now.'; });
  };
  const themeRows = THEMES.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'ui-theme', value: id }) as HTMLInputElement;
    radio.checked = id === currentTheme();
    radio.onchange = () => { if (radio.checked) { applyTheme(id); save({ theme: id }); } };
    return el('label', { class: 'check-field appearance-row' }, [
      radio, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  const clawdRows = CLAWD_VARIANTS.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'clawd-anim', value: id }) as HTMLInputElement;
    radio.checked = id === currentClawdVariant();
    radio.onchange = () => { if (radio.checked) { setClawdVariant(id); save({ clawdAnim: id }); } };
    // The preview is the real builder + the real CSS classes, so it cannot
    // drift from what the chips render.
    const preview = el('span', { class: 'appearance-prev' }, [buildClawdVariant(id)]);
    return el('label', { class: 'check-field appearance-row' }, [
      radio, preview, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  content.replaceChildren(
    el('h3', {}, ['Appearance']),
    el('div', { class: 'pve-eyebrow' }, ['Theme']),
    ...themeRows,
    el('div', { class: 'pve-eyebrow' }, ['Working-agent animation']),
    ...clawdRows,
    note,
    el('p', { class: 'pve-sub' }, ['Saved on the server: every browser follows on its next load; this one switches instantly. Animation applies to the sidebar badge, pane chips, and the dashboard fleet strip on their next status refresh. Reduced-motion keeps every choice still.']),
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: green. Then `npm run dev`: Appearance tab shows Theme radios above the animation radios; clicking Original re-skins the app instantly; the network tab shows the PATCH; reloading the page keeps Original.

- [ ] **Step 3: Commit**

```bash
git add src/web/settingsAppearance.ts
git commit -m "feat(ui): theme picker in Settings → Appearance, prefs saved server-side"
```

---

### Task 9: Terminal glass follows the theme

**Files:**
- Modify: `src/web/terminal.ts` — the `SCREEN_THEME` const (:432-438), both `new Terminal({ theme: … })` sites (:461 in `openTerminal`, :584 in `openProvisionTerminal`), and both teardown paths (`dispose` in the `openTerminal` return at :565-571; the equivalent close path of `openProvisionTerminal`, whose return is at :629 — read that function to find where it tears down, e.g. its ws close/exit handler).

**Interfaces:**
- Consumes: `resolveScreenTheme`/`onThemeChange` (Task 7).
- Produces: nothing new — pane handles keep their exact shape (`focus`/`dispose`/`refit`/`input`/`appCursor`).

- [ ] **Step 1: Replace SCREEN_THEME with resolved tokens**

Delete the `SCREEN_THEME` const (its literal values already live on as `SCREEN_FALLBACK` in theme.ts — note that in the removal). Add to terminal.ts's imports: `import { resolveScreenTheme, onThemeChange } from './theme';`. Replace both `theme: SCREEN_THEME,` occurrences with `theme: resolveScreenTheme(),` and keep (move) the original comment: ANSI colors stay at xterm defaults — terminal content belongs to the programs running in it, in every theme.

- [ ] **Step 2: Live-update open terminals on theme switch**

In `openTerminal`, after the `term` is constructed (near where other listeners are wired, before the `return`):

```ts
  // Re-skin the glass in place when the operator switches themes: xterm
  // repaints on options.theme assignment, no reopen needed.
  const offTheme = onThemeChange(() => { term.options.theme = resolveScreenTheme(); });
```

and add `offTheme();` into the returned `dispose` (:566, alongside `offUploads(); offTouchScroll();`).

In `openProvisionTerminal`, add the identical subscription after its `term` is constructed, and call its `offTheme()` in that function's teardown path (wherever the ws closes / `onComplete` fires and the terminal is disposed — read the function body around :575-660 and place it beside the existing cleanup).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: green. `npm run dev`: open a box terminal, switch theme in Settings → the glass background/cursor/selection change in place; open + close a provision/setup terminal, switch theme again → no console errors (the unsubscribe held).

- [ ] **Step 4: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(ui): terminal glass resolves theme tokens and follows switches live"
```

---

### Task 10: Script editor colors via tokens

**Files:**
- Modify: `src/web/fleetEditor.ts` (the `HIGHLIGHT` and `THEME` definitions, ~:55-110)
- Modify: `src/web/style.css` (four new syntax tokens inside the fence)

**Interfaces:**
- Consumes: tokens from Tasks 3–4.
- Produces: tokens `--syn-string: #a8c987`, `--syn-const: #ff9d5c`, `--syn-fn: #ffd166`, `--syn-gutter: #5d594e` (exact current values — parity). Theme authors may override them; Original inherits them initially (tune during live validation).

CodeMirror's `HighlightStyle`/`EditorView.theme` emit real CSS classes, so `var()` and `color-mix()` strings work as values — no JS re-theming needed.

- [ ] **Step 1: Add the four tokens to the style.css fence**

```css
  /* Script-editor syntax (CodeMirror emits real CSS, so themes reach these). */
  --syn-string: #a8c987;
  --syn-const: #ff9d5c;
  --syn-fn: #ffd166;
  --syn-gutter: #5d594e;
```

- [ ] **Step 2: Replace every literal in fleetEditor.ts**

In `HIGHLIGHT`: keyword family `'#ffb000'`→`'var(--accent)'` (if not already renamed in Task 3 — Task 3 only touched `var(--amber)` references, these were raw hex); strings `'#a8c987'`→`'var(--syn-string)'`; comments `'#8a8577'`→`'var(--dim)'`; numbers/atom `'#ff9d5c'`→`'var(--syn-const)'`; variables `'#e6e2da'`→`'var(--text)'`; definitions `'#ffd166'`→`'var(--syn-fn)'`; operators `'#b9b4a6'`→`'var(--muted)'`.

In `THEME`: `rgba(255, 176, 0, 0.45)`→`color-mix(in srgb, var(--accent) 45%, transparent)` (focused border), and likewise the `0.12` ring, `0.04` active line, `0.16` matching bracket, `0.2` selection, `0.14` autocomplete selection; gutter `'#5d594e'`→`'var(--syn-gutter)'`; placeholder `'#8a8577'`→`'var(--dim)'`. The `rgba(0, 0, 0, 0.5)` inset shadows stay (black wash — same exemption as style.css). The `.cm-scroller` Meslo `fontFamily` string stays LITERAL on purpose: the editor is screen content, and a sans `--face` theme must not de-mono the script editor.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: green. `npm run dev`: fleet script editor (⤢ from the fleet bar) looks identical in Instrument; switch to Original → editor chrome and syntax go cyan-family with no reload.

- [ ] **Step 4: Commit**

```bash
git add src/web/fleetEditor.ts src/web/style.css
git commit -m "feat(ui): script editor colors flow from theme tokens"
```

---

### Task 11: e2e — switch, persist, pre-auth paint

**Files:**
- Create: `test/e2e/theme.spec.ts`

**Interfaces:**
- Consumes: the running e2e server (global-setup, password `e2e`, port 7438), `#settings` button (`src/web/main.ts:992`), the Appearance tab strip (`.pve-tabs`), the radio rows from Task 8.

The filename must NOT match `/(phone|touchBar)\.spec\.ts/` (it doesn't), so it runs in the desktop project only. `workers: 1` — the server is shared and the theme pref is server-global, so the spec MUST restore Instrument before finishing or it would repaint every later spec.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function pickTheme(page, label: string) {
  await page.click('#settings');
  await page.click('.pve-tabs button:has-text("Appearance")');
  await page.click(`.appearance-row:has-text("${label}") input[name="ui-theme"]`);
  await page.keyboard.press('Escape'); // close the settings modal
}

test('theme switches live, persists server-side, and paints pre-auth via the mirror', async ({ page }) => {
  await login(page);
  const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await pickTheme(page, 'Original');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');
  const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bgAfter).not.toBe(bgBefore);

  // Server-persisted: a fresh load lands on Original again…
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');

  // …and theme-boot.js stamps it from the mirror BEFORE login: check on a
  // logged-out surface by clearing the session cookie only (mirror survives).
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.locator('#pw')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');

  // Restore for the rest of the suite (shared server, workers: 1).
  await login(page);
  await pickTheme(page, 'Bench Instrument');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});
```

- [ ] **Step 2: Build + run it**

Run: `npm run build && npx playwright test test/e2e/theme.spec.ts --project=desktop`
Expected: PASS. (Remember the e2e lesson from v1.24.16: playwright runs against `dist/`, so REBUILD between any edit and rerun.)

- [ ] **Step 3: Run the whole e2e suite once**

Run: `npm run test:e2e`
Expected: all specs green — proves the restore step leaves the shared server on Instrument and no other spec sees a navy app.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/theme.spec.ts
git commit -m "test(e2e): theme switch, server persistence, pre-auth mirror paint"
```

---

### Task 12: Docs + full verification

**Files:**
- Modify: `DESIGN.md`, `CLAUDE.md`, `AGENTS.md`, `docs/fleet-and-health.md`, `README.md`

- [ ] **Step 1: DESIGN.md**

Add a short section after the Overview (keep DESIGN.md's voice):

```markdown
## Themes

DESIGN.md is the visual authority for the **Instrument** theme — the `:root`
token defaults in style.css. The themes engine (2026-08-08 spec) lets a
checked-in CSS file re-skin the app: every color flows from the token fence in
style.css (`/* === THEME TOKENS === */`), a theme overrides tokens under
`:root[data-theme="<id>"]` in `src/web/themes/<id>.css`, and
`test/styleTokens.test.js` enforces both halves (no literals outside the
fence; theme rules always scoped). Terminal-facing tokens (`--screen`,
`--text`, `--accent`, `--term-sel`) must stay plain color literals — xterm
resolves them through a probe and cannot parse unresolved color-mix() output.
Status LEDs (`--ok`/`--warn`/`--crit`/`--auth`) are semantic and inherit
unless a theme deliberately overrides them. A theme owns its world: overriding
the material recipes (`--key-face`, `--bench`, …) is expected, not a hack.
```

- [ ] **Step 2: CLAUDE.md + AGENTS.md (kept in sync)**

- Architecture list: add `uiSettingsStore.js` — one line: `data/ui-settings.json` CRUD for cross-device UI prefs (theme, clawd animation); catalog-agnostic slug validation, client normalizes; served by GET/PATCH `/api/ui-settings`.
- Web client list: describe `themes.ts` (pure catalog + normalize), `theme.ts` (data-theme apply, mirror, probe-resolved xterm theme, `public/theme-boot.js` pre-paint stamp — external file because CSP stays `script-src 'self'`), and update the `clawd.ts` and `settingsAppearance.ts` descriptions (pref now server-side; localStorage is a boot mirror; one-time migration in main.ts).
- Self-contained section's `data/` list: add `ui-settings.json` (UI theme + animation prefs — nothing secret).

- [ ] **Step 3: docs/fleet-and-health.md + README.md**

In the guide's Appearance section: themes exist, where to switch (Settings → Appearance), server-side persistence (all browsers follow), and that Instrument/Original ship built-in; adding one is a code change (`src/web/themes/` + manifest). README: one feature line linking to the guide.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run test:e2e && npm run build`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add DESIGN.md CLAUDE.md AGENTS.md docs/fleet-and-health.md README.md
git commit -m "docs: themes engine — token contract, ui-settings store, appearance guide"
```

---

## After the plan: live validation + ship (operator-gated, not a task)

Standing workflow (CLAUDE.md "Shipping"), with one trap called out: **this feature touches the server** (`server.js`, `index.js`, new store), so the live candidate needs the branch checked out on the live app — the rsync-dist-only recipe would silently run the OLD server with the NEW client (the v1.24.25 lesson: that exact mismatch shipped a bug).

1. Build on the branch; deploy branch checkout + `dist/` to the live app; restart only when no setup/provision/lifecycle/fleet/voice-install job is `running`.
2. Operator validates: Instrument looks pixel-identical everywhere (login, sidebar, terminal, dashboard, cards, settings, fleet editor, phone); Original reads right on desktop + phone; switch is instant; terminals re-skin live; login screen paints Original pre-auth after a reload; clawd pick survives a different browser.
3. Tune `themes/original.css` values on the branch until the operator is happy (this is where the spec's "starting palette" gets finished).
4. Merge to main, then the release checklist (version bump, build, restart, health check, PII scrub of the staged diff, tag, release).
