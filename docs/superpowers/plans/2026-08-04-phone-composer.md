# Phone Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat-style composer for phone mode — a ✏️ button in the phone top bar swaps the touch key bar's cap strip for a native textarea + ➤ Send (an in-bar ✏️, shown only while composing, closes it); Send transmits the collapsed draft plus Enter; the mic dictates into the draft while composing.

**Placement note (approved amendment):** the ✏️ is NOT a pinned cap in the idle key bar — a 40px cap + gap needs ~45px and the 344px bar has ~10px slack, and the round-2 no-scroll invariant (caps fire on pointerdown) is pinned by `touchBar.spec.ts`. The opener lives in the phone top bar; the key bar's compose cap is display-gated to `.composing` and acts as the closer, where there is room because the caps are hidden.

**Architecture:** New `src/web/composer.ts` (pure `sendTextOf` + DOM row builder), integrated by `buildTouchKeyBar` (`touchKeys.ts`), wired in `main.ts`. Voice reroutes through a `sink` seam on `VoiceHost` (`voiceUi.ts`), backed by a new `inject=off` flag on `POST /api/voice` (`server.js`). Spec: `docs/superpowers/specs/2026-08-04-phone-composer-design.md`.

**Tech Stack:** TypeScript web client (Vite, xterm.js), plain-JS Fastify server, vitest (node environment — **no DOM in unit tests**), Playwright e2e.

## Global Constraints

- ESM everywhere; Node 20+. Server is `.js`, web client is `.ts`.
- TDD with real code, not mocks (dependency-injection factories).
- vitest has no DOM: DOM layers are e2e-covered by design; pure halves are unit-tested.
- **e2e needs a fresh build**: run `npm run build` after any `src/web` edit before `npm run test:e2e` or a spec rerun — the server serves `dist/`.
- Conventional-commit messages (`feat(composer): …`).
- Public repo: placeholders only, no real hostnames/IPs/emails in committed files.
- Work in an isolated worktree (superpowers:using-git-worktrees) branched from `main`.
- Full verification gate per task: `npm test` runs typecheck + all unit/integration tests.

---

### Task 1: `sendTextOf` — the pure Send normalization

**Files:**
- Create: `src/web/composer.ts`
- Test: `test/composer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sendTextOf(draft: string): string` — whitespace runs (incl. newlines/tabs) collapse to single spaces, remaining C0/C1 control chars stripped, trimmed. Task 4's Send button transmits `sendTextOf(field.value) + '\r'`.

- [ ] **Step 1: Write the failing test**

```js
// test/composer.test.js
import { test, expect } from 'vitest';
import { sendTextOf } from '../src/web/composer';

// A raw newline reaching the pty IS Enter — it would submit mid-text. The
// composer collapses instead, the same rule voiceText.js applies server-side
// to transcripts, because Send means "one message, one Enter".
test('newline runs collapse to single spaces', () => {
  expect(sendTextOf('fix the login bug\nthen run the tests')).toBe('fix the login bug then run the tests');
  expect(sendTextOf('a\r\n\r\nb')).toBe('a b');
});

test('tabs and space runs collapse too — a tab at a shell prompt triggers completion', () => {
  expect(sendTextOf('a\t\tb   c')).toBe('a b c');
});

test('non-whitespace control characters are stripped', () => {
  // ESC survives \s-collapse (it is not whitespace); left in, a pasted
  // artefact could open an escape sequence in the pane.
  expect(sendTextOf('a\u001bb')).toBe('ab');
  expect(sendTextOf('a\u007fb')).toBe('ab');
});

test('trims, and an empty or whitespace-only draft normalizes to empty (bare-Enter send)', () => {
  expect(sendTextOf('  hi  ')).toBe('hi');
  expect(sendTextOf('')).toBe('');
  expect(sendTextOf(' \n \t ')).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/composer.test.js`
Expected: FAIL — `Cannot find module '../src/web/composer'` (or missing export).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/web/composer.ts
// Phone composer: type in a real native field (where the IME can word-replace,
// autocorrect and cursor-edit freely — the pty sees nothing until Send), then
// one tap transmits the text plus Enter. Pure half here is unit-tested; the
// DOM row builder added in a later task is e2e-covered (vitest has no DOM).

