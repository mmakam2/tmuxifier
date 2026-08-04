# Phone Keyboard Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three approved phone fixes from `docs/superpowers/specs/2026-08-03-phone-keyboard-round2-design.md`: the ⏎ cap pinned on screen, a long-press tap guard for mouse-tracking apps, and a top bar that hides while the soft keyboard is open.

**Architecture:** Three independent client-side changes. (1) `touchKeys.ts` grows a `pinned` flag that routes ⏎ out of the horizontal scroller. (2) A new pure state machine `touchGesture.ts` discriminates tap/hold/drag; `terminal.ts`'s existing `wireTouchScroll` becomes `wireTouchGestures` and consumes it, so a tap never reaches a mouse-tracking app as a click but a ~500ms hold does. (3) `phoneMode.ts` gains a pure `keyboardOpen` predicate and toggles a `kb-open` class on `.layout` from its existing visualViewport handler; CSS hides `.phone-bar` under it.

**Tech Stack:** TypeScript web client (Vite), xterm.js 5 (`term.modes.mouseTrackingMode`), vitest (node environment — no DOM), Playwright (desktop + phone/Pixel 5 projects).

## Global Constraints

- ESM everywhere; web client is `.ts`, no new dependencies.
- TDD with real code, never mocks. vitest has **no DOM** (`environment: 'node'`): only pure halves get unit tests; DOM halves are e2e-covered. This split is a project convention, not a suggestion.
- e2e serves `dist/`: after ANY `src/web` edit, run `npm run build` before `npm run test:e2e`, or you are testing stale code (this has burned a session before).
- Touch e2e needs the phone project or `test.use({ hasTouch: true })` — without it `(pointer: coarse)` never matches and there is no bar.
- Constants (from the spec, ambiguities resolved): `HOLD_MS = 500`, `SLOP_PX = 10` (there is no pre-existing slop constant; 10px is the decision), `KB_OPEN_PX = 150`.
- The guard activates only while `term.modes.mouseTrackingMode !== 'none'`; tracking-off behavior must stay byte-for-byte identical to today.
- The repo is public: no real hostnames/IPs/emails in committed files or tests.
- Conventional-commit messages. Execute in a worktree (superpowers:using-git-worktrees). After the plan completes, the standing validate-on-live-before-ship workflow applies before any merge — device-found bugs are the norm for phone work (v1.24.21→23 found three).

---

### Task 1: Pin the ⏎ cap outside the scroller

**Files:**
- Modify: `src/web/touchKeys.ts` (TOUCH_KEYS at line ~9; `buildTouchKeyBar` DOM loop at ~92-124)
- Test: `test/touchKeys.test.js` (append)
- Test: `test/e2e/touchBar.spec.ts` (append inside the width loop)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TOUCH_KEYS` entries gain optional `pinned?: true`; the ⏎ button becomes a direct child of `#touch-keys` (`.touch-keys > button[aria-label="enter"]`), ordered caps-scroller → ⏎ → mic slot. `seqFor`, `createStickyCtrl`, and the `{ micSlot, syncCap }` return are unchanged.

- [ ] **Step 1: Write the failing unit test**

Append to `test/touchKeys.test.js`:

```js
test('enter is the only pinned cap — it must never ride the scroller off-screen', () => {
  for (const k of TOUCH_KEYS) {
    expect(!!k.pinned).toBe(k.id === 'enter');
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/touchKeys.test.js`
Expected: FAIL — `expect(false).toBe(true)` for the `enter` entry (no `pinned` field yet).

- [ ] **Step 3: Implement the flag and the routing**

In `src/web/touchKeys.ts`, change the catalog type and the enter entry:

```ts
export const TOUCH_KEYS: { id: TouchKey; label: string; pinned?: true }[] = [
```

