# Clawd Animation Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single hop animation on the working-agent Clawd sprite with five selectable modes (Off/static, CLI star, Wiggle, Pace, Big hop) chosen from a new Settings → Appearance tab, persisted per-browser.

**Architecture:** `src/web/clawd.ts` grows into the variant module — an ordered catalog, localStorage pref helpers with injected storage, and a `buildClawdVariant(id)` DOM builder; the zero-argument `buildClawd()` keeps its signature so the three call sites (`main.ts`, `paneHeader.ts`, `dashboard.ts`) do not change. All motion is pure CSS in `style.css` (per-variant classes, no timers). A new `settingsAppearance.ts` section renders radio rows with live previews and is registered last in `settingsUi.ts`'s `SECTIONS`.

**Tech Stack:** TypeScript web client (Vite bundle), plain CSS animations, vitest (node environment — no DOM), no new dependencies.

Spec: `docs/superpowers/specs/2026-08-02-clawd-animation-picker-design.md`.

## Global Constraints

- ESM everywhere; Node 20+. Web client is TypeScript, server plain JS.
- Vitest runs `environment: 'node'` — **no DOM in tests**. Test only pure exports; DOM builders are verified live in the browser before ship.
- No new font, no new hue: the indicator stays `currentColor` glyphs rendered by the bundled mono stack.
- Pure CSS animation only — a fleet of working boxes must cost zero timers.
- `prefers-reduced-motion: reduce` must rest every variant on a static frame.
- localStorage key: `tmuxifier.clawdAnim`. Default variant id: `star`. Valid ids: `off`, `star`, `wiggle`, `pace`, `big-hop`.
- Conventional-commit messages, each ending with the trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Public repo: no real hostnames/IPs/emails in committed content.

---

### Task 1: Variant module in `clawd.ts`

**Files:**
- Modify: `src/web/clawd.ts` (currently 25 lines — full replacement below)
- Test: `test/clawd.test.js` (extend; keep the existing block-glyph test)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2–3 and existing call sites):
  - `type ClawdVariantId = 'off' | 'star' | 'wiggle' | 'pace' | 'big-hop'`
  - `CLAWD_VARIANTS: { id: ClawdVariantId; label: string; description: string }[]` (ordered: off, star, wiggle, pace, big-hop)
  - `DEFAULT_CLAWD_VARIANT: ClawdVariantId` (= `'star'`)
  - `STAR_FRAMES: string[]` (10 glyphs)
  - `normalizeClawdVariant(raw: unknown): ClawdVariantId`
  - `loadClawdVariant(storage?: Pick<Storage, 'getItem' | 'setItem'>): ClawdVariantId`
  - `saveClawdVariant(id: ClawdVariantId, storage?: Pick<Storage, 'getItem' | 'setItem'>): void`
  - `buildClawdVariant(variant: ClawdVariantId): HTMLElement`
  - `buildClawd(): HTMLElement` (unchanged signature; now = `buildClawdVariant(loadClawdVariant())`)
  - DOM contract for Task 2's CSS: root `span.clawd.clawd-v-<id>` with `aria-hidden="true"`; star variant contains ten `span.clawd-star-f` children (one per `STAR_FRAMES` entry); every other variant contains `span.clawd-body` + `span.clawd-feet`.

- [ ] **Step 1: Write the failing tests**

Append to `test/clawd.test.js` (keep the existing import and test; extend the import list):

