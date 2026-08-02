# Mobile Phone Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-usable Tmuxifier — drawer sidebar, one full-screen pane, touch key bar for driving Claude Code — with the desktop experience byte-identical.

**Architecture:** All phone behavior gates behind `matchMedia('(max-width: 720px)')` (CSS and JS), the breakpoint the drawers already use; the touch key bar additionally requires `(pointer: coarse)`. The stage renders only the focused pane on phone, parking the rest in the existing `.stage-parking` div (terminals stay connected). New pure modules (`touchKeys.ts`, a `phonePaneOf` helper in `stageLayout.ts`) carry the unit-testable logic; DOM wiring lives in a new `phoneMode.ts` plus small edits to `main.ts`/`terminal.ts`. Spec: `docs/superpowers/specs/2026-08-02-mobile-phone-mode-design.md`.

**Tech Stack:** TypeScript web client (Vite), xterm.js 5.x, vitest (node environment — **no DOM in unit tests**, by project convention), Playwright e2e against the sshd-backed local box.

## Global Constraints

- Desktop must not change: every new CSS rule lives inside `@media (max-width: 720px)` (key bar: `@media (max-width: 720px) and (pointer: coarse)`); JS phone paths run only when the media query matches.
- Vitest has no DOM (`environment: 'node'`): unit tests import pure functions only. DOM layers are e2e-covered.
- TDD: failing test before implementation, per task.
- Conventional-commit messages.
- The repo is public: no real hostnames/IPs in tests or docs (use `localhost`, RFC1918).
- Do not modify `tmuxifier.stageLayout` storage semantics: phone mode renders a subset, never rewrites the split tree.
- Run `npm test` (typecheck + vitest) before every commit that touches `src/web`.

---

### Task 1: `phonePaneOf` — pure pane selection for phone mode

**Files:**
- Modify: `src/web/stageLayout.ts` (add one exported function at the end)
- Test: `test/stageLayout.test.js` (append a describe block)

**Interfaces:**
- Consumes: existing `PaneNode` type (`string | SplitNode`) and `panesOf(root)` from `stageLayout.ts`.
- Produces: `phonePaneOf(root: PaneNode | null, focusedId: string | null): string | null` — the single pane phone mode shows: `focusedId` if docked in `root`, else the first pane, else `null`. Task 4 (repaintStage) and Task 5 (switcher) rely on this exact name/signature.

- [ ] **Step 1: Write the failing test** — append to `test/stageLayout.test.js`:

```js
test('phonePaneOf: empty stage yields null', () => {
  expect(phonePaneOf(null, null)).toBe(null);
  expect(phonePaneOf(null, 'a')).toBe(null);
});
test('phonePaneOf: focused pane wins when docked', () => {
  expect(phonePaneOf(row(['a', 'b']), 'b')).toBe('b');
});
test('phonePaneOf: stale or unset focus falls back to the first pane', () => {
  expect(phonePaneOf(row(['a', 'b']), 'gone')).toBe('a');
  expect(phonePaneOf(row(['a', 'b']), null)).toBe('a');
});
test('phonePaneOf: single-leaf root', () => {
  expect(phonePaneOf('a', null)).toBe('a');
});
```