```ts
  { id: 'ctrl', label: 'ctrl' },
  // Pinned outside the scroller (a direct child of the bar, like the mic):
  // ⏎ is the most-used cap — submitting to Claude, confirming prompts — and
  // as the LAST item of a ~450px strip it sat past the right edge of every
  // phone viewport, reachable only by a swipe nothing advertises.
  { id: 'enter', label: '⏎', pinned: true },
```

In `buildTouchKeyBar`, attach `caps` to the mount **before** the loop (today it is appended after), and route pinned caps to the mount:

```ts
  const caps = document.createElement('div');
  caps.className = 'touch-caps';
  mount.appendChild(caps); // before the loop: a pinned cap appended to `mount` mid-loop must land AFTER the strip
  for (const k of TOUCH_KEYS) {
    // … existing button construction unchanged …
    (k.pinned ? mount : caps).appendChild(b);
  }
```

Delete the old `mount.appendChild(caps);` line that sat after the loop. The `micSlot` append stays last, so DOM order is caps → ⏎ → mic. No CSS change is needed: `.touch-keys button` (style.css ~1830) already styles any descendant button with `flex: 0 0 auto`, and `.touch-caps`'s `min-width: 0` is what shrinks instead.

- [ ] **Step 4: Run the unit suite and typecheck**

Run: `npx vitest run test/touchKeys.test.js && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Write the failing e2e test**

Append inside the `for (const width of [360, 390, 430])` describe block in `test/e2e/touchBar.spec.ts`:

```ts
    test('the enter cap is pinned on screen, outside the scroller', async ({ page }) => {
      await openOnPhone(page);
      const enter = page.locator('.touch-keys > button[aria-label="enter"]');
      await expect(enter).toBeVisible({ timeout: 10000 });
      const box = (await enter.boundingBox())!;
      // Wholly within the viewport — the exact failure the old last-in-strip
      // position had. Geometry, not toBeVisible(): an element scrolled off
      // inside an overflow container is still "visible" to Playwright.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(36); // still a thumb target
      // Structurally out of the scroller, so no future reflow can pull it back in.
      expect(await page.locator('.touch-caps button[aria-label="enter"]').count()).toBe(0);
    });
```

- [ ] **Step 6: Build and run the e2e red-green**

Run: `npm run build && npx playwright test touchBar --project=phone`
Expected: the new test PASSES (implementation landed in Step 3) and the three existing touchBar tests still pass — the caps-overflow test in particular, since 9 caps still overflow the strip at 360px. If the new test passes without Step 3's change ever having failed it, mutation-check it: revert the `pinned` flag, rebuild, confirm the test fails, restore. (Vacuous e2e guards shipped three times on the last phone branch.)

- [ ] **Step 7: Commit**

```bash
git add src/web/touchKeys.ts test/touchKeys.test.js test/e2e/touchBar.spec.ts
git commit -m "feat(ui): pin the enter cap outside the touch bar scroller"
```

---

### Task 2: Pure tap/hold/drag gesture state machine

**Files:**
- Create: `src/web/touchGesture.ts`
- Test: `test/touchGesture.test.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (Task 3 relies on these exact names):

```ts
export const HOLD_MS = 500;
export const SLOP_PX = 10;
export type GestureAction =
  | { act: 'none' }
  | { act: 'scroll'; deltaY: number }
  | { act: 'tap' }
  | { act: 'hold-press'; x: number; y: number }
  | { act: 'hold-release'; x: number; y: number }
  | { act: 'cancelled' };
export interface TouchGesture {
  readonly holdPending: boolean;
  start(x: number, y: number, touches: number, guard: boolean): void;
  move(x: number, y: number, touches: number): GestureAction;
  timerFired(): GestureAction;
  end(): GestureAction;
  cancel(): GestureAction;
}
export function createTouchGesture(): TouchGesture;
```

- [ ] **Step 1: Write the failing tests**

Create `test/touchGesture.test.js`:

```js
import { test, expect } from 'vitest';
import { createTouchGesture, HOLD_MS, SLOP_PX } from '../src/web/touchGesture.ts';

test('guard off: scroll from the first pixel, end is inert — today\'s behavior exactly', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, false);
  expect(g.holdPending).toBe(false);
  expect(g.move(100, 197, 1)).toEqual({ act: 'scroll', deltaY: 3 });
  expect(g.move(100, 190, 1)).toEqual({ act: 'scroll', deltaY: 7 });
  expect(g.end()).toEqual({ act: 'none' });
});

test('guard on: release within slop and before the timer is a tap', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.holdPending).toBe(true);
  expect(g.move(104, 203, 1)).toEqual({ act: 'none' }); // jitter, not a drag
  expect(g.end()).toEqual({ act: 'tap' });
  expect(g.holdPending).toBe(false);
});

test('guard on: the hold timer fires a press at the START coords, release a matching mouseup', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.timerFired()).toEqual({ act: 'hold-press', x: 100, y: 200 });
  expect(g.holdPending).toBe(false);
  expect(g.end()).toEqual({ act: 'hold-release', x: 100, y: 200 });
});

test('guard on: moving past slop becomes a drag and no scroll distance is lost', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  const a = g.move(100, 200 - (SLOP_PX + 5), 1); // 15px up in one move
  expect(a).toEqual({ act: 'scroll', deltaY: SLOP_PX + 5 }); // the pre-slop travel is the first wheel
  expect(g.move(100, 180, 1)).toEqual({ act: 'scroll', deltaY: 5 });
  expect(g.end()).toEqual({ act: 'none' }); // a drag never taps
  expect(g.timerFired()).toEqual({ act: 'none' }); // a stale timer is inert
});

test('a second finger cancels a pending gesture', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.move(100, 200, 2)).toEqual({ act: 'cancelled' });
  expect(g.end()).toEqual({ act: 'none' });
});

test('multi-touch start never arms anything', () => {
  const g = createTouchGesture();
  g.start(100, 200, 2, true);
  expect(g.holdPending).toBe(false);
  expect(g.move(100, 150, 1)).toEqual({ act: 'none' });
  expect(g.end()).toEqual({ act: 'none' });
});

test('touchcancel after the press dispatched still releases the button', () => {
  // An orphaned mousedown would leave xterm believing the button is held.
  const g = createTouchGesture();
  g.start(50, 60, 1, true);
  g.timerFired();
  expect(g.cancel()).toEqual({ act: 'hold-release', x: 50, y: 60 });
});

test('moves after the hold press are ignored — a held finger drifting is not a drag', () => {
  const g = createTouchGesture();
  g.start(50, 60, 1, true);
  g.timerFired();
  expect(g.move(80, 90, 1)).toEqual({ act: 'none' });
});

test('constants match the spec', () => {
  expect(HOLD_MS).toBe(500);
  expect(SLOP_PX).toBe(10);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/touchGesture.test.js`
Expected: FAIL — cannot resolve `../src/web/touchGesture.ts`.

- [ ] **Step 3: Implement**

Create `src/web/touchGesture.ts`:

```ts
// Pure tap/hold/drag discriminator for the terminal's touch guard: the DOM
// half (wireTouchGestures, terminal.ts) feeds it touch events and a timer
// tick, and acts on what comes back. Pure so it is unit-testable — vitest has
// no DOM. `guard` is whether the app has mouse tracking on: with it OFF the
// machine reproduces the old wireTouchScroll behavior exactly (scroll from the
// first pixel, everything else inert), so plain shell prompts see zero drift.
export const HOLD_MS = 500;
export const SLOP_PX = 10;

export type GestureAction =
  | { act: 'none' }
  | { act: 'scroll'; deltaY: number }
  | { act: 'tap' }
  | { act: 'hold-press'; x: number; y: number }
  | { act: 'hold-release'; x: number; y: number }
  | { act: 'cancelled' };

export interface TouchGesture {
  readonly holdPending: boolean;
  start(x: number, y: number, touches: number, guard: boolean): void;
  move(x: number, y: number, touches: number): GestureAction;
  timerFired(): GestureAction;
  end(): GestureAction;
  cancel(): GestureAction;
}

export function createTouchGesture(): TouchGesture {
  // pending: guard on, within slop, timer not yet fired — could still become
  // any of tap/hold/drag. passive: guard off — the legacy scroll-only path.
  type Phase = 'idle' | 'pending' | 'drag' | 'hold' | 'passive';
  let phase: Phase = 'idle';
  let x0 = 0, y0 = 0, lastY = 0;
  const NONE: GestureAction = { act: 'none' };
  return {
    get holdPending() { return phase === 'pending'; },
    start(x, y, touches, guard) {
      if (touches !== 1) { phase = 'idle'; return; }
      x0 = x; y0 = y; lastY = y;
      phase = guard ? 'pending' : 'passive';
    },
    move(x, y, touches) {
      if (phase === 'idle' || phase === 'hold') return NONE;
      if (touches !== 1) {
        const was = phase;
        phase = 'idle';
        return was === 'pending' ? { act: 'cancelled' } : NONE;
      }
      if (phase === 'pending') {
        if (Math.abs(x - x0) <= SLOP_PX && Math.abs(y - y0) <= SLOP_PX) return NONE;
        phase = 'drag'; // lastY is still y0, so the pre-slop travel rides the first wheel
      }
      const deltaY = lastY - y; // finger up = positive = scroll down, wheel's sign convention
      lastY = y;
      if (deltaY === 0) return NONE;
      return { act: 'scroll', deltaY };
    },
    timerFired() {
      if (phase !== 'pending') return NONE; // stale timer — the DOM half clears, this is the backstop
      phase = 'hold';
      return { act: 'hold-press', x: x0, y: y0 };
    },
    end() {
      const was = phase;
      phase = 'idle';
      if (was === 'pending') return { act: 'tap' };
      if (was === 'hold') return { act: 'hold-release', x: x0, y: y0 };
      return NONE;
    },
    cancel() {
      const was = phase;
      phase = 'idle';
      // A dispatched mousedown must not be orphaned: xterm would believe the
      // button is still held long after the finger is gone.
      if (was === 'hold') return { act: 'hold-release', x: x0, y: y0 };
      return was === 'pending' ? { act: 'cancelled' } : NONE;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/touchGesture.test.js && npm run typecheck`
Expected: all PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/web/touchGesture.ts test/touchGesture.test.js
git commit -m "feat(ui): pure tap/hold/drag gesture machine for the terminal touch guard"
```

---

### Task 3: Wire the guard into the terminal

**Files:**
- Modify: `src/web/terminal.ts` (`wireTouchScroll` at ~219-261; its call at ~406)
- Test: `test/e2e/phone.spec.ts` (append)

**Interfaces:**
- Consumes: `createTouchGesture`, `HOLD_MS`, `GestureAction` from `src/web/touchGesture.ts` (Task 2's exact shapes).
- Produces: `wireTouchGestures(parent, deps: { guard(): boolean; focus(): void }): () => void` replaces `wireTouchScroll(parent)` — module-private, same disposer contract. `openTerminal` passes `guard: () => term.modes.mouseTrackingMode !== 'none'` and `focus: () => term.focus()`. The provision terminal stays on xterm's native touch path (it never wired this).

- [ ] **Step 1: Write the failing e2e test**

Append to `test/e2e/phone.spec.ts` (it already imports `login`, `openLocalhost` — reuse them; match the file's `cat -v` + `finally Control+C` conventions):

```ts
test('tap guard: taps are inert to a mouse-tracking app, a long-press clicks', async ({ page }) => {
  await login(page);
  const pane = await openLocalhost(page);
  try {
    // Enable mouse tracking (1002) + SGR encoding (1006) in the pane, exactly
    // as a TUI would; tmux mirrors the pane's request out to xterm, so
    // term.modes.mouseTrackingMode goes non-'none'. cat -v then renders any
    // report the shell receives visibly as ^[[<… — the pty-effect signal.
    await page.keyboard.type("printf '\\033[?1002h\\033[?1006h'; echo TRACKING''_ON; cat -v");
    await page.keyboard.press('Enter');
    await expect(pane).toContainText('TRACKING_ON', { timeout: 10000 });

    const rect = (await pane.boundingBox())!;
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);

    // A tap must deliver NO mouse report — this is the accidental-selection
    // bug. Give the round trip a beat, then assert the screen stayed clean.
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(750);
    await expect(pane).not.toContainText('[<');
    // …and the tap still focused the terminal (the guard preventDefaults the
    // browser's own focus path, so it must refocus explicitly).
    expect(await page.evaluate(() => !!document.activeElement?.closest('.stage-pane'))).toBe(true);

    // The positive control that keeps the assertion above honest: the same
    // spot held past HOLD_MS must deliver the SGR press/release pair.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(700); // > HOLD_MS
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(pane).toContainText('[<', { timeout: 10000 });
  } finally {
    // Never leave cat -v holding the shared session's tty, and never leave
    // mouse tracking on for the next spec: both outlive this page.
    await page.keyboard.press('Control+C').catch(() => {});
    await page.keyboard.type("printf '\\033[?1002l\\033[?1006l'").catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});