// Collapse first, then strip: a raw newline reaching the pty IS Enter (it
// would submit mid-text), and a tab would trigger shell completion — both are
// \s, so they fold to spaces. What survives the fold (ESC, DEL, C1) is
// stripped so a pasted artefact can never open an escape sequence in the pane.
// Same posture as voiceText.js's transcript normalization.
export function sendTextOf(draft: string): string {
  return draft
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/composer.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add test/composer.test.js src/web/composer.ts
git commit -m "feat(composer): sendTextOf — collapse newlines, strip controls"
```

---

### Task 2: `POST /api/voice` gains `inject=off`

**Files:**
- Modify: `src/server/server.js` (the `/api/voice` route, around line 1479 — right after `const text = normalizeTranscript(raw);` and its empty-text early return)
- Test: `test/voiceRoutes.test.js`

**Interfaces:**
- Consumes: the existing route (transcribe → normalize → inject → `{ text, injected, mode }`).
- Produces: `POST /api/voice?box=<id>&inject=off` → `{ text, injected: false, mode: 'off' }`, **never** calling `boxActions.injectText`/`injectLocalText`. Task 3's client sends this flag whenever a composer sink is active.

- [ ] **Step 1: Write the failing test**

Append to `test/voiceRoutes.test.js` (the file's `makeApp` fake engine returns `'hello\nworld'`, which `normalizeTranscript` folds to `'hello world'`; the module-level `injected` array records every `injectText` call):

```js
test('inject=off returns the transcript without touching the pane', async () => {
  const cookie = await login();
  const res = await post(app, cookie, wav(), '/api/voice?box=b1&inject=off');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ text: 'hello world', injected: false, mode: 'off' });
  expect(injected).toEqual([]); // the composer path must never type into the pane
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceRoutes.test.js`
Expected: the new test FAILS — `injected` equals `['hello world']` and `mode` is `'claude'` (the route injected anyway).

- [ ] **Step 3: Implement**

In `src/server/server.js`, the `/api/voice` handler currently reads:

```js
    const text = normalizeTranscript(raw);
    if (!text) return { text: '', injected: false, mode: 'empty' };

    const session = box ? box.sessionName : localSession;
```

Insert between the empty-text return and the `session` line:

```js
    // Composer dictation (`inject=off`): the browser edits the transcript in
    // a native field and sends it itself — nothing may touch the pane here.
    if (String(req.query?.inject || '') === 'off') {
      return { text, injected: false, mode: 'off' };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voiceRoutes.test.js`
Expected: PASS — all existing tests plus the new one.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/voiceRoutes.test.js
git commit -m "feat(voice): inject=off returns the transcript without pane injection"
```

---

### Task 3: transcript sink — `postVoice` opts and the `VoiceHost.sink` seam

**Files:**
- Modify: `src/web/api.ts:300-305` (`postVoice`)
- Modify: `src/web/voiceUi.ts` (`VoiceHost` interface ~line 126, `finish()` in `createVoiceController` ~line 190)
- Modify: `src/web/terminal.ts:444` (opts type) and `:477-486` (the `wireVoice` host)
- Test: `test/voiceUi.test.js`

**Interfaces:**
- Consumes: Task 2's `inject=off` route behavior.
- Produces:
  - `api.postVoice(boxId: string, blob: Blob, opts?: { inject?: boolean })` — `opts.inject === false` appends `&inject=off`.
  - `VoiceHost.sink?(): ((text: string) => void) | null` — evaluated at finish-time; when non-null, the transcript goes to the sink, no clipboard fallback, **no** terminal refocus.
  - `openTerminal(parent, boxId, label, opts)` accepts `voiceSink?: () => ((text: string) => void) | null`, passed to `wireVoice`'s host as `sink`. Task 5 supplies it from `main.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/voiceUi.test.js` (its `afterEach` already restores `globalThis.fetch`; `createVoiceController`'s 4th param is the fake-recorder factory — same shape as the file's existing `rec` objects; `begin()`/`finish()` run without `mount()`, whose `setState` guards on a null button):

```js
test('a present sink reroutes the transcript into it with inject=off and leaves focus alone', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi there', injected: false, mode: 'off' }) };
  };
  const rec = {
    start: async () => {},
    stop: async () => new ArrayBuffer(45), // one byte past the 44-byte WAV header — reaches the server call
    cancel() {},
    recording: () => true,
  };
  const sunk = [];
  const controller = createVoiceController('box1', 120, {
    write() {},
    copy() { throw new Error('the sink path must not fall back to the clipboard'); },
    focus() { throw new Error('the sink path must leave focus on the composer field'); },
    sink: () => (t) => sunk.push(t),
  }, () => rec);
  await controller.begin();
  await controller.finish();
  expect(urls[0]).toContain('inject=off');
  expect(sunk).toEqual(['hi there']);
});

test('without a sink, finish() still refocuses the terminal (the pre-composer contract)', async () => {
  globalThis.fetch = async () => (
    { ok: true, status: 200, statusText: 'OK', json: async () => ({ text: 'hi', injected: true, mode: 'claude' }) });
  const rec = { start: async () => {}, stop: async () => new ArrayBuffer(45), cancel() {}, recording: () => true };
  let focused = 0;
  const controller = createVoiceController('box1', 120,
    { write() {}, copy() {}, focus() { focused++; } }, () => rec);
  await controller.begin();
  await controller.finish();
  expect(focused).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npx vitest run test/voiceUi.test.js`
Expected: the sink test FAILS (`urls[0]` lacks `inject=off`, `sunk` empty — today's code injects server-side and calls `host.focus()`, tripping the throw). The no-sink test may already pass; keep it as the regression guard.

- [ ] **Step 3: Implement**

`src/web/api.ts` — replace `postVoice`:

```ts
  async postVoice(boxId: string, blob: Blob, opts?: { inject?: boolean }) {
    const q = opts?.inject === false ? '&inject=off' : '';
    return j<{ text: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' | 'empty' | 'off' }>(
      await fetch(`/api/voice?box=${encodeURIComponent(boxId)}${q}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
      }));
  },