The file already has a `row(children, ratios)` helper and imports from `../src/web/stageLayout.ts` — add `phonePaneOf` to that import list. Convention in this suite is `test`/`expect` from vitest (no `describe`, no node assert) — match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stageLayout.test.js`
Expected: FAIL — `phonePaneOf` is not exported.

- [ ] **Step 3: Implement** — append to `src/web/stageLayout.ts`:

```ts
// Phone mode shows exactly one pane. The focused pane if it is still docked,
// else the first pane in reading order, else nothing (dashboard). Pure so the
// live-flip (rotate across the breakpoint) is testable without DOM.
export function phonePaneOf(root: PaneNode | null, focusedId: string | null): string | null {
  const panes = panesOf(root);
  if (panes.length === 0) return null;
  return focusedId != null && panes.includes(focusedId) ? focusedId : panes[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stageLayout.test.js` — PASS. Then `npm test` (full).

- [ ] **Step 5: Commit**

```bash
git add src/web/stageLayout.ts test/stageLayout.test.js
git commit -m "feat(stage): phonePaneOf pure pane selection for phone mode"
```

---

### Task 2: `touchKeys.ts` pure half — key sequences + sticky Ctrl

**Files:**
- Create: `src/web/touchKeys.ts`
- Test: `test/touchKeys.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Task 6 depends on these exact names):
  - `type TouchKey = 'esc' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl'`
  - `TOUCH_KEYS: { id: TouchKey; label: string }[]` — display order for the bar.
  - `seqFor(key: TouchKey, appCursor: boolean): string | null` — bytes to send; `null` for `'ctrl'` (modifier, sends nothing itself). Arrows honor DECCKM: `appCursor` true → `\x1bO A/B/C/D`, false → `\x1b[ A/B/C/D`.
  - `createStickyCtrl(): { readonly armed: boolean; arm(): void; disarm(): void; transform(d: string): string }` — `transform` applies Ctrl to the next single-character input then disarms; multi-byte input (IME bursts, escape sequences) passes through and disarms.

- [ ] **Step 1: Write the failing test** — create `test/touchKeys.test.js`:

```js
import { test, expect } from 'vitest';
import { TOUCH_KEYS, seqFor, createStickyCtrl } from '../src/web/touchKeys.ts';

test('seqFor maps the plain keys', () => {
  expect(seqFor('esc', false)).toBe('\x1b');
  expect(seqFor('tab', false)).toBe('\t');
  expect(seqFor('shift-tab', false)).toBe('\x1b[Z');
  expect(seqFor('enter', false)).toBe('\r');
});

test('seqFor arrows follow cursor-keys mode (DECCKM)', () => {
  expect(seqFor('up', false)).toBe('\x1b[A');
  expect(seqFor('down', false)).toBe('\x1b[B');
  expect(seqFor('right', false)).toBe('\x1b[C');
  expect(seqFor('left', false)).toBe('\x1b[D');
  expect(seqFor('up', true)).toBe('\x1bOA');
  expect(seqFor('left', true)).toBe('\x1bOD');
});

test('seqFor: ctrl is a modifier, not a sequence', () => {
  expect(seqFor('ctrl', false)).toBe(null);
});

test('every catalog entry except ctrl resolves to bytes', () => {
  for (const k of TOUCH_KEYS) {
    if (k.id === 'ctrl') continue;
    expect(typeof seqFor(k.id, false)).toBe('string');
  }
});

test('sticky ctrl: ctrl-ifies the next single character then disarms', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.armed).toBe(true);
  expect(s.transform('c')).toBe('\x03');
  expect(s.armed).toBe(false);
  expect(s.transform('c')).toBe('c'); // disarmed: passthrough
});

test('sticky ctrl: c and C both give ^C; space gives NUL', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.transform('C')).toBe('\x03');
  s.arm();
  expect(s.transform(' ')).toBe('\x00');
});

test('sticky ctrl: non-maskable or multi-byte input passes through and disarms', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.transform('\x1b[A')).toBe('\x1b[A');
  expect(s.armed).toBe(false);
  s.arm();
  expect(s.transform('é')).toBe('é');
  expect(s.armed).toBe(false);
});

test('sticky ctrl: unarmed transform is identity', () => {
  const s = createStickyCtrl();
  expect(s.transform('x')).toBe('x');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/touchKeys.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/web/touchKeys.ts` (pure half only; the DOM bar builder is Task 6):

```ts
// Touch key bar for phone mode: the keys a soft keyboard can't type reliably
// (Esc, Tab, Shift+Tab, arrows, Ctrl) plus Enter. Pure half — sequence lookup
// and the sticky-Ctrl state machine — lives here and is unit-tested; the DOM
// builder below it is e2e-covered (vitest has no DOM by project convention).

export type TouchKey =
  | 'esc' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl';

export const TOUCH_KEYS: { id: TouchKey; label: string }[] = [
  { id: 'esc', label: 'esc' },
  { id: 'tab', label: '⇥' },
  { id: 'shift-tab', label: '⇤' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
  { id: 'ctrl', label: 'ctrl' },
  { id: 'enter', label: '⏎' },
];

// Arrows honor DECCKM (application cursor keys): tmux, vim and Claude Code's
// TUI switch the terminal into application mode, where arrows are ESC O x.
// The caller reads the live mode off xterm (term.modes.applicationCursorKeysMode).
const PLAIN: Record<string, string> = {
  esc: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', enter: '\r',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
};
const APP: Record<string, string> = {
  up: '\x1bOA', down: '\x1bOB', right: '\x1bOC', left: '\x1bOD',
};

export function seqFor(key: TouchKey, appCursor: boolean): string | null {
  if (key === 'ctrl') return null; // modifier — handled by createStickyCtrl
  if (appCursor && APP[key]) return APP[key];
  return PLAIN[key] ?? null;
}

// Sticky Ctrl: tapping the bar's ctrl key arms; the next single character —
// from the soft keyboard or wherever — is sent as its control byte, then the
// modifier disarms. Anything unmaskable (multi-byte IME bursts, escape
// sequences) passes through untouched but still disarms, so the modifier can
// never silently corrupt later input.
export function createStickyCtrl(): {
  readonly armed: boolean; arm(): void; disarm(): void; transform(d: string): string;
} {
  let armed = false;
  return {
    get armed() { return armed; },
    arm() { armed = true; },
    disarm() { armed = false; },
    transform(d: string): string {
      if (!armed) return d;
      armed = false;
      if (d === ' ') return '\x00'; // Ctrl+Space
      if (d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
      }
      return d;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/touchKeys.test.js` — PASS. Then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/web/touchKeys.ts test/touchKeys.test.js
git commit -m "feat(ui): touch key sequences and sticky-Ctrl state machine"
```

---

### Task 3: terminal handle grows `input`/`appCursor`; input transform seam; phone font bump

**Files:**
- Modify: `src/web/terminal.ts` (`openTerminal` only — not `openProvisionTerminal`)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 5–6 depend on these): `openTerminal(...)` return object gains
  - `input(d: string): void` — send bytes to the pty over the existing WebSocket (`{t:'i', d}`), no-op when the socket isn't open;
  - `appCursor(): boolean` — live `term.modes.applicationCursorKeysMode`;
  and `opts` gains `transformInput?: (d: string) => string`, applied to every `term.onData` chunk before it is sent (the sticky-Ctrl hook; key-bar `input()` calls bypass it — those bytes are already final).
- Phone legibility: when `(max-width: 720px) and (pointer: coarse)` matches at open time, the terminal opens at `clampFontSize(termFontSize + 2)`. Read via one module-level helper `phoneCoarse()` using `window.matchMedia` (guarded for absence). Size is fixed for the terminal's lifetime — a mid-session flip keeps the old size (spec accepts this).

No unit test — `terminal.ts` is a DOM module (vitest has no DOM); Task 8's e2e covers the whole path. `npm run typecheck` is the per-step check here.

- [ ] **Step 1: Add `phoneCoarse()` helper** near the top of `terminal.ts` (after the imports):

```ts
// Phone mode raises the terminal font two steps for touch legibility. Checked
// once per openTerminal call: a mid-session flip across the breakpoint keeps
// the open terminal's size (accepted in the phone-mode spec).
function phoneCoarse(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 720px) and (pointer: coarse)').matches;
}
```

- [ ] **Step 2: Wire it into `openTerminal`.** In the `new Terminal({...})` options, change `fontSize: termFontSize` to `fontSize: phoneCoarse() ? clampFontSize(termFontSize + 2) : termFontSize`. (`clampFontSize` is already imported from `./termFont`.)

- [ ] **Step 3: Extend the signature and the input path.** Change the `opts` type to:

```ts
opts?: { voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void; transformInput?: (d: string) => string },
```

Replace the existing `term.onData` line with:

```ts
  const sendInput = (d: string) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); };
  term.onData((d) => sendInput(opts?.transformInput ? opts.transformInput(d) : d));