```

- [ ] **Step 2: Build and verify it fails for the right reason**

Run: `npm run build && npx playwright test phone -g "tap guard" --project=phone`
Expected: FAIL at `not.toContainText('[<')` — today's tap reaches xterm as a click and the report lands on screen. If it fails at `TRACKING_ON` instead, the harness is broken — fix that first, don't proceed.

- [ ] **Step 3: Implement wireTouchGestures**

In `src/web/terminal.ts`, add the import and replace `wireTouchScroll` (keep the existing block comment about synthetic wheels, and extend it):

```ts
import { createTouchGesture, HOLD_MS, type GestureAction } from './touchGesture';
```

```ts
// Touch drags become synthetic wheel events (see the original rationale below)
// — and, when the app has MOUSE TRACKING on (Claude Code fullscreen, tmux
// `mouse on`), taps become inert: xterm would forward a tap as a real SGR
// click, so a stray touch on a TUI option list selected and activated it. A
// tap now suppresses the browser's compatibility mouse events entirely and
// refocuses the terminal itself; a deliberate ~500ms hold dispatches the
// synthetic mousedown/mouseup pair so touch activation survives. With
// tracking off the gesture machine reproduces the old path exactly — plain
// prompts keep today's behavior byte-for-byte.
//
// (Original wheel rationale:) xterm's own touch path only scrolls its
// viewport, which at scrollback 0 (every box terminal — tmux owns history)
// can never consume the drag; the unconsumed touchmove then bubbled to the
// browser as pull-to-refresh. The wheel path already handles every case
// (DECCKM arrow fallback, SGR mouse when tracking is on), so drags are
// translated into the event that working path expects. Capture phase so
// xterm's dead-end touch handlers never run; multi-touch cancels, so pinch
// passes through. The provision terminal keeps xterm's native path — it has
// real scrollback.
function wireTouchGestures(parent: HTMLElement, deps: { guard(): boolean; focus(): void }): () => void {
  const g = createTouchGesture();
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let pressTarget: HTMLElement | null = null; // element under the finger at touchstart
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  const mouse = (type: 'mousedown' | 'mouseup', x: number, y: number) => {
    pressTarget?.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0,
      bubbles: true, cancelable: true,
    }));
  };
  const apply = (a: GestureAction, ev: TouchEvent) => {
    switch (a.act) {
      case 'scroll':
        clearHold();
        if (ev.cancelable) ev.preventDefault();
        ev.stopPropagation();
        (ev.target as HTMLElement | null)?.dispatchEvent(new WheelEvent('wheel', {
          deltaY: a.deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true,
        }));
        break;
      case 'tap':
        clearHold();
        // Suppress the compatibility mousedown/mouseup/click the browser would
        // synthesize — that suppression also kills its focus path, so refocus
        // explicitly to keep tap-opens-keyboard working.
        if (ev.cancelable) ev.preventDefault();
        deps.focus();
        break;
      case 'hold-press': mouse('mousedown', a.x, a.y); break;
      case 'hold-release':
        if (ev.cancelable) ev.preventDefault();
        mouse('mouseup', a.x, a.y);
        break;
      case 'cancelled': clearHold(); break;
    }
  };
  const onStart = (ev: TouchEvent) => {
    clearHold();
    const t = ev.touches.length === 1 ? ev.touches[0] : null;
    pressTarget = ev.target as HTMLElement | null;
    g.start(t?.clientX ?? 0, t?.clientY ?? 0, ev.touches.length, deps.guard());
    if (g.holdPending) holdTimer = setTimeout(() => apply(g.timerFired(), ev), HOLD_MS);
  };
  const onMove = (ev: TouchEvent) => {
    const t = ev.touches.length === 1 ? ev.touches[0] : null;
    apply(g.move(t?.clientX ?? 0, t?.clientY ?? 0, ev.touches.length), ev);
  };
  const onEnd = (ev: TouchEvent) => { apply(g.end(), ev); clearHold(); };
  const onCancel = (ev: TouchEvent) => { apply(g.cancel(), ev); clearHold(); };
  parent.addEventListener('touchstart', onStart, { capture: true, passive: true });
  parent.addEventListener('touchmove', onMove, { capture: true, passive: false });
  parent.addEventListener('touchend', onEnd, true);
  parent.addEventListener('touchcancel', onCancel, true);
  return () => {
    clearHold();
    parent.removeEventListener('touchstart', onStart, true);
    parent.removeEventListener('touchmove', onMove, true);
    parent.removeEventListener('touchend', onEnd, true);
    parent.removeEventListener('touchcancel', onCancel, true);
  };
}
```

Update the call in `openTerminal` (~line 406):

```ts
  const offTouchScroll = wireTouchGestures(parent, {
    // Read live per gesture, the same pattern as the bar's DECCKM-aware arrows.
    guard: () => term.modes.mouseTrackingMode !== 'none',
    focus: () => term.focus(),
  });