```js
import { test, expect } from 'vitest';
import {
  CLAWD_BODY, CLAWD_FEET, CLAWD_VARIANTS, DEFAULT_CLAWD_VARIANT, STAR_FRAMES,
  loadClawdVariant, normalizeClawdVariant, saveClawdVariant,
} from '../src/web/clawd.ts';

// ... existing 'clawd frames' test stays as-is ...

// Minimal injected stand-in for localStorage — vitest is environment:'node',
// so the real one does not exist here (which the last assertion relies on).
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test('variant catalog: ordered ids, star default, labelled rows', () => {
  expect(CLAWD_VARIANTS.map((v) => v.id)).toEqual(['off', 'star', 'wiggle', 'pace', 'big-hop']);
  expect(new Set(CLAWD_VARIANTS.map((v) => v.id)).size).toBe(5);
  expect(DEFAULT_CLAWD_VARIANT).toBe('star');
  for (const v of CLAWD_VARIANTS) {
    expect(typeof v.label).toBe('string');
    expect(v.label.length).toBeGreaterThan(0);
    expect(typeof v.description).toBe('string');
    expect(v.description.length).toBeGreaterThan(0);
  }
});

test('star frames: ten single-glyph frames in a ping-pong cycle', () => {
  expect(STAR_FRAMES).toHaveLength(10);
  for (const f of STAR_FRAMES) expect(f).toHaveLength(1);
  // Ping-pong: frame i mirrors frame (10 - i) % 10, so the bloom closes back
  // the same way it opened.
  for (let i = 0; i < STAR_FRAMES.length; i++) {
    expect(STAR_FRAMES[i]).toBe(STAR_FRAMES[(STAR_FRAMES.length - i) % STAR_FRAMES.length]);
  }
});

test('pref: round-trips, and every failure path falls back to the default', () => {
  const s = memStorage();
  expect(loadClawdVariant(s)).toBe('star');            // empty storage
  saveClawdVariant('pace', s);
  expect(loadClawdVariant(s)).toBe('pace');            // round-trip
  expect(loadClawdVariant(memStorage({ 'tmuxifier.clawdAnim': 'hop' }))).toBe('star'); // unknown stored value
  expect(normalizeClawdVariant(undefined)).toBe('star');
  expect(normalizeClawdVariant(42)).toBe('star');
  expect(loadClawdVariant()).toBe('star');             // no storage at all (node has no localStorage)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/clawd.test.js`
Expected: FAIL — `CLAWD_VARIANTS` (and the other new names) are not exported.

- [ ] **Step 3: Replace `src/web/clawd.ts` with the variant module**

```ts
// Clawd: the Claude Code mascot beside WORKING agent chips (sidebar badge,
// pane chip, dashboard fleet strip). The Appearance settings tab picks one of
// five variants; the choice is a per-browser display preference (localStorage,
// the notifyPrefs pattern). Everything renders as currentColor glyphs from the
// bundled mono stack — no new hue, no new font — and all motion is pure CSS
// (.clawd-v-* in style.css); this module is just the catalog, the pref, and
// the DOM.
export type ClawdVariantId = 'off' | 'star' | 'wiggle' | 'pace' | 'big-hop';

export const CLAWD_BODY = '▐▛███▜▌';
export const CLAWD_FEET = '▘▘ ▝▝';

// The Claude Code CLI spinner, as a ping-pong glyph cycle: the star blooms
// out and closes back the way it came. One stacked span per frame; CSS delays
// make exactly one visible at a time.
export const STAR_FRAMES = ['·', '✢', '*', '✶', '✻', '✽', '✻', '✶', '*', '✢'];

export const DEFAULT_CLAWD_VARIANT: ClawdVariantId = 'star';

// Ordered: this array drives both the Appearance picker rows and the build
// switch, so the picker can never offer a variant the builder lacks.
export const CLAWD_VARIANTS: { id: ClawdVariantId; label: string; description: string }[] = [
  { id: 'off', label: 'Off — static Clawd', description: 'no motion' },
  { id: 'star', label: 'CLI star', description: 'Claude Code spinner' },
  { id: 'wiggle', label: 'Wiggle', description: 'leans on a beat' },
  { id: 'pace', label: 'Pace', description: 'shuffles side to side' },
  { id: 'big-hop', label: 'Big hop', description: 'squash-stretch jump' },
];

const KEY = 'tmuxifier.clawdAnim';

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function normalizeClawdVariant(raw: unknown): ClawdVariantId {
  return CLAWD_VARIANTS.some((v) => v.id === raw) ? (raw as ClawdVariantId) : DEFAULT_CLAWD_VARIANT;
}

export function loadClawdVariant(storage?: PrefStorage): ClawdVariantId {
  try {
    return normalizeClawdVariant((storage ?? localStorage).getItem(KEY));
  } catch {
    return DEFAULT_CLAWD_VARIANT; // private mode, or node where localStorage does not exist
  }
}

export function saveClawdVariant(id: ClawdVariantId, storage?: PrefStorage): void {
  try { (storage ?? localStorage).setItem(KEY, id); } catch { /* private mode / quota — in-memory only */ }
}

// aria-hidden: the adjacent "working" text is the accessible label; the
// sprite is decoration for sighted users only.
export function buildClawdVariant(variant: ClawdVariantId): HTMLElement {
  const root = document.createElement('span');
  root.className = `clawd clawd-v-${variant}`;
  root.setAttribute('aria-hidden', 'true');
  if (variant === 'star') {
    for (const frame of STAR_FRAMES) {
      const f = document.createElement('span');
      f.className = 'clawd-star-f';
      f.textContent = frame;
      root.append(f);
    }
    return root;
  }
  const body = document.createElement('span');
  body.className = 'clawd-body';
  body.textContent = CLAWD_BODY;
  const feet = document.createElement('span');
  feet.className = 'clawd-feet';
  feet.textContent = CLAWD_FEET;
  root.append(body, feet);
  return root;
}

export function buildClawd(): HTMLElement {
  return buildClawdVariant(loadClawdVariant());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/clawd.test.js`