```

And add to the returned object (keeping `focus`, `dispose`, `refit` untouched):

```ts
    input: sendInput,
    appCursor: () => term.modes.applicationCursorKeysMode,
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` then `npm test`.
Expected: clean — the new fields are additive; no caller changes yet.

- [ ] **Step 5: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(terminal): input/appCursor on the pane handle, transformInput seam, phone font bump"
```

---

### Task 4: phone shell — CSS, viewport meta, top bar DOM, drawer controller

**Files:**
- Modify: `src/web/index.html` (viewport meta only)
- Modify: `src/web/style.css` (one new phone-mode section at the end)
- Create: `src/web/phoneMode.ts`
- Modify: `src/web/main.ts` (`renderDashboard` DOM string + wiring; `teardownWorkspace`)

**Interfaces:**
- Consumes: `phonePaneOf` (Task 1) — not yet; this task is shell only.
- Produces (Task 5–7 depend on): `createPhoneMode(deps: { layout: HTMLElement; onFlip: () => void }): PhoneMode` where

```ts
export interface PhoneMode {
  matches(): boolean;            // live media-query state (max-width: 720px)
  openDrawer(): void;
  closeDrawer(): void;
  dispose(): void;               // removes listeners; teardownWorkspace calls it
}
```

`onFlip` fires whenever the media query changes state (rotate/resize across 720px). The controller also: strips `sidebar-collapsed` from `.layout` while phone mode matches and restores it from `localStorage` on flip back (the collapsed-sidebar CSS would otherwise hide the drawer's contents); closes the drawer on Escape and on activation of a box row / Host Shell / the `#home` nameplate (event delegation on the sidebar).

- [ ] **Step 1: Viewport meta.** In `src/web/index.html` replace the viewport line with:

```html
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
```

(`interactive-widget=resizes-content` makes Android Chrome resize the layout viewport when the soft keyboard opens — the `visualViewport` listener in Task 7 then mainly serves iOS. `viewport-fit=cover` unlocks safe-area insets.)

- [ ] **Step 2: Phone CSS.** Append a clearly-marked section to `src/web/style.css`:

```css
/* --- Phone mode (max-width: 720px): drawer sidebar, one full-screen pane --- */
/* Desktop is untouched: everything here lives inside the media queries. The
   phone bar exists in the DOM on desktop too but never displays. */
.phone-bar { display: none; }
.touch-keys { display: none; }
@media (max-width: 720px) {
  .layout { display: flex; flex-direction: column; height: 100dvh; padding: 0; gap: 0; }
  .phone-bar {
    display: flex; align-items: center; gap: 8px;
    padding: calc(6px + env(safe-area-inset-top)) 10px 6px; /* clear any notch (viewport-fit=cover) */
    border-bottom: 1px solid var(--border); background: var(--panel);
    flex: 0 0 auto;
  }
  .phone-menu {
    width: 40px; height: 40px; flex: 0 0 auto;
    background: none; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-size: 18px; cursor: pointer;
  }
  .phone-switch {
    flex: 1; min-width: 0; padding: 9px 10px;
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); color: var(--text); font-family: var(--face); font-size: 14px;
  }
  .phone-switch:disabled { opacity: 0.6; }
  /* Sidebar becomes a left slide-over drawer — the .fleet-panel pattern:
     transform for the slide, visibility so closed contents leave the tab
     order (WCAG 2.4.3), matching transition delay on the way out. */
  .sidebar {
    position: fixed; top: 0; left: 0; height: 100dvh; width: min(340px, 88vw);
    z-index: 60; border-radius: 0;
    transform: translateX(-100%); visibility: hidden;
    transition: transform 0.22s ease, visibility 0s linear 0.22s;
  }
  .layout.drawer-open .sidebar { transform: translateX(0); visibility: visible; transition: transform 0.22s ease; }
  #sidebar-toggle { display: none; } /* collapse is a desktop concept */
  .stage { flex: 1 1 auto; min-height: 0; border-radius: 0; }
  /* Divider drag and dock affordances are desktop gestures. */
  .stage-divider, .drop-zones, .box .dock { display: none !important; }
  /* Touch targets: box rows and dashboard tiles reach 40px minimum; the
     sparkline (64x16 on desktop) grows into a tappable strip. */
  .box { min-height: 40px; }
  .spark { padding: 4px 0; }
  .spark-svg { width: 84px; height: 20px; }
  /* iOS zooms the page when a focused input's font is under 16px; xterm's
     hidden helper textarea is exactly that. */
  .xterm-helper-textarea { font-size: 16px !important; }
  body { touch-action: manipulation; } /* kill double-tap-zoom latency on taps */
}
@media (max-width: 720px) and (pointer: coarse) {
  .touch-keys {
    display: flex; gap: 6px; padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border); background: var(--panel);
    flex: 0 0 auto; overflow-x: auto;
  }
  .touch-keys button {
    min-width: 40px; height: 40px; padding: 0 10px; flex: 0 0 auto;
    border: 1px solid var(--key-border); border-bottom-color: #101216; border-radius: 8px;
    background: var(--key-face); color: var(--muted);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    font-family: var(--face); font-size: 14px; cursor: pointer;
  }
  .touch-keys button.armed { color: var(--amber); border-color: rgba(255, 176, 0, 0.5); }
  .touch-keys .touch-mic-slot { margin-left: auto; display: flex; align-items: center; }
}
```

Also change the base `.layout` rule's `height: 100vh` to `height: 100dvh` (desktop-safe: identical where browser chrome is static).

- [ ] **Step 3: Top bar + key bar DOM.** In `main.ts`'s `renderDashboard`, inside the `app.innerHTML` template, add between `</aside>` and `<main id="stage" ...>` — a sibling of both, direct child of `.layout`:

```html
      <header class="phone-bar">
        <button id="phone-menu" class="phone-menu" type="button" title="Boxes" aria-label="Open box list">☰</button>
        <select id="phone-switch" class="phone-switch" aria-label="Switch pane" disabled></select>
      </header>
```

and after `<main id="stage" ...></main>`, still inside `.layout`:

```html
      <div class="touch-keys" id="touch-keys"></div>
```

(The flex column order phone-bar → stage → touch-keys is the phone layout; on desktop both extras are `display: none` and the `.layout` grid ignores them — verify the grid: `grid-template-columns: 320px 1fr` places children by order, so the hidden elements must not occupy cells. `display: none` elements generate no grid items, so order is safe.)

- [ ] **Step 4: Drawer controller.** Create `src/web/phoneMode.ts`:

```ts
// Phone-mode shell controller: the media-query flag, the sidebar drawer, and
// the desktop-collapse suppression. DOM-only module — e2e covered.
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';

export interface PhoneMode {
  matches(): boolean;
  openDrawer(): void;
  closeDrawer(): void;
  dispose(): void;
}

export function createPhoneMode(deps: { layout: HTMLElement; onFlip: () => void }): PhoneMode {
  const mq = window.matchMedia('(max-width: 720px)');
  const { layout } = deps;

  // The collapsed-sidebar CSS hides the box list — fatal inside a drawer. While
  // phone mode matches the class comes off; flipping back restores the stored
  // preference, so the desktop experience is untouched.
  const applyCollapse = () => {
    if (mq.matches) layout.classList.remove('sidebar-collapsed');
    else layout.classList.toggle('sidebar-collapsed', localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  };

  const closeDrawer = () => layout.classList.remove('drawer-open');
  const openDrawer = () => layout.classList.add('drawer-open');

  const onChange = () => { closeDrawer(); applyCollapse(); deps.onFlip(); };
  mq.addEventListener('change', onChange);

  const menuBtn = layout.querySelector('#phone-menu');
  const onMenu = () => layout.classList.toggle('drawer-open');
  menuBtn?.addEventListener('click', onMenu);

  // Activating anything that changes the stage closes the drawer: box rows,
  // the Host Shell, the nameplate. Delegated so rebuilt rows stay covered.
  const sidebar = layout.querySelector('.sidebar');
  const onSidebarClick = (ev: Event) => {
    if (!mq.matches) return;
    const t = ev.target as HTMLElement;
    if (t.closest('.box .name') || t.closest('.local-name') || t.closest('#home')) closeDrawer();
  };
  sidebar?.addEventListener('click', onSidebarClick);

  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && layout.classList.contains('drawer-open')) closeDrawer(); };
  document.addEventListener('keydown', onKey);

  applyCollapse();
  return {
    matches: () => mq.matches,
    openDrawer,
    closeDrawer,
    dispose: () => {
      mq.removeEventListener('change', onChange);
      menuBtn?.removeEventListener('click', onMenu);
      sidebar?.removeEventListener('click', onSidebarClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
```

- [ ] **Step 5: Wire into `main.ts`.** After the `app.innerHTML = ...` assignment and before `repaintStage()` in `renderDashboard`: create the controller and store it in a module-level `let phoneCtl: PhoneMode | null = null`:

```ts
  phoneCtl?.dispose();
  phoneCtl = createPhoneMode({
    layout: app.querySelector('.layout') as HTMLElement,
    onFlip: () => repaintStage(),
  });
```

Import `createPhoneMode, type PhoneMode` from `./phoneMode`. In `teardownWorkspace` (read the function first — it clears pollers around `main.ts:3119`), add `phoneCtl?.dispose(); phoneCtl = null;`.

Note the interplay with the existing `#sidebar-toggle` handler: it writes `sidebar-collapsed` to both the class list and `localStorage`. On phone the button is `display: none`, so it cannot fire; `applyCollapse()` on flip restores from `localStorage`. No change to the toggle handler.

- [ ] **Step 6: Verify**

Run: `npm test` (typecheck catches wiring errors). Then `npm run build` — must succeed.
Manual sanity (optional but cheap): `npm run dev`, devtools responsive mode at 390px — drawer opens/closes, desktop at 1280px unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/web/index.html src/web/style.css src/web/phoneMode.ts src/web/main.ts
git commit -m "feat(ui): phone shell — drawer sidebar, top bar, phone-mode CSS"
```

---

### Task 5: single-pane stage on phone + pane switcher

**Files:**
- Modify: `src/web/main.ts` (`repaintStage`, plus a small `syncPhoneSwitch` helper)

**Interfaces:**
- Consumes: `phonePaneOf` (Task 1), `phoneCtl.matches()` (Task 4), `renderStagePanes(grid, root, focusedId, hooks)` (existing, `stagePanes.ts:216`).
- Produces: phone repaint behavior Tasks 6–8 build on. No new exports.

- [ ] **Step 1: Phone branch in `repaintStage`.** In `main.ts`'s `repaintStage` (`main.ts:852`), the current else-branch calls `renderStagePanes(grid, stageRoot, focusedBoxId, paneHooks())`. Replace that call with:

```ts
    stopDashPolling();
    if (phoneCtl?.matches()) {
      // Phone: one pane, full screen. The split tree in stageRoot (and its
      // persisted form) is untouched — this renders a one-leaf view of it.
      const pid = phonePaneOf(stageRoot, focusedBoxId)!; // non-null: stageRoot != null here
      focusedBoxId = pid;
      renderStagePanes(grid, pid, pid, paneHooks());
    } else {
      renderStagePanes(grid, stageRoot, focusedBoxId, paneHooks());
    }
```

Import `phonePaneOf` alongside the existing `stageLayout` imports. Note `persistStage()` later in `repaintStage` serializes `stageRoot`, which this branch never reassigns — the desktop split survives phone sessions.

- [ ] **Step 2: Pane switcher.** Add a helper beside `repaintStage` and call it at the end of `repaintStage` (after `filterAndPaint()`):

```ts
// Top-bar pane switcher: lists every docked pane; disabled when there is
// nothing to switch. Desktop never sees it (CSS hides the bar).
function syncPhoneSwitch() {
  const sel = app.querySelector('#phone-switch') as HTMLSelectElement | null;
  if (!sel) return;
  const panes = panesOf(stageRoot);
  sel.replaceChildren(...panes.map((id) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id === '__local__' ? 'Host Shell' : (allBoxes.find((b) => b.id === id)?.label ?? id);
    return o;
  }));
  sel.disabled = panes.length < 2;
  if (focusedBoxId) sel.value = focusedBoxId;
}
```

Wire its `change` event once in `renderDashboard` (near the other listener wiring):

```ts
  (app.querySelector('#phone-switch') as HTMLSelectElement).addEventListener('change', (ev) => {
    focusedBoxId = (ev.target as HTMLSelectElement).value;
    repaintStage();
  });
