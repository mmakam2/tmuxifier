# Clawd Working-Badge Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tiny animated block-glyph Clawd sprite (the Claude Code mascot) to every `working` agent chip — sidebar badge, pane-header chip, and dashboard fleet-strip chip — bouncing on a CSS beat; the `waiting` chip stays plain.

**Architecture:** A new `src/web/clawd.ts` module owns the sprite (exported frame-glyph constants plus a `buildClawd()` DOM builder). The three chip render sites gain a `sprite` flag on their existing pure view-models (`agentBadgeFor` in `statusDot.ts`, `paneHeaderChip` in `paneHeader.ts`; the dashboard checks its `chipState` inline, matching its existing style) and append the sprite before the text. Animation is pure CSS (`steps(2)` keyframes) — no JS timers, so N working boxes cost nothing and the in-place repaint passes never manage timer lifecycles.

**Tech Stack:** TypeScript (src/web, strict — `npm run typecheck`), vitest (node environment — **no DOM**, so DOM builders are untested by convention), plain CSS in `src/web/style.css`, Vite build.

Spec: `docs/superpowers/specs/2026-08-02-clawd-working-badge-design.md`.

## Global Constraints

- Sprite glyphs come only from the bundled mono face's Unicode block elements — no images, no SVG, no new font (DESIGN.md one-face rule).
- Sprite color is `currentColor` only — it inherits the chip's amber; no new hue (DESIGN.md: LED colors are never decorative).
- `waiting` chips are unchanged everywhere: no sprite, same text, same classes.
- Every animation gets a `prefers-reduced-motion: reduce` override resting on frame A (body down, feet visible).
- The sprite element carries `aria-hidden="true"` — the adjacent "working" text is the accessible label.
- Tests are TDD (failing test first) and touch pure code only; run with `npx vitest run test/<file> ` per task and `npm test` (typecheck + full suite) before the final commit of each code task.
- Work happens on a feature branch/worktree, conventional-commit messages, no PII in committed files.

---

### Task 1: `clawd.ts` — frame constants and sprite builder

**Files:**
- Create: `src/web/clawd.ts`
- Test: `test/clawd.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CLAWD_BODY: string` (`'▐▛███▜▌'`), `CLAWD_FEET: string` (`'▘▘ ▝▝'`), `buildClawd(): HTMLElement` — a `<span class="clawd" aria-hidden="true">` containing `<span class="clawd-body">` and `<span class="clawd-feet">`. Tasks 3–5 import `buildClawd`; the CSS in Task 6 targets `.clawd` / `.clawd-body` / `.clawd-feet`.

- [ ] **Step 1: Write the failing test**

Create `test/clawd.test.js`:

```js
import { test, expect } from 'vitest';
import { CLAWD_BODY, CLAWD_FEET } from '../src/web/clawd.ts';

// The sprite must stay renderable by the bundled mono face: Unicode block
// elements (U+2580–U+259F) and spaces only. Anything else risks tofu in the
// chip, which a node test can catch even though the DOM builder cannot be
// exercised here (vitest runs environment:'node' — no DOM by convention).
test('clawd frames: block-element glyphs only, feet narrower than body', () => {
  const blockOrSpace = /^[▀-▟ ]+$/;
  expect(CLAWD_BODY).toMatch(blockOrSpace);
  expect(CLAWD_FEET).toMatch(blockOrSpace);
  expect(CLAWD_BODY.length).toBe(7);
  expect(CLAWD_FEET.length).toBe(5);
  // Feet are strictly narrower so the centered stack reads as a body on legs.
  expect(CLAWD_FEET.length).toBeLessThan(CLAWD_BODY.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/clawd.test.js`
Expected: FAIL — `Cannot find module '../src/web/clawd.ts'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/web/clawd.ts`:

```ts
// Clawd: the Claude Code mascot as a two-row Unicode block-element sprite,
// shown beside WORKING agent chips (sidebar badge, pane chip, dashboard
// fleet strip). Glyphs only — the bundled mono face renders them, so the
// sprite never breaks the one-face discipline, and it is colored by
// currentColor so it inherits the chip's amber rather than introducing a
// hue. Animation is pure CSS (.clawd-* in style.css); this module is just
// the frames and the DOM.
export const CLAWD_BODY = '▐▛███▜▌';
export const CLAWD_FEET = '▘▘ ▝▝';

// aria-hidden: the adjacent "working" text is the accessible label; the
// sprite is decoration for sighted users only.
export function buildClawd(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'clawd';
  el.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span');
  body.className = 'clawd-body';
  body.textContent = CLAWD_BODY;
  const feet = document.createElement('span');
  feet.className = 'clawd-feet';
  feet.textContent = CLAWD_FEET;
  el.append(body, feet);
  return el;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/clawd.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/web/clawd.ts test/clawd.test.js
git commit -m "feat(ui): clawd sprite module (frames + DOM builder)"
```