Expected: PASS (all four tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean — the three call sites still compile against zero-arg `buildClawd()`.

- [ ] **Step 6: Commit**

```bash
git add src/web/clawd.ts test/clawd.test.js
git commit -m "feat(ui): clawd variant catalog, pref helpers, and variant DOM builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-variant animations in `style.css`

**Files:**
- Modify: `src/web/style.css:445-460` (the existing Clawd block: `.clawd` rule, `.clawd-body`/`.clawd-feet` animations, `@keyframes clawd-hop`/`clawd-feet`, and the reduced-motion block — replaced wholesale)

**Interfaces:**
- Consumes: Task 1's DOM contract (`.clawd.clawd-v-<id>`, `.clawd-star-f` ×10, `.clawd-body`/`.clawd-feet`).
- Produces: variant classes Task 3's previews reuse unchanged (`.clawd-v-off`, `.clawd-v-star`, `.clawd-v-wiggle`, `.clawd-v-pace`, `.clawd-v-big-hop`).

- [ ] **Step 1: Replace the Clawd CSS block**

Replace lines 445–460 of `src/web/style.css` (everything from the `/* Clawd: ... */` comment through the reduced-motion block) with:

```css
/* Clawd: the working-agent indicator, in the variant the Appearance tab
   picked (clawd-v-<id> from clawd.ts). currentColor glyphs, pure CSS — a
   fleet of working boxes costs no timers. clawd-v-off is the base rule with
   no animation attached. */
.clawd {
  display: inline-flex; flex-direction: column; align-items: center;
  font-size: 6px; line-height: 0.9; letter-spacing: normal;
  vertical-align: -2px; margin-right: 4px;
}
.clawd-body, .clawd-feet { display: block; }
/* star: the Claude Code CLI spinner — ten stacked frames, staggered delays
   showing exactly one at a time. Rest frame is the fifth (the full star). */
.clawd-v-star { display: inline-block; position: relative; width: 1.3em; height: 1.3em; font-size: 10px; vertical-align: -3px; }
.clawd-star-f { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; animation: clawd-star 1s infinite; }
@keyframes clawd-star { 0%, 9.9% { opacity: 1; } 10%, 100% { opacity: 0; } }
.clawd-star-f:nth-child(2) { animation-delay: 0.1s; }
.clawd-star-f:nth-child(3) { animation-delay: 0.2s; }
.clawd-star-f:nth-child(4) { animation-delay: 0.3s; }
.clawd-star-f:nth-child(5) { animation-delay: 0.4s; }
.clawd-star-f:nth-child(6) { animation-delay: 0.5s; }
.clawd-star-f:nth-child(7) { animation-delay: 0.6s; }
.clawd-star-f:nth-child(8) { animation-delay: 0.7s; }
.clawd-star-f:nth-child(9) { animation-delay: 0.8s; }
.clawd-star-f:nth-child(10) { animation-delay: 0.9s; }
/* wiggle: hard-cut lean left/right, pivoting at the feet */
.clawd-v-wiggle { transform-origin: 50% 100%; animation: clawd-wiggle 1.1s infinite; }
@keyframes clawd-wiggle { 0%, 49% { transform: rotate(-7deg); } 50%, 100% { transform: rotate(7deg); } }
/* pace: shuffles side to side; feet step against the travel */
.clawd-v-pace { animation: clawd-pace 1.4s infinite; }
.clawd-v-pace .clawd-feet { animation: clawd-pace-feet 0.7s infinite; }
@keyframes clawd-pace { 0%, 49% { transform: translateX(-0.4em); } 50%, 100% { transform: translateX(0.4em); } }
@keyframes clawd-pace-feet { 0%, 49% { transform: translateX(0.12em); } 50%, 100% { transform: translateX(-0.12em); } }
/* big-hop: squash-and-stretch jump; feet hide while airborne */
.clawd-v-big-hop .clawd-body { transform-origin: 50% 100%; animation: clawd-big 0.9s infinite; }
.clawd-v-big-hop .clawd-feet { animation: clawd-big-feet 0.9s infinite; }
@keyframes clawd-big {
  0% { transform: translateY(0) scaleY(0.85) scaleX(1.12); }
  30% { transform: translateY(-0.9em) scaleY(1.1) scaleX(0.92); }
  50% { transform: translateY(-1.1em) scaleY(1) scaleX(1); }
  75%, 100% { transform: translateY(0) scaleY(0.85) scaleX(1.12); }
}
@keyframes clawd-big-feet { 0%, 24% { opacity: 1; } 25%, 69% { opacity: 0; } 70%, 100% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .clawd, .clawd-body, .clawd-feet, .clawd-star-f { animation: none; }
  .clawd-star-f { opacity: 0; }
  .clawd-star-f:nth-child(5) { opacity: 1; }
}
```

Notes for the implementer:
- `@keyframes clawd-hop` and the old `@keyframes clawd-feet` must be gone afterwards (`grep -c 'clawd-hop' src/web/style.css` → 0).
- The reduced-motion block rests sprite variants on their base frame and the star on `✻` (its fifth frame) — without the `opacity` overrides every star frame would sit at `opacity: 0` and the indicator would vanish.

- [ ] **Step 2: Build and verify the bundle carries the new classes**

Run: `npm run build && grep -c 'clawd-v-star' dist/assets/*.css`
Expected: build succeeds; count ≥ 1.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS (CSS-only change; guards against accidental damage nearby).

- [ ] **Step 4: Commit**

```bash
git add src/web/style.css
git commit -m "feat(ui): per-variant clawd animations replace the single hop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Appearance settings tab

**Files:**
- Create: `src/web/settingsAppearance.ts`
- Modify: `src/web/settingsUi.ts` (import, `SettingsTab` union, `SECTIONS` entry — last)
- Modify: `src/web/style.css` (append picker-row styles near the other settings styles)

**Interfaces:**
- Consumes: `CLAWD_VARIANTS`, `buildClawdVariant`, `loadClawdVariant`, `saveClawdVariant` from `./clawd` (Task 1); `.clawd-v-*` classes (Task 2); `el` from `./dom`.
- Produces: `renderAppearanceSection(content: HTMLElement): void`; settings tab id `'appearance'`.

- [ ] **Step 1: Create `src/web/settingsAppearance.ts`**

```ts
import { el } from './dom';
import { CLAWD_VARIANTS, buildClawdVariant, loadClawdVariant, saveClawdVariant } from './clawd';

// Settings → Appearance: which animation the working-agent indicator plays.
// Per-browser (localStorage, the notifyPrefs pattern) — a display preference,
// not server state. No Save button: selecting a row persists immediately, and
// the chips pick it up on their next status repaint because every render site
// rebuilds its indicator via buildClawd().
export function renderAppearanceSection(content: HTMLElement): void {
  const current = loadClawdVariant();
  const rows = CLAWD_VARIANTS.map(({ id, label, description }) => {
    const radio = el('input', { type: 'radio', name: 'clawd-anim', value: id }) as HTMLInputElement;
    radio.checked = id === current;
    radio.onchange = () => { if (radio.checked) saveClawdVariant(id); };
    // The preview is the real builder + the real CSS classes, so it cannot
    // drift from what the chips render.
    const preview = el('span', { class: 'appearance-prev' }, [buildClawdVariant(id)]);
    return el('label', { class: 'check-field appearance-row' }, [
      radio, preview, el('span', {}, [label]), el('span', { class: 'appearance-desc' }, [description]),
    ]);
  });
  content.replaceChildren(
    el('h3', {}, ['Appearance']),
    el('div', { class: 'pve-eyebrow' }, ['Working-agent animation']),
    ...rows,
    el('p', { class: 'pve-sub' }, ['Per-browser. Applies to the sidebar badge, pane chips, and the dashboard fleet strip on their next status refresh. Reduced-motion keeps every choice still.']),
  );
}
```

- [ ] **Step 2: Register the tab in `src/web/settingsUi.ts`**

Three edits:

```ts
import { renderAppearanceSection } from './settingsAppearance';
```

```ts
export type SettingsTab = 'boxes' | 'services' | 'netbox' | 'proxmox' | 'passkeys' | 'voice' | 'notifications' | 'appearance';
```

In `SECTIONS`, after the `notifications` entry (key order builds the tab strip — Appearance is the rightmost tab):

```ts
  appearance: { label: 'Appearance', render: (content) => renderAppearanceSection(content) },
```

- [ ] **Step 3: Append picker-row styles to `src/web/style.css`**

Append beside the existing settings styles (search for `.check-field` usage context; end of file is acceptable):

```css
/* Settings → Appearance: variant rows with a live preview between the radio
   and the label. Previews reuse the real .clawd-v-* classes, slightly
   enlarged so the motion is readable at settings-modal distance. */
.appearance-row { display: flex; align-items: center; gap: 8px; }
.appearance-prev { display: inline-flex; width: 26px; justify-content: center; color: var(--amber); }
.appearance-prev .clawd { margin-right: 0; font-size: 8px; }
.appearance-prev .clawd-v-star { font-size: 13px; }
.appearance-desc { color: var(--dim); font-size: 11px; margin-left: auto; }
```

- [ ] **Step 4: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: both clean. (No new unit test: the section is a DOM layer and vitest has no DOM; its pure inputs — catalog and pref helpers — are covered by Task 1.)

- [ ] **Step 5: Commit**

```bash
git add src/web/settingsAppearance.ts src/web/settingsUi.ts src/web/style.css
git commit -m "feat(ui): appearance settings tab picks the clawd animation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/fleet-and-health.md` (the section describing working/waiting agent chips)
- Modify: `CLAUDE.md` and `AGENTS.md` (web-client module list: add `clawd.ts` and `settingsAppearance.ts`; the `settingsUi.ts` tab enumeration gains Appearance)

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–3. Produces: nothing for later tasks.

- [ ] **Step 1: Update `docs/fleet-and-health.md`**

Find the paragraph describing the working-agent chip (grep for `working`). Add a short paragraph:

> The working chip carries a small animated indicator — Clawd, the Claude Code mascot, or the Claude Code CLI's star spinner. Settings → Appearance picks between five modes (Off/static, CLI star, Wiggle, Pace, Big hop); the choice is per-browser and takes effect on the next status refresh. Waiting chips stay still on purpose: stillness plus orange means it is your turn. Reduced-motion browsers always get the static frame.

Adjust wording to fit the surrounding prose; do not duplicate anything the section already says.

- [ ] **Step 2: Update `CLAUDE.md` and `AGENTS.md`**

In the web-client module list (the long parenthetical inventory in the Architecture section), add entries in both files:

- `clawd.ts` (the working-agent indicator: variant catalog, per-browser pref under `tmuxifier.clawdAnim`, and the DOM builder — five modes, default the CLI star spinner; all motion is pure CSS `.clawd-v-*` classes)
- `settingsAppearance.ts` (the Appearance tab: radio rows with live variant previews built by the real builder, so previews cannot drift from the chips)

And extend the `settingsUi.ts` tab enumeration to end with "…and Appearance (`settingsAppearance.ts`)".

- [ ] **Step 3: Commit**

```bash
git add docs/fleet-and-health.md CLAUDE.md AGENTS.md
git commit -m "docs: clawd animation picker (appearance tab, per-browser pref)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Live validation (candidate deploy)

**Files:** none (deploy + manual verification only).

**Interfaces:** consumes the built bundle from Tasks 1–3.

Per the standing validate-on-live workflow: features are validated on the live app before they merge/ship. The service must not be restarted while any setup/provision/lifecycle/fleet/voice-install job is `running`.

- [ ] **Step 1: Fresh build and full suite**

Run: `npm test && npm run build`
Expected: suite green, `dist/` rebuilt.

- [ ] **Step 2: Check no jobs are running, then deploy the candidate bundle**

Confirm via the app (or `curl` the auth-gated job endpoints) that no setup/provision/lifecycle/fleet/voice-install job is `running`, then:

```bash
sudo systemctl restart tmuxifier
systemctl status tmuxifier --no-pager
```

(Working from the repo checkout itself, `dist/` is already the served directory; the restart is mandatory even for client-only changes — asset routes register per file at boot.)

- [ ] **Step 3: Verify a hashed asset end-to-end**

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
ASSET="$(ls dist/assets | grep -m1 '\.js$')"
curl -sk -o /dev/null -w '%{content_type} %{http_code}\n' "$BASE/assets/$ASSET"
```

Expected: a JavaScript content-type and `200` — not `text/html` (which would mean the SPA fallback swallowed it).

- [ ] **Step 4: User validates in the browser**

Ask the user to confirm, with at least one agent working:
1. Default (fresh browser or cleared key): CLI star spins on the working chip in sidebar badge, pane chip, and dashboard fleet chip.
2. Settings → Appearance shows five rows with live previews; switching to each of Wiggle/Pace/Big hop changes the chips within a poll cycle, no reload.
3. Off shows the static Clawd.
4. Waiting chips remain plain.

Ship (version bump, tag, release checklist) happens only after the user approves — that is the existing release checklist in CLAUDE.md, not part of this plan.

---

## Self-Review Notes

- Spec coverage: five modes + default (Task 1), hop removal + per-variant CSS + reduced motion (Task 2), Appearance tab with live-preview radio rows registered last (Task 3), docs (Task 4), live validation (Task 5). Per-browser persistence and zero-arg `buildClawd()` are Task 1. No gaps found.
- Type consistency: `ClawdVariantId`, `buildClawdVariant`, `renderAppearanceSection`, and the `.clawd-v-*` class names are used identically across tasks.
- The `clawd-v-big-hop` class name intentionally contains the hyphenated id; CSS selectors in Task 2 match it exactly.