```

When `panes.length === 0` (dashboard) the select is empty and disabled — that is the correct standby reading.

- [ ] **Step 3: Verify**

Run: `npm test`, `npm run build`.
Manual: dev server, responsive 390px — dock two boxes at desktop width first, shrink: one pane shows, switcher lists both, switching swaps without terminal reconnect banners (parking keeps them connected). Widen: split restored.

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(stage): phone mode renders the focused pane full-screen with a top-bar switcher"
```

---

### Task 6: touch key bar wiring

**Files:**
- Modify: `src/web/touchKeys.ts` (add the DOM builder to the module from Task 2)
- Modify: `src/web/main.ts` (build the bar, route sends, adopt the mic, sticky-Ctrl transform)

**Interfaces:**
- Consumes: `TOUCH_KEYS`, `seqFor`, `createStickyCtrl` (Task 2); `tabs` map entries' `term.input(d)` / `term.appCursor()` (Task 3); `#touch-keys` mount (Task 4).
- Produces: `buildTouchKeyBar(mount: HTMLElement, deps: { send(d: string): void; appCursor(): boolean; sticky: ReturnType<typeof createStickyCtrl> }): { micSlot: HTMLElement }`.

- [ ] **Step 1: DOM builder.** Append to `src/web/touchKeys.ts`:

```ts
// DOM half. pointerdown + preventDefault is load-bearing: a normal click would
// move focus off xterm's hidden textarea and close the soft keyboard on every
// key press. e2e-covered (vitest has no DOM).
export function buildTouchKeyBar(
  mount: HTMLElement,
  deps: { send(d: string): void; appCursor(): boolean; sticky: ReturnType<typeof createStickyCtrl> },
): { micSlot: HTMLElement } {
  let ctrlBtn: HTMLButtonElement | null = null;
  const paint = () => ctrlBtn?.classList.toggle('armed', deps.sticky.armed);
  for (const k of TOUCH_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k.label;
    b.setAttribute('aria-label', k.id);
    if (k.id === 'ctrl') { ctrlBtn = b; b.setAttribute('aria-pressed', 'false'); }
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); // keep focus (and the soft keyboard) on the terminal
      if (k.id === 'ctrl') {
        if (deps.sticky.armed) deps.sticky.disarm(); else deps.sticky.arm();
        b.setAttribute('aria-pressed', String(deps.sticky.armed));
        paint();
        return;
      }
      if (deps.sticky.armed) { deps.sticky.disarm(); paint(); } // bar keys are never ctrl-modified
      const seq = seqFor(k.id, deps.appCursor());
      if (seq) deps.send(seq);
    });
    mount.appendChild(b);
  }
  const micSlot = document.createElement('span');
  micSlot.className = 'touch-mic-slot';
  mount.appendChild(micSlot);
  // The soft keyboard's own input flows through transformInput → sticky.transform,
  // which disarms on use; repaint the cap on the next tick after any send.
  const observer = () => paint();
  mount.addEventListener('pointerup', observer);
  return { micSlot };
}
```