```

`src/web/voiceUi.ts` — extend `VoiceHost`:

```ts
export interface VoiceHost {
  write(text: string): void;      // echo status into the terminal
  copy(text: string): void;       // clipboard fallback when a pane is busy
  focus(): void;                  // return keyboard focus to the terminal
  // Present while the phone composer is open: finish() reroutes the transcript
  // here (inject=off server-side) instead of typing it into the pane, and
  // skips the terminal refocus — the composer field is holding focus so the
  // soft keyboard stays up for the edit-then-Send loop.
  sink?(): ((text: string) => void) | null;
}
```

In `finish()`, bind the sink before the round trip and branch on it. After `setState('working');` add:

```ts
    // Bound at finish-time, not delivery-time: if the composer closes during
    // the transcription round trip, the text still lands in the (hidden,
    // persistent) draft it was dictated for, not suddenly in the pane.
    const sink = host.sink?.() ?? null;
```

Replace the response-handling block

```ts
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }));
      if (!res.text) {
```

with:

```ts
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }), sink ? { inject: false } : undefined);
      if (sink) {
        if (res.text) sink(res.text);
        else host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.text) {
```

(the existing `!res.injected` branch and its comment stay as the next `else if`, unchanged). In the `finally` block, replace `host.focus();` with:

```ts
      // Sink path: focus must STAY on the composer field — refocusing the
      // terminal would close the soft keyboard mid-composition. The mic's own
      // pointerdown preventDefault() already kept the field focused.
      if (!sink) host.focus();
```

`src/web/terminal.ts` — line 444, extend the opts type:

```ts
  opts?: {
    voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void; transformInput?: (d: string) => string;
    voiceSink?: () => ((text: string) => void) | null;
  },
```

and in the `wireVoice(...)` host object (line ~477), add after `focus: () => term.focus(),`:

```ts
    sink: opts?.voiceSink,
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/voiceUi.test.js && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/voiceUi.ts src/web/terminal.ts test/voiceUi.test.js
git commit -m "feat(voice): transcript sink seam — dictation can land in the composer"
```

---

### Task 4: composer row DOM + ✏️ cap + bar integration + CSS

**Files:**
- Modify: `src/web/composer.ts` (add the DOM half)
- Modify: `src/web/touchKeys.ts` (catalog entry, `seqFor` guard, `buildTouchKeyBar`)
- Modify: `src/web/style.css` (inside the existing `@media (max-width: 720px) and (pointer: coarse)` block, after the `.touch-mic-slot` rules ~line 1870)
- Test: `test/touchKeys.test.js`

**Interfaces:**
- Consumes: Task 1's `sendTextOf`.
- Produces:
  - `buildComposerRow(deps: { send(d: string): boolean; onGrow?(): void }): { el: HTMLElement; field: HTMLTextAreaElement; appendDraft(text: string): void }` (composer.ts).
  - `buildTouchKeyBar(mount, deps)` where `deps` becomes `{ send(d: string): boolean; appCursor(): boolean; sticky; focusTerminal?(): void; onLayoutChange?(): void }` and the return gains `composer: { isOpen(): boolean; open(): void; close(): void; appendDraft(t: string): void }` — `open()` is what Task 5's top-bar button calls. **`send` now returns boolean** (delivered or not); caps ignore it, the composer clears its field only on `true`.
  - `TouchKey` union gains `'compose'`; `TOUCH_KEYS` gains `{ id: 'compose', label: '✏️', pinned: true }` **before** the `enter` entry; `seqFor('compose', …)` is `null`. The cap is the CLOSER: CSS hides it unless `.composing`, so the idle bar's geometry is byte-identical to today.
  - CSS class contract: `#touch-keys.composing` hides `.touch-caps` and the pinned ⏎ and shows the compose cap; `.composer-row`/`.composer-field` visible only while composing.

- [ ] **Step 1: Write the failing unit test**

Append to `test/touchKeys.test.js`:

```js
test('the compose cap is pinned, sits before enter, and maps to no sequence', () => {
  const compose = TOUCH_KEYS.find((k) => k.id === 'compose');
  expect(compose?.pinned).toBe(true);
  const ids = TOUCH_KEYS.map((k) => k.id);
  expect(ids.indexOf('compose')).toBeLessThan(ids.indexOf('enter'));
  // A mode toggle, like ctrl: it must never send bytes itself.
  expect(seqFor('compose', false)).toBeNull();
  expect(seqFor('compose', true)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/touchKeys.test.js`
Expected: FAIL — no `compose` entry exists.

- [ ] **Step 3: Implement `touchKeys.ts` catalog + `seqFor`**

- `TouchKey` union: add `| 'compose'`.
- In `TOUCH_KEYS`, insert before the `enter` entry:

```ts
  // Composer CLOSER — pinned, but display-gated to `.composing` (style.css):
  // the idle bar has no room for another 40px cap at 344px (round-2 budget),
  // so opening happens from the phone top bar (#phone-compose, main.ts) where
  // slack exists, and this cap appears only once the strip is hidden. A mode
  // switch, not a key: fire() special-cases it and seqFor maps it to null.
  { id: 'compose', label: '✏️', pinned: true },
```

- In `seqFor`, replace the ctrl guard line with:

```ts
  if (key === 'ctrl' || key === 'compose') return null; // modifier / mode toggle — no bytes
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/touchKeys.test.js`
Expected: PASS.

- [ ] **Step 5: Add the DOM row builder to `composer.ts`**

Append to `src/web/composer.ts`:

```ts
// ~4 lines at the field's 20px line-height plus padding; past this the field
// scrolls internally instead of eating more terminal rows.
export const COMPOSER_FIELD_MAX_PX = 96;

export interface ComposerRow {
  el: HTMLElement;
  field: HTMLTextAreaElement;
  appendDraft(text: string): void;
}

// DOM half — e2e-covered. Bar conventions throughout: pointerdown +
// preventDefault so a tap never moves focus off the element that should hold
// it (here, the FIELD keeps focus when ➤ is tapped, so the soft keyboard
// stays up), plus the `detail === 0` click path for keyboard/AT activation.
export function buildComposerRow(deps: { send(d: string): boolean; onGrow?(): void }): ComposerRow {
  const el = document.createElement('div');
  el.className = 'composer-row';
  const field = document.createElement('textarea');
  field.className = 'composer-field';
  field.rows = 1;
  field.setAttribute('aria-label', 'message composer');
  const grow = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_FIELD_MAX_PX)}px`;
    deps.onGrow?.();
  };
  field.addEventListener('input', grow);
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = '➤';
  sendBtn.setAttribute('aria-label', 'send');
  const fire = () => {
    // An empty (or whitespace-only) draft sends bare Enter — the keyboard-less
    // submit for "press Enter to continue" prompts. The field clears only when
    // a live pane accepted the bytes: Send must never destroy a draft it could
    // not deliver (setup/stopped panes have no terminal behind them).
    if (deps.send(sendTextOf(field.value) + '\r')) {
      field.value = '';
      grow();
    }
  };
  sendBtn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); fire(); });
  sendBtn.addEventListener('click', (ev) => { if (ev.detail === 0) fire(); });
  el.append(field, sendBtn);
  return {
    el,
    field,
    appendDraft(text: string): void {
      const t = text.trim();
      if (!t) return;
      const v = field.value;
      field.value = v && !/\s$/.test(v) ? `${v} ${t}` : v + t;
      grow();
    },
  };
}
```

- [ ] **Step 6: Integrate into `buildTouchKeyBar`**

In `src/web/touchKeys.ts`:

- Add the import at the top: `import { buildComposerRow } from './composer';`
- Change the signature and return type:

```ts
export function buildTouchKeyBar(
  mount: HTMLElement,
  deps: {
    send(d: string): boolean; // true = a live pane accepted the bytes (composer keeps its draft on false)
    appCursor(): boolean;
    sticky: ReturnType<typeof createStickyCtrl>;
    focusTerminal?(): void;   // composer close hands the keyboard back to xterm
    onLayoutChange?(): void;  // bar height changed (composer open/close/grow) — terminals must refit
  },
): {
  micSlot: HTMLElement;
  syncCap: () => void;
  composer: { isOpen(): boolean; close(): void; appendDraft(t: string): void };
} {
```

- After `mount.appendChild(caps);`, build the row (its draft persists across toggles because the element is display-toggled, never rebuilt):

```ts
  // Between the cap strip and the pinned zone, hidden until `composing` is set
  // on the mount (style.css). The row and its draft PERSIST across toggles.
  const row = buildComposerRow({ send: deps.send, onGrow: deps.onLayoutChange });
  mount.appendChild(row.el);
  let composeBtn: HTMLButtonElement | null = null;
  let composing = false;
  const setComposing = (on: boolean) => {
    if (composing === on) return;
    composing = on;
    // The disarm lives HERE, not in the cap's fire() branch: the top-bar
    // opener calls open() without any bar tap, and an armed modifier must not
    // survive into field typing (or lie in wait for the first character after
    // close) — same rule as every bar tap.
    if (on && deps.sticky.armed) { deps.sticky.disarm(); paint(); }
    mount.classList.toggle('composing', on);
    composeBtn?.classList.toggle('armed', on);
    composeBtn?.setAttribute('aria-pressed', String(on));
    // Focus is the point of the toggle: open puts the soft keyboard on a real
    // field the IME can safely word-replace in; close hands it back to xterm.
    if (on) row.field.focus(); else deps.focusTerminal?.();
    deps.onLayoutChange?.();
  };
```

- In the `TOUCH_KEYS` loop, capture the button like ctrl's: after the `if (k.id === 'ctrl')` capture line add

```ts
    if (k.id === 'compose') { composeBtn = b; b.setAttribute('aria-pressed', 'false'); }
```

- In `fire()`, before the sequence lookup (right after the ctrl branch):

```ts
      if (k.id === 'compose') {
        setComposing(!composing); // setComposing handles the sticky-Ctrl disarm
        return;
      }
```

- Extend the return statement:

```ts
  return {
    micSlot,
    syncCap: paint,
    composer: {
      isOpen: () => composing,
      open: () => setComposing(true),   // the top-bar #phone-compose button's target
      close: () => setComposing(false),
      appendDraft: row.appendDraft,
    },
  };
```

- [ ] **Step 7: Add the CSS**

In `src/web/style.css`, inside `@media (max-width: 720px) and (pointer: coarse)`, after the `.voice-btn:disabled` rule (~line 1870):

```css
  /* Composer mode: the ✏️ cap swaps the cap strip for a native field + ➤.
     The field is a real textarea, so the IME word-replaces against IT and the
     pty sees nothing until Send (the round-2 structural fix). */
  .touch-keys .composer-row { display: flex; flex: 1 1 auto; min-width: 0; gap: 5px; align-items: flex-end; }
  .touch-keys:not(.composing) .composer-row { display: none; }
  .touch-keys.composing .touch-caps { display: none; }
  /* Send-on-empty covers bare Enter, and the field needs the width on 344px. */
  .touch-keys.composing > button[aria-label='enter'] { display: none; }
  /* The compose cap is the CLOSER: it appears only once the strip is hidden.
     Idle, the bar is byte-identical to round 2 — a fifth pinned control would
     re-overflow the 344px budget the touchBar e2e pins. */
  .touch-keys:not(.composing) > button[aria-label='compose'] { display: none; }
  /* 16px is load-bearing: iOS auto-zooms any focused field under 16px (the
     drawer .search lesson — phoneMode multiplies the zoom back out, but not
     needing to is better). Input styling matches .phone-switch. */
  .touch-keys .composer-field {
    flex: 1 1 auto; min-width: 0; resize: none;
    min-height: 40px; max-height: 96px; /* COMPOSER_FIELD_MAX_PX */
    padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); color: var(--text);
    font-family: var(--face); font-size: 16px; line-height: 20px;
  }