```

Notes for the implementer: `touchend`/`touchcancel` listeners are non-passive by default, so `preventDefault()` in `apply` works; the old `onEnd = () => { lastY = null; }` and the `lastY` module state are gone — the machine owns all gesture state; the disposer now also clears the hold timer (a pane disposed mid-hold must not fire a stray mousedown).

- [ ] **Step 4: Build, run the new test green, then both full e2e projects**

Run: `npm run build && npx playwright test phone -g "tap guard" --project=phone`
Expected: PASS.
Run: `npm run test:e2e`
Expected: all pass — the desktop project exercises the tracking-off path (no touch), and every other phone spec (touch scroll, key bar, ^C cap) confirms drags and caps did not regress.

- [ ] **Step 5: Run unit + typecheck**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/terminal.ts test/e2e/phone.spec.ts
git commit -m "feat(terminal): tap guard — touches never click mouse-tracking apps, long-press does"
```

---

### Task 4: Auto-hide the top bar while the keyboard is open

**Files:**
- Modify: `src/web/phoneMode.ts` (module top for the exports; `onVv` at ~83-101; `onChange` at ~109-118; `dispose` at ~150-163)
- Modify: `src/web/style.css` (inside the `@media (max-width: 720px)` block, after the `.phone-switch` rules ~1760)
- Test: `test/phoneMode.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const KB_OPEN_PX = 150` and `export function keyboardOpen(innerHeight: number, vvh: number): boolean` from `phoneMode.ts`; a `kb-open` class on `.layout` that CSS maps to `.phone-bar { display: none; }`. (`phoneMode.ts`'s top level touches no `window`, so the pure exports are importable under vitest's node environment — same pattern as `touchKeys.ts`.)