- [ ] **Step 2: Wire in `main.ts`.** Module level: `const stickyCtrl = createStickyCtrl();` and `let touchMicSlot: HTMLElement | null = null;`. In `renderDashboard`, after the phone controller creation:

```ts
  const keyMount = app.querySelector('#touch-keys') as HTMLElement;
  const bar = buildTouchKeyBar(keyMount, {
    send: (d) => { if (focusedBoxId) tabs.get(focusedBoxId)?.term.input(d); },
    appCursor: () => (focusedBoxId ? tabs.get(focusedBoxId)?.term.appCursor() ?? false : false),
    sticky: stickyCtrl,
  });
  touchMicSlot = bar.micSlot;
```

- [ ] **Step 3: Sticky Ctrl transform on every terminal.** In `ensureTab` (`main.ts:699`), pass the transform so a soft-keyboard character typed after arming Ctrl is masked:

```ts
  const term = openTerminal(el, id, id === '__local__' ? 'local shell' : box?.label, {
    voiceMount,
    onConnState: (s) => { connStates.set(id, s); updatePaneHeaders(); },
    transformInput: (d) => stickyCtrl.transform(d),
  });
```

(One shared sticky state across panes is correct — there is one key bar and one focused pane.)

- [ ] **Step 4: Mic adoption on phone.** At the end of `repaintStage`'s phone branch (Task 5), after `renderStagePanes(...)`, move the focused tab's voice mount into the key bar so the mic is thumb-reachable:

```ts
      if (touchMicSlot) { const vm = tabs.get(pid)?.voiceMount; if (vm) touchMicSlot.append(vm); }
```

On desktop repaints `headerFor` re-adopts the mount into the pane header (existing behavior, `main.ts:805`) — the element simply moves back.

- [ ] **Step 5: Verify**

Run: `npm test`, `npm run build`.
Manual (devtools responsive + touch simulation): at a shell prompt run `cat -v`, tap esc → `^[` appears; tap ctrl then type `c` → `^C` and `cat` exits; arrows in `claude` move the menu selection.

- [ ] **Step 6: Commit**

```bash
git add src/web/touchKeys.ts src/web/main.ts
git commit -m "feat(ui): touch key bar — esc/tab/arrows/sticky-ctrl/enter + thumb mic"
```

---

### Task 7: soft-keyboard geometry — visualViewport refit

**Files:**
- Modify: `src/web/phoneMode.ts`
- Modify: `src/web/main.ts` (pass a refit callback)

**Interfaces:**
- Consumes: `refitActiveTerminals()` (existing module-local in `main.ts` — passed in as a callback).
- Produces: `createPhoneMode` deps gain `onViewport: () => void`; the controller keeps `--vvh` (visual viewport height) up to date on `document.documentElement` while phone mode matches.

- [ ] **Step 1: CSS.** In the phone media query (Task 4's block), change the `.layout` height line to:

```css
  .layout { display: flex; flex-direction: column; height: var(--vvh, 100dvh); padding: 0; gap: 0; }
```

- [ ] **Step 2: Listener.** In `createPhoneMode`, add (debounced ~50ms, both `resize` and `scroll` — iOS fires either alone):

```ts
  // iOS Safari does not shrink the layout viewport for the soft keyboard; the
  // visual viewport is the truth. Track it into --vvh so the flex column (bar,
  // stage, key bar) always fits above the keyboard, then refit the terminal.
  let vvTimer: ReturnType<typeof setTimeout> | undefined;
  const vv = window.visualViewport;
  const onVv = () => {
    if (!mq.matches || !vv) return;
    clearTimeout(vvTimer);
    vvTimer = setTimeout(() => {
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      window.scrollTo(0, 0); // iOS scrolls the focused input into view by panning the page
      deps.onViewport();
    }, 50);
  };
  vv?.addEventListener('resize', onVv);
  vv?.addEventListener('scroll', onVv);
```

Clear the property when the query flips off (in `onChange`): `document.documentElement.style.removeProperty('--vvh');` — and remove both listeners plus `clearTimeout(vvTimer)` in `dispose()`.

- [ ] **Step 3: Wire.** In `main.ts`, pass `onViewport: () => refitActiveTerminals()` in the `createPhoneMode` call.

- [ ] **Step 4: Verify**

Run: `npm test`, `npm run build`. Real-phone check happens at live validation (ship workflow); devtools cannot emulate visualViewport keyboard squeeze.

- [ ] **Step 5: Commit**

```bash
git add src/web/phoneMode.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): visualViewport-driven refit keeps the prompt above the soft keyboard"
```

---

### Task 8: phone e2e project + spec

**Files:**
- Modify: `playwright.config.ts`
- Create: `test/e2e/phone.spec.ts`

**Interfaces:**
- Consumes: the running e2e stack (`global-setup.js` spins the server on `127.0.0.1:7438` with password `e2e` and an sshd-backed `localhost` box — see existing specs for the login helper pattern).
- Produces: CI-runnable phone coverage.

- [ ] **Step 1: Projects.** Replace the flat config with two projects (Pixel 5 is Chromium-based — no new browser install):

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './test/e2e/global-setup.js',
  use: {
    baseURL: 'http://127.0.0.1:7438',
  },
  projects: [
    { name: 'desktop', testIgnore: /phone\.spec\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 5'] }, testMatch: /phone\.spec\.ts/ },
  ],
});
```

Run the full desktop suite (`npm run test:e2e`) after this change alone — it must stay green (same tests, now under the `desktop` project).

- [ ] **Step 2: Spec.** Create `test/e2e/phone.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// Phone mode: drawer shell, single-pane stage, touch key bar. Runs under the
// Pixel 5 device profile (see playwright.config.ts) — 393px wide, touch on.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('#phone-menu')).toBeVisible({ timeout: 10000 });
}

async function openLocalhost(page) {
  await page.click('#phone-menu');
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.layout')).not.toHaveClass(/drawer-open/);
  const pane = page.locator('.stage-pane');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  return pane;
}