```

(The ➤ button needs no rules: it is a `button` under `.touch-keys`, so the existing cap styling applies.)

- [ ] **Step 8: Typecheck + unit suite**

Run: `npm run typecheck && npx vitest run test/touchKeys.test.js test/composer.test.js`
Expected: typecheck FAILS in `main.ts` only if you built it against the old `send` type — main.ts is Task 5; if the error is exactly `main.ts`'s `send` returning `void`, that is the expected seam break: proceed to Task 5 before committing, or (preferred) commit now with `npm run typecheck` deferred to Task 5's gate ONLY if the failure list is exactly that one known site. If anything else fails, fix it here.

- [ ] **Step 9: Commit**

```bash
git add src/web/composer.ts src/web/touchKeys.ts src/web/style.css test/touchKeys.test.js
git commit -m "feat(composer): composer row, compose cap, bar integration and CSS"
```

---

### Task 5: `main.ts` wiring

**Files:**
- Modify: `src/web/main.ts` — the `buildTouchKeyBar` call (~line 1031), the `.phone-bar` header template (~line 1009), the module-level bar handles (grep `let touchMicSlot`), `ensureTab`'s `openTerminal` opts (~line 723), `createPhoneMode`'s `onFlip` (~line 1024), and `teardownWorkspace` (grep `stickyCtrl.disarm()`, ~line 3270).
- Modify: `src/web/style.css` — the `.phone-compose` rules (base + inside the two phone media blocks, beside `.phone-menu` ~line 1750).

**Interfaces:**
- Consumes: Task 4's `buildTouchKeyBar` deps/return, Task 3's `voiceSink` opt, existing `refitActiveTerminals()` (main.ts:355) and `phonePaneOf`-driven `focusedBoxId`.
- Produces: a working end-to-end composer (verified by Task 6).

- [ ] **Step 1: Module-level handle**

Beside the existing `let touchMicSlot` / `touchSyncCap` declarations add:

```ts
let touchComposer: { isOpen(): boolean; open(): void; close(): void; appendDraft(t: string): void } | null = null;
```

- [ ] **Step 2: Rewire the bar**

Replace the `buildTouchKeyBar` call and handle assignments:

```ts
  const bar = buildTouchKeyBar(app.querySelector('#touch-keys') as HTMLElement, {
    // Boolean-returning: the composer clears its draft only when a live pane
    // accepted the bytes (setup/stopped panes have no terminal behind them).
    send: (d) => {
      const t = focusedBoxId ? tabs.get(focusedBoxId)?.term : undefined;
      if (!t) return false;
      t.input(d);
      return true;
    },
    appCursor: () => (focusedBoxId ? tabs.get(focusedBoxId)?.term.appCursor() ?? false : false),
    sticky: stickyCtrl,
    focusTerminal: () => { if (focusedBoxId) tabs.get(focusedBoxId)?.term.focus(); },
    // The bar changes height when the composer opens/closes/grows; open
    // terminals must re-fit to the stage that remains.
    onLayoutChange: () => refitActiveTerminals(),
  });
  touchMicSlot = bar.micSlot;
  touchSyncCap = bar.syncCap;
  touchComposer = bar.composer;