- [ ] **Step 1: Write the failing unit test**

Create `test/phoneMode.test.js`:

```js
import { test, expect } from 'vitest';
import { keyboardOpen, KB_OPEN_PX } from '../src/web/phoneMode.ts';

test('keyboardOpen: only a large layout-vs-visual delta reads as a keyboard', () => {
  expect(keyboardOpen(844, 844)).toBe(false);              // idle
  expect(keyboardOpen(844, 844 - KB_OPEN_PX)).toBe(false); // at the threshold: not yet
  expect(keyboardOpen(844, 844 - KB_OPEN_PX - 1)).toBe(true);
  expect(keyboardOpen(844, 500)).toBe(true);               // a real keyboard (~344px)
  expect(keyboardOpen(844, 800)).toBe(false);              // URL-bar-scale squeeze keeps the bar
});

test('keyboardOpen: zoom cannot read as a keyboard, because vvh is scale-corrected', () => {
  // phoneMode feeds it h = round(vv.height * vv.scale): pinch-zoomed 2x with no
  // keyboard, vv.height halves but scale doubles, so h ≈ innerHeight → closed.
  expect(keyboardOpen(844, Math.round((844 / 2) * 2))).toBe(false);
});

test('threshold matches the spec', () => {
  expect(KB_OPEN_PX).toBe(150);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/phoneMode.test.js`
Expected: FAIL — `keyboardOpen` is not exported.

- [ ] **Step 3: Implement**

In `src/web/phoneMode.ts`, above `createPhoneMode`:

```ts
// The keyboard-open predicate behind the top bar's auto-hide. iOS never
// shrinks the LAYOUT viewport for the soft keyboard (the premise --vvh already
// stands on) and current Android Chrome's default likewise resizes only the
// visual viewport — so a large innerHeight-vs-visual delta is the keyboard,
// and nothing else on a phone produces one this big. `vvh` must be the
// scale-corrected height (vv.height * vv.scale), which is what onVv already
// computes: raw vv.height would read pinch-zoom as a keyboard.
export const KB_OPEN_PX = 150;
export function keyboardOpen(innerHeight: number, vvh: number): boolean {
  return innerHeight - vvh > KB_OPEN_PX;
}
```

In `onVv`, after the `--vvh` write and `scrollTo` but **before** `deps.onViewport()` — the refit must measure the stage AFTER the bar's row is granted or revoked:

```ts
      document.documentElement.style.setProperty('--vvh', `${h}px`);
      // While the keyboard is up, terminal rows are scarcest and ☰/pane-switch
      // are unreachable behind it anyway; hiding the bar hands its row to the
      // stage. Toggled BEFORE onViewport() so the refit sees the new height.
      layout.classList.toggle('kb-open', keyboardOpen(window.innerHeight, h));
      window.scrollTo(0, 0); // iOS scrolls the focused input into view by panning the page
      deps.onViewport();
```

In `onChange`'s `!mq.matches` branch (beside the `--vvh` removal) and in `dispose()` (same line in both):

```ts
      layout.classList.remove('kb-open');
```

In `src/web/style.css`, inside the `@media (max-width: 720px)` block after `.phone-switch:disabled` (~line 1760):

```css
  /* While the soft keyboard is open (phoneMode.ts toggles kb-open off the same
     visualViewport height gate that writes --vvh), the top bar's row goes to
     the terminal — rows are scarcest exactly then, and ☰/pane-switch are not
     reachable mid-typing anyway. Closing the keyboard restores it; there is
     deliberately no other reveal gesture. */
  .layout.kb-open .phone-bar { display: none; }
```

- [ ] **Step 4: Run unit, typecheck, build, full e2e**