test('drawer opens, box opens one full pane, drawer closes on pick', async ({ page }) => {
  await login(page);
  await expect(page.locator('.phone-bar')).toBeVisible();
  await page.click('#phone-menu');
  await expect(page.locator('.layout')).toHaveClass(/drawer-open/);
  await openLocalhost(page);
});

test('a desktop split renders as ONE pane; switcher swaps without reconnecting', async ({ page }) => {
  // Seed a two-pane split the way desktop would have persisted it.
  await page.addInitScript(() => {
    localStorage.setItem('tmuxifier.stageLayout', JSON.stringify({
      v: 2, focused: 'b-localhost',
      root: { o: 'row', c: ['b-localhost', 'b-db-primary'], r: [0.5, 0.5] },
    }));
  });
  await login(page);
  // NOTE: box ids are minted at import; read the two real ids from the app
  // instead of hardcoding: adapt the seed above by querying /api/boxes first
  // via page.request and writing the ids it returns (see Step 3 note below).
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const sw = page.locator('#phone-switch');
  await expect(sw).toBeEnabled();
  const first = await sw.inputValue();
  await sw.selectOption({ index: 1 });
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await sw.selectOption(first);
  // The localhost pane must NOT show a fresh "[connecting …]" banner — parking
  // kept it attached. Assert the prompt is still there immediately.
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 5000 });
});

test('key bar: esc reaches the pty, sticky ctrl+c interrupts', async ({ page }) => {
  await login(page);
  const pane = await openLocalhost(page);
  // cat -v echoes control bytes visibly: tap esc → ^[
  await pane.click();
  await page.keyboard.type('cat -v');
  await page.keyboard.press('Enter');
  await page.locator('.touch-keys button[aria-label="esc"]').dispatchEvent('pointerdown');
  await page.keyboard.press('Enter');
  await expect(pane).toContainText('^[', { timeout: 10000 });
  // sticky ctrl then soft-keyboard c → SIGINT ends cat, prompt returns
  await page.locator('.touch-keys button[aria-label="ctrl"]').dispatchEvent('pointerdown');
  await expect(page.locator('.touch-keys button[aria-label="ctrl"]')).toHaveClass(/armed/);
  await page.keyboard.type('c');
  await page.keyboard.type('echo PHONE_E2E_DONE');
  await page.keyboard.press('Enter');
  await expect(pane).toContainText('PHONE_E2E_DONE', { timeout: 10000 });
});

test('desktop project untouched: phone chrome invisible at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.phone-bar')).toBeHidden();
  await expect(page.locator('#touch-keys')).toBeHidden();
});
```

- [ ] **Step 3: Fix the split-seed test against reality.** Run the suite once; the seeded-layout test will likely fail because box ids are minted server-side at import (check `test/e2e/global-setup.js` and `serialize()` in `stageLayout.ts` for the actual persisted shape — read them, do not guess). Rework the seed to fetch `/api/boxes` with `page.request.get` after login, then write the layout via `page.evaluate` and `page.reload()`. The assertion halves stay as written.

- [ ] **Step 4: Run**

Run: `npm run build && npm run test:e2e`
Expected: desktop project all green (unchanged tests), phone project green.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts test/e2e/phone.spec.ts
git commit -m "test(e2e): phone project — drawer, single-pane stage, touch key bar"
```

---

### Task 9: docs

**Files:**
- Modify: `docs/terminal.md` (phone section: shell, key bar, sticky ctrl, mic placement)
- Modify: `docs/dashboard.md` (one paragraph: phone drawer + top bar)
- Modify: `CLAUDE.md` and `AGENTS.md` (architecture list: `phoneMode.ts`, `touchKeys.ts`, `phonePaneOf`; keep the two files in sync)

**Interfaces:** none — prose only. These are living docs (maintained with the code), unlike the spec/plan records.

- [ ] **Step 1: Write the docs.** Cover: what phone mode is (≤720px), that desktop is untouched, the one-pane stage + switcher, the key bar (and that arrows follow application-cursor mode), sticky Ctrl semantics, the mic moving to the key bar, `100dvh`/visualViewport behavior, and the deferred items (Web Push/PWA) with a pointer to the spec.

- [ ] **Step 2: Verify claims against code.** Every statement must match the shipped behavior (breakpoint value, key list, storage untouched).

- [ ] **Step 3: Commit**

```bash
git add docs/terminal.md docs/dashboard.md CLAUDE.md AGENTS.md
git commit -m "docs: phone mode — shell, touch key bar, single-pane stage"
```

---

## Final verification (before the ship workflow)

- [ ] `npm test` — typecheck + full vitest suite green.
- [ ] `npm run test:e2e` — both projects green.
- [ ] Live validation per CLAUDE.md shipping flow: build, rsync `dist/` to the live app, restart (only when no jobs running), then a **real phone** pass — drawer, key bar under the actual soft keyboard, voice mic, rotation flip — before merge/release. (The visualViewport path cannot be fully trusted from emulation.)