```

- [ ] **Step 3: Top-bar opener**

In the `.phone-bar` template (main.ts ~line 1009), after the `#phone-switch` select, add:

```html
        <button id="phone-compose" class="phone-compose" type="button" title="Compose message" aria-label="Compose message">✏️</button>
```

Beside the other `app.querySelector(...)` listener wiring (e.g. after the `#logout` handler), add — an ordinary click button, NOT the bar's pointerdown convention: moving focus is fine here, `open()` ends in `field.focus()` regardless:

```ts
  app.querySelector('#phone-compose')!.addEventListener('click', () => touchComposer?.open());
```

In `src/web/style.css`: a base hide rule next to the other phone defaults (`~line 1731`, beside `.phone-bar { display: none; }`):

```css
.phone-compose { display: none; }
```

and inside `@media (max-width: 720px) and (pointer: coarse)` (the key-bar block, ~line 1817) — coarse-gated like the key bar itself, because a narrow desktop window shows the phone top bar but has NO key bar, and an opener there would toggle an invisible composer:

```css
  /* The composer opener. Lives in the top bar (the key bar has no 344px room
     for a fifth pinned control); .phone-menu's icon-button styling. */
  .phone-compose {
    display: block; width: 40px; height: 40px; flex: 0 0 auto;
    background: none; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-size: 16px; cursor: pointer;
  }
```