---

### Task 2: `agentBadgeFor` sprite flag

**Files:**
- Modify: `src/web/statusDot.ts:78-83` (the `AgentBadge` interface and `agentBadgeFor`)
- Test: `test/statusDot.test.js:224-234` (the existing `agentBadgeFor` test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentBadge` gains `sprite?: boolean`; `agentBadgeFor(samples: Sample[] | undefined): AgentBadge | null` returns `sprite: true` **only** when the latest sample's agent is `'working'`. Task 4's `applyAgentBadge` branches on `b.sprite`.

- [ ] **Step 1: Update the test to expect the sprite flag (failing first)**

In `test/statusDot.test.js`, replace the existing test (lines 224–234):

```js
test('agentBadgeFor: latest sample state maps to the badge, absence maps to null', () => {
  // working carries the Clawd sprite flag; waiting deliberately does not —
  // stillness plus orange is the "your turn" read.
  expect(agentBadgeFor([{ t: 1, up: true, agent: 'waiting' }, { t: 2, up: true, agent: 'working' }]))
    .toEqual({ text: 'working', cls: 'badge-agent-working', sprite: true });
  expect(agentBadgeFor([{ t: 1, up: true, agent: 'working' }, { t: 2, up: true, agent: 'waiting' }]))
    .toEqual({ text: 'waiting', cls: 'badge-agent-waiting' });
  expect(agentBadgeFor([{ t: 1, up: true, agent: 'waiting' }])?.sprite).toBeUndefined();
  // Hook-only rule: no agent on the latest sample (un-hooked box, no claude,
  // or claude exited) renders nothing — even if an older sample had state.
  expect(agentBadgeFor([{ t: 1, up: true, agent: 'working' }, { t: 2, up: true }])).toBeNull();
  expect(agentBadgeFor([])).toBeNull();
  expect(agentBadgeFor(undefined)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/statusDot.test.js`
Expected: FAIL — the working case is missing `sprite: true`.

- [ ] **Step 3: Implement**

In `src/web/statusDot.ts`, replace lines 78–83:

```ts
export interface AgentBadge { text: 'working' | 'waiting'; cls: string; sprite?: boolean }
export function agentBadgeFor(samples: Sample[] | undefined): AgentBadge | null {
  const last = samples && samples.length ? samples[samples.length - 1] : undefined;
  if (last?.agent !== 'working' && last?.agent !== 'waiting') return null;
  const badge: AgentBadge = { text: last.agent, cls: `badge-agent-${last.agent}` };
  // Clawd rides the working state only: motion means "agent busy", and its
  // absence on waiting keeps the orange chip's stillness meaning "your turn".
  if (last.agent === 'working') badge.sprite = true;
  return badge;
}
```

(Keep the existing comment block above the interface unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/statusDot.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/web/statusDot.ts test/statusDot.test.js
git commit -m "feat(ui): agentBadgeFor flags the working badge for the clawd sprite"
```

---

### Task 3: pane-header chip sprite flag and render

**Files:**
- Modify: `src/web/paneHeader.ts:21` (the `PaneChip` interface), `src/web/paneHeader.ts:35` (the agent case in `paneHeaderChip`), `src/web/paneHeader.ts:120-134` (the `update` closure in `buildPaneHeader`)
- Test: `test/paneHeader.test.js:46-49` (the existing agent-chip assertions)

**Interfaces:**
- Consumes: `buildClawd` from `src/web/clawd.ts` (Task 1).
- Produces: `PaneChip` gains `sprite?: boolean`; `paneHeaderChip(i: PaneHeaderInput): PaneChip | null` sets `sprite: true` only for the working agent case. The DOM `update()` renders sprite-then-text inside the chip span.

- [ ] **Step 1: Update the test to expect the sprite flag (failing first)**

In `test/paneHeader.test.js`, the working-agent assertion around line 46 currently expects `{ kind: 'agent', text: 'working', cls: 'chip-agent-working' }`. Replace the two agent assertions:

```js
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'working' })))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'waiting' })))
    .toEqual({ kind: 'agent', text: 'waiting', cls: 'chip-agent-waiting' });
```

(Keep the surrounding test structure; only the expected objects change — waiting must stay sprite-less.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/paneHeader.test.js`
Expected: FAIL — working chip missing `sprite: true`.

- [ ] **Step 3: Implement the view-model flag**

In `src/web/paneHeader.ts`:

Line 21 becomes:

```ts
export interface PaneChip { kind: 'state' | 'conn' | 'agent'; text: string; cls: string; sprite?: boolean }
```

Line 35 (the agent case in `paneHeaderChip`) becomes:

```ts
  if (i.agent === 'working' || i.agent === 'waiting') {
    const chip: PaneChip = { kind: 'agent', text: i.agent, cls: `chip-agent-${i.agent}` };
    if (i.agent === 'working') chip.sprite = true; // Clawd rides working only
    return chip;
  }
```

- [ ] **Step 4: Implement the DOM render**

Add the import at the top of `src/web/paneHeader.ts`:

```ts
import { buildClawd } from './clawd';
```

In `buildPaneHeader`'s `update` closure (lines 120–134), replace the chip branch. Rebuilding the chip's own children is safe: the voice button lives in `voiceSlot` and the lifecycle keys in `lifecycleSlot`, both outside the chip span — the "text/classes only" rule protects those slots, not the chip's text nodes.

```ts
    if (m.chip) {
      chip.hidden = false;
      chip.className = `pane-chip ${m.chip.cls}`;
      chip.textContent = '';
      if (m.chip.sprite) chip.append(buildClawd());
      chip.append(document.createTextNode(m.chip.text));
    } else {
      chip.hidden = true;
      chip.className = 'pane-chip';
      chip.textContent = '';
    }
```

- [ ] **Step 5: Run test, typecheck, commit**

Run: `npx vitest run test/paneHeader.test.js && npm run typecheck`
Expected: PASS, clean.

```bash
git add src/web/paneHeader.ts test/paneHeader.test.js
git commit -m "feat(ui): pane chip renders clawd sprite beside working"
```

---

### Task 4: sidebar badge and dashboard fleet-chip render

**Files:**
- Modify: `src/web/main.ts:112-126` (`applyAgentBadge`), plus its import line `src/web/main.ts:4`
- Modify: `src/web/dashboard.ts:399-404` (the fleet-row chip branch in `updateFleet`), plus an import
- Test: none new — both are DOM layers (vitest has no DOM by convention); `npm test` guards regressions in everything they call.

**Interfaces:**
- Consumes: `AgentBadge.sprite` (Task 2), `buildClawd` (Task 1).
- Produces: nothing later tasks consume; behavior only.

- [ ] **Step 1: Rework `applyAgentBadge` in `main.ts`**

Add `buildClawd` to the imports (a new import line next to the existing ones at the top of the file):

```ts
import { buildClawd } from './clawd';
```

Replace the body of `applyAgentBadge` (lines 112–126). Both the reuse path and the create path go through one renderer so the working→waiting flip drops the sprite and the reverse adds it:

```ts
function applyAgentBadge(badges: Element, id: string) {
  const existing = badges.querySelector('[data-agent-badge]');
  const b = agentBadgeFor(latestSeries[id]);
  if (!b) { existing?.remove(); return; }
  const el = (existing as HTMLElement | null) ?? document.createElement('span');
  el.className = `badge ${b.cls}`;
  el.dataset.agentBadge = '1';
  // Children rebuilt every pass: the badge holds only the sprite and the text,
  // so a state flip can never strand a sprite beside the wrong label.
  el.textContent = '';
  if (b.sprite) el.append(buildClawd());
  el.append(document.createTextNode(b.text));
  if (!existing) badges.append(el);
}
```

(Keep the comment block above the function unchanged.)

- [ ] **Step 2: Rework the dashboard fleet chip**

In `src/web/dashboard.ts`, add the import next to the existing ones at the top:

```ts
import { buildClawd } from './clawd';
```

Replace the chip branch in `updateFleet` (lines 399–404). The dashboard has no view-model flag — its inline `chipState` check is the existing style here, so the sprite decision stays inline too:

```ts
      const chipState = agent === 'working' || agent === 'waiting' ? agent : null;
      row.chip.hidden = chipState === null;
      if (chipState) {
        row.chip.className = `dash-chip dash-chip-${chipState}`;
        row.chip.textContent = '';
        if (chipState === 'working') row.chip.append(buildClawd()); // Clawd rides working only
        row.chip.append(document.createTextNode(chipState.toUpperCase()));
      }
```

- [ ] **Step 3: Typecheck and full suite**

Run: `npm test`
Expected: typecheck clean, all vitest suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts src/web/dashboard.ts
git commit -m "feat(ui): sidebar badge and dashboard fleet chip render clawd sprite"
```

---

### Task 5: sprite CSS — sizing, hop keyframes, reduced motion

**Files:**
- Modify: `src/web/style.css` — add the Clawd block directly after the `.badge-agent-waiting` rule (line 444), where the agent chip recipes live.

**Interfaces:**
- Consumes: the `.clawd` / `.clawd-body` / `.clawd-feet` class names from Task 1.
- Produces: nothing.

- [ ] **Step 1: Add the CSS**

Insert after the `.badge-agent-waiting` rule:

```css
/* Clawd: the working-agent sprite — two block-glyph rows in currentColor (the
   chip's amber), hopping on a steps(2) beat. Frame A: body down, feet out.
   Frame B: body 1px up, feet tucked. Pure CSS so a fleet of working boxes
   costs no timers; reduced motion rests on frame A (the initial styles). */
.clawd {
  display: inline-flex; flex-direction: column; align-items: center;
  font-size: 6px; line-height: 0.9; letter-spacing: normal;
  vertical-align: -2px; margin-right: 4px;
}
.clawd-body { display: block; animation: clawd-hop 1.2s steps(2, jump-none) infinite; }
.clawd-feet { display: block; animation: clawd-feet 1.2s steps(2, jump-none) infinite; }
@keyframes clawd-hop { from { transform: translateY(0); } to { transform: translateY(-1px); } }
@keyframes clawd-feet { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .clawd-body, .clawd-feet { animation: none; }
}
```

Notes for the implementer:
- `steps(2, jump-none)` holds each of the two frames for half the 1.2s loop with no interpolation — a sprite flipbook, not a tween. Both animations share one duration/timing so body and feet stay in sync.
- `letter-spacing: normal` matters: `.badge` tracks at 0.08em, which would split the block glyphs apart.
- The exact `font-size`/`vertical-align` values are starting points; Task 6's live validation is where they get tuned so the chip height does not grow. Adjust there if needed, not here.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean Vite build.

- [ ] **Step 3: Commit**

```bash
git add src/web/style.css
git commit -m "feat(ui): clawd hop animation css with reduced-motion rest frame"
```

---

### Task 6: live validation (user-gated)

**Files:** none (deploy + verify).

**Interfaces:** none.

Per the standing validate-on-live workflow (CLAUDE.md “Shipping”): candidate dist to the live app, the user validates in a real browser, and only then does the branch merge and the ship checklist run.

- [ ] **Step 1: Deploy the candidate bundle**

From the feature worktree (adjust the worktree path):

```bash
npm run build
rsync -a --delete dist/ /root/tmuxifier/dist/
```

Before restarting, confirm no setup/provision/lifecycle/fleet/voice-install job is `running` (a restart would interrupt it), then:

```bash
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

Verify one hashed asset serves with its real content-type (not the SPA fallback), per the shipping notes:

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
ASSET="$(ls /root/tmuxifier/dist/assets/*.js | head -1 | xargs basename)"
curl -sk -o /dev/null -w '%{content_type}\n' "$BASE/assets/$ASSET"   # expect javascript, not text/html
```

- [ ] **Step 2: Ask the user to validate in the browser**

Checklist for the user (a box with a hooked, working claude — or temporarily write a marker file — makes the state appear):

- Sidebar working badge shows Clawd bouncing beside `working` (amber, real glyphs — not tofu boxes).
- Pane-header chip on that box's open terminal shows the same.
- Standby dashboard fleet strip (undock all panes) shows Clawd on the working chip.
- A `waiting` chip is plain text, unchanged, no sprite.
- Chip/badge height did not visibly grow; sprite is legible at size.
- With OS reduced-motion enabled, the sprite holds still (body down, feet out).

- [ ] **Step 3: On approval, hand off to the ship checklist**

Merge to main and run the CLAUDE.md “Shipping” checklist (version bump, build, restart, health check, PII scrub, tag, release). On a failed validation, fix on the branch and redeploy the candidate instead.