Run: `npm test && npm run build && npm run test:e2e`
Expected: all pass. Playwright cannot synthesize `visualViewport` height changes, so `kb-open` never toggles under e2e — the suite's job here is proving nothing regressed; the toggle itself is covered by the pure predicate plus the mandatory real-device pass before ship (spec: "Known e2e gap, stated honestly").

- [ ] **Step 5: Commit**

```bash
git add src/web/phoneMode.ts src/web/style.css test/phoneMode.test.js
git commit -m "feat(ui): hide the phone top bar while the soft keyboard is open"
```

---

### Task 5: Documentation and final verification

**Files:**
- Modify: `docs/terminal.md` (the phone-layout section, ~lines 156-200: the paragraph introducing phone mode and "**The touch key bar.**")
- Modify: `CLAUDE.md` and `AGENTS.md` (the `terminal.ts`, `touchKeys.ts`, `phoneMode.ts` entries in the web-client paragraph — keep the two files in sync)

**Interfaces:**
- Consumes: the shipped behavior of Tasks 1-4.
- Produces: living docs that describe it.

- [ ] **Step 1: Update docs/terminal.md**

In the phone section, add after the touch-key-bar paragraph (adapt to the surrounding prose style; this is the content that must land):

```markdown
The ⏎ cap and the mic are pinned at the bar's right edge and never scroll off-screen, so
you can submit a line — answer a prompt, send a message to a running agent — without
opening the soft keyboard at all.

**Touch and mouse-aware apps.** When the app in the pane takes mouse input (Claude Code's
fullscreen UI, tmux with `mouse on`), a stray tap would otherwise *click* it — selecting
and activating whatever it landed on. So while mouse tracking is active, a tap only
focuses the terminal; to deliberately tap a button or option, press and hold for about
half a second. Drag-to-scroll is unchanged. Apps that don't take mouse input see no
difference at all.

While the soft keyboard is open, the top bar (☰ and the pane switcher) hides to give its
row to the terminal; closing the keyboard brings it back.
```

- [ ] **Step 2: Update CLAUDE.md and AGENTS.md**

Apply the same edits to both files' web-client module list:

- `terminal.ts` entry: where it describes the touch path, note that `wireTouchScroll` is now `wireTouchGestures` — touch drags still become synthetic wheels, and when the pane app has mouse tracking on (`term.modes.mouseTrackingMode`, read live per gesture) a tap is suppressed-and-refocused rather than forwarded as a click, with a ~500ms hold dispatching the real mousedown/mouseup pair; the pure tap/hold/drag discriminator lives in `touchGesture.ts` (`HOLD_MS`/`SLOP_PX`), and with tracking off the machine reproduces the old path exactly.
- `touchKeys.ts` (described inside the `touchKeys.ts` portion of the web-client paragraph): the ⏎ cap carries `pinned: true` and renders as a direct child of the bar beside the mic, outside the scroller — the most-used cap must never be the one that scrolls off-screen.
- `phoneMode.ts` portion: `keyboardOpen`/`KB_OPEN_PX` (pure, exported) toggle `kb-open` on `.layout` from the same height-gated visualViewport handler that writes `--vvh`; CSS hides `.phone-bar` under it, and the class is removed on desktop flip and `dispose()` exactly like `--vvh`.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build && npm run test:e2e`
Expected: everything green. Then `git status` — no unintended files; `git diff` the docs for PII (placeholders only).

- [ ] **Step 4: Commit**

```bash
git add docs/terminal.md CLAUDE.md AGENTS.md
git commit -m "docs: phone keyboard round 2 — pinned enter, tap guard, auto-hide top bar"
```

---

## After the plan

Not tasks, but the standing workflow: build the branch's `dist/`, rsync to the live app, restart (only when no jobs are `running`), and the operator validates **on a real phone** — the tap guard against a real Claude Code session and the auto-hide against a real soft keyboard, neither of which any suite here can exercise. Only then merge and run the ship checklist (version bump, tag, release).