- [ ] **Step 4: Close on desktop flip**

In the `createPhoneMode` options, change `onFlip`:

```ts
    onFlip: () => {
      // A composer left open in the (now display:none) bar would keep the
      // voice sink active on desktop, silently rerouting pane dictation
      // into an invisible draft.
      if (!phoneCtl?.matches()) touchComposer?.close();
      repaintStage();
    },
```

- [ ] **Step 5: Voice sink pass-through**

In `ensureTab`'s `openTerminal` opts (after `transformInput`), add:

```ts
    // While the composer is open, pane dictation lands in its draft instead
    // (inject=off round trip) — the operator edits, then Sends.
    voiceSink: () => (touchComposer?.isOpen() ? (t: string) => touchComposer?.appendDraft(t) : null),
```

- [ ] **Step 6: Teardown**

In `teardownWorkspace`, beside `stickyCtrl.disarm()`, add:

```ts
  touchComposer = null;
```

- [ ] **Step 7: Full verification gate**

Run: `npm test`
Expected: typecheck clean (the Task 4 seam break resolves here), all unit + integration tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(composer): wire the composer — top-bar opener, send, refit, flip-close, voice sink"
```

---

### Task 6: e2e — `composer.spec.ts`

**Files:**
- Create: `test/e2e/composer.spec.ts`

**Interfaces:**
- Consumes: everything above, plus the e2e fixture server (voice fixture returns `hello from the fixture`) and the shared seeded `localhost` box/tmux session (see `test/e2e/touchBar.spec.ts` / `voice.spec.ts` for the conventions this file copies).

- [ ] **Step 1: Write the spec**

```ts
// test/e2e/composer.spec.ts
import { test, expect, type Page } from '@playwright/test';

// The phone composer at the narrowest real width in the fleet (Z Fold 6 cover
// screen). Sends are asserted by pty EFFECT — output text a command produced,
// never the echoed command line, which looks identical whether or not Enter
// was ever sent. Geometry is asserted by rects: toBeVisible() cannot see an
// element scrolled out of an overflow container (the touchBar.spec.ts lesson).
//
// Voice leg: Chromium's fake media device + the fixture transcript, exactly
// as voice.spec.ts.
test.use({
  viewport: { width: 344, height: 844 },
  hasTouch: true,
  isMobile: true,
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openOnPhone(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await page.click('#phone-menu');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
  // The shared tmux session may hold a previous client's unsubmitted line.
  await page.keyboard.press('Control+U');
}

async function openComposer(page: Page) {
  await page.click('#phone-compose'); // top-bar opener; the in-bar ✏️ (visible only while composing) closes
  await expect(page.locator('.composer-field')).toBeVisible();
}

test('send collapses a multi-line draft to one line and submits it', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  await page.locator('.composer-field').fill('echo composer-$((20+4))\nlines');
  await page.click('button[aria-label="send"]');
  // Output proves BOTH properties: `composer-24` only exists if the shell RAN
  // the line (the echoed command shows the literal $((20+4))), and `24 lines`
  // on one output line only exists if the newline collapsed to a space.
  await expect(page.locator('.xterm-rows').first()).toContainText('composer-24 lines', { timeout: 10000 });
});

test('send on an empty field is a bare Enter', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  try {
    await page.locator('.composer-field').fill('read x; echo "got<$x>"');
    await page.click('button[aria-label="send"]');   // shell now waits on read
    await page.click('button[aria-label="send"]');   // empty field -> bare Enter completes it
    await expect(page.locator('.xterm-rows').first()).toContainText('got<>', { timeout: 10000 });
  } finally {
    // Never leave the shared session wedged inside `read` for later tests
    // (the round-2 cat -v lesson): refocus the pane and interrupt.
    await page.click('.touch-keys > button[aria-label="compose"]').catch(() => {});
    await page.keyboard.press('Control+C').catch(() => {});
  }
});

test('the draft survives closing and reopening the composer', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  await page.locator('.composer-field').fill('keep me');
  // NOTE: the closer hides itself on pointerdown. If click() ever flakes on
  // that mid-gesture hide, switch to dispatchEvent('pointerdown') — the
  // voice.spec.ts precedent for handlers that don't live on click.
  await page.click('.touch-keys > button[aria-label="compose"]'); // in-bar closer
  await expect(page.locator('.composer-field')).toBeHidden();
  // The closer leaves with the composer: the idle bar must keep round-2
  // geometry (no fifth pinned control at 344px).
  await expect(page.locator('.touch-keys > button[aria-label="compose"]')).toBeHidden();
  await openComposer(page);
  await expect(page.locator('.composer-field')).toHaveValue('keep me');
});

test('composing fits 344px: field, send, compose and mic on screen; caps and enter gone', async ({ page }) => {
  await openOnPhone(page);
  await expect(page.locator('.voice-btn')).toBeVisible({ timeout: 10000 }); // mic mounted before measuring
  await openComposer(page);
  for (const sel of ['.composer-field', 'button[aria-label="send"]', '.touch-keys > button[aria-label="compose"]', '.voice-btn']) {
    const box = (await page.locator(sel).boundingBox())!;
    expect(box, sel).not.toBeNull();
    expect(box.x, sel).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, sel).toBeLessThanOrEqual(344);
  }
  const bar = await page.locator('.touch-keys').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  await expect(page.locator('.touch-caps')).toBeHidden();
  await expect(page.locator('.touch-keys > button[aria-label="enter"]')).toBeHidden();
});

test('focus follows the toggle: open focuses the field, close returns to xterm', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('composer-field');
  await page.click('.touch-keys > button[aria-label="compose"]');
  expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');
});

test('dictation lands in the draft, not the pane, while composing', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await mic.dispatchEvent('pointerdown');
  await page.waitForTimeout(500);
  await mic.dispatchEvent('pointerup');
  await expect(page.locator('.composer-field')).toHaveValue(/hello from the fixture/, { timeout: 15000 });
  // And the pane must NOT have received it — that is the sink's whole contract.
  await expect(page.locator('.xterm-rows').first()).not.toContainText('hello from the fixture');
});
```

- [ ] **Step 2: Build, then run the spec**

Run: `npm run build && npx playwright test test/e2e/composer.spec.ts`
Expected: PASS (7 tests). The build is mandatory — the e2e server serves `dist/`, and a stale bundle reruns yesterday's code.

- [ ] **Step 3: Run the neighboring phone suites for regressions**

Run: `npx playwright test test/e2e/touchBar.spec.ts test/e2e/phone.spec.ts test/e2e/voice.spec.ts`
Expected: PASS — the compose cap must not have re-introduced cap-strip overflow (touchBar pins geometry at 344px), and pane dictation without the composer is unchanged.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/composer.spec.ts
git commit -m "test(e2e): phone composer — send semantics, geometry, focus, dictation sink"
```

---

### Task 7: docs

**Files:**
- Modify: `docs/terminal.md` (the phone-mode/touch-bar section)
- Modify: `CLAUDE.md` and `AGENTS.md` (the `src/web/` module list — keep the two in sync)

- [ ] **Step 1: `docs/terminal.md`** — in the phone-mode section, after the touch key bar description, add:

```markdown
### Composer

The ✏️ button in the top bar swaps the key bar's cap strip for a native text
field and a ➤ Send button (the ✏️ that appears beside Send closes it again). Type
(or dictate — the mic appends into the field while the composer is open) with the
full soft keyboard: autocorrect and word suggestions work normally here, because
the terminal sees nothing until you tap Send. Send transmits the message plus
Enter in one tap; newlines in the draft are collapsed to spaces (a raw newline
would submit mid-text). The field clears and stays focused for the next message —
and Send on an empty field is a bare Enter, for "press Enter to continue"
prompts. Your draft survives closing the composer and switching panes; Send
delivers to the focused pane, and keeps the draft if that pane has no live
terminal. Tap ✏️ again to return to the caps and direct terminal input.
```

- [ ] **Step 2: `CLAUDE.md` + `AGENTS.md`** — in the `src/web/` feature-module list, extend the `touchKeys.ts` entry's neighborhood with a `composer.ts` entry (same style, condensed):

```markdown
`composer.ts` (the phone composer the top bar's ✏️ opens — the opener lives
there, not in the key bar, because a fifth pinned cap re-overflows the 344px
budget round 2 fixed; the in-bar ✏️ cap exists only while composing, as the
closer: pure `sendTextOf` —
whitespace runs collapse to single spaces because a raw newline reaching the pty
IS Enter, remaining C0/C1 controls stripped, trimmed — plus the DOM row
(textarea + ➤) that `buildTouchKeyBar` display-toggles in place of the cap
strip, so the draft persists across toggles and pane switches. Send transmits
`sendTextOf(draft) + '\r'` through the bar's `send` seam — now
boolean-returning, and the field clears only on `true`, so Send never destroys
a draft a setup/stopped pane couldn't accept; an empty draft sends bare Enter.
Opening focuses the field (the soft keyboard retargets to a real input the IME
can safely word-replace in — the round-2 structural fix), closing refocuses the
terminal, flipping to desktop force-closes via `main.ts`'s onFlip. While open,
the pane mic reroutes transcripts into the draft through `VoiceHost.sink` and
`POST /api/voice?inject=off`, which returns the text without touching the
pane),
```

And append this sentence to the existing `touchKeys.ts` portion of the CLAUDE.md/AGENTS.md `terminal.ts`/touch-bar entry (after the sentence describing `syncCap`):

```markdown
The bar's `send` seam is boolean-returning (a live pane accepted the bytes, or
not), its deps carry `focusTerminal` (composer close hands the keyboard back to
xterm) and `onLayoutChange` (open terminals refit when the composer changes the
bar's height), and `voiceUi.ts`'s `finish()` skips its terminal refocus whenever
a `VoiceHost.sink` was active for that dictation — the composer field is holding
focus deliberately.
```

- [ ] **Step 3: Verify docs build nothing (they are plain markdown) and commit**

```bash
git add docs/terminal.md CLAUDE.md AGENTS.md
git commit -m "docs: phone composer — terminal guide + module maps"
```

---

## After all tasks

Per the repo's standing workflow (CLAUDE.md "Shipping"): build in the worktree, `rsync -a --delete <worktree>/dist/ ./dist/`, restart the service (only when no setup/provision/lifecycle/fleet/voice-install job is running), and have the operator validate on the live app **on the real phone** — the round-2 lesson is that device-level IME/focus behavior is exactly what suites cannot see. Only then merge to main and run the release checklist.
