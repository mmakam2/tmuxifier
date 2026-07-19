# Agent Idle Detection & Browser Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when Claude Code in a box's configured tmux session is waiting for input or has finished, record those as events in the existing health-events pipeline, and fire browser notifications for user-selected event kinds via a new Notifications settings tab.

**Architecture:** The single status probe gains two data points (the active pane's command per session, and the box's clock); `healthHistory.js` derives an agent state per sample and emits two new edge-triggered event kinds through the unchanged persisted-events pipeline; the web client adds a pure preferences module, a settings tab, and browser-Notification firing driven by the existing health poll. All detection and preference logic is pure and unit-tested; DOM/Notification wiring is typecheck + live verification.

**Tech Stack:** Node 20 ESM server (`.js`), TypeScript web client, vitest, localStorage, the Web Notifications API.

**Spec:** `docs/superpowers/specs/2026-07-19-agent-notifications-design.md`

## Global Constraints

- Detection evaluates ONLY the box's configured `sessionName`; other sessions are ignored.
- Agent command match is `claude` or `claude-*` only (mirrors `tmuxInject.js`); no other agent.
- Idle time is computed as `boxNow - sessionActivity`, both from the box's own clock — never the Tmuxifier host clock (skew-proof).
- The two new agent event kinds (`agent-input`, `agent-done`) are suppressed while the session is attached; box-level kinds (`down`/`up`/`needs-auth`/`key-changed`/`threshold`/`threshold-clear`) are NEVER suppressed.
- Edge-triggered: `agent-input` fires once on working→waiting and must return to working before re-firing; the existing first-sample seeding rule (no emission without a prev sample) is preserved.
- EVERY event always enters the events log regardless of preferences; preferences govern only the events-button counter and browser notifications.
- `agentIdleSec`: env `TMUXIFIER_AGENT_IDLE_SEC`, default 45, clamped 10–3600 via the existing `clampInt`.
- Default preferences: all kinds enabled EXCEPT `up` and `threshold-clear`.
- Conventional-commit messages; real-code DI tests, TDD. Public repo: docs/tests use placeholders.

---

### Task 1: Probe fields — pane command + box clock

**Files:**
- Modify: `src/server/status.js` (`STATUS_FMT`, `parseTmuxSessions`, `META_PROBE`, `META_KEYS`)
- Test: `test/status.test.js`

**Interfaces:**
- Produces: `parseTmuxSessions(stdout)` entries gain `paneCmd: string` (the active pane's command, `''` when absent). `parseMeta(stdout)` output gains `boxNowSec: number` when present. No other shape change.

**Context:** `STATUS_FMT` (status.js:3) is the `tmux ls -F` format; pane variables in `tmux ls` resolve against each session's active pane — verified empirically on tmux 3.5a (a `list-sessions` format with `#{pane_current_command}` reports `claude` for a session running Claude Code). `META_PROBE` builds the `__META__` numbers line parsed by `parseMeta` and gated by `META_KEYS`. The probe is one ssh round-trip — these fields cost nothing extra.

- [ ] **Step 1: Write the failing tests**

Append to `test/status.test.js`:

```js
test('parseTmuxSessions captures the active pane command as paneCmd', () => {
  const out = 'web:1:1:1721350000:claude\nscratch:2:0:1721349000:zsh\n';
  const s = parseTmuxSessions(out);
  expect(s).toEqual([
    { name: 'web', windows: 1, attached: true, activity: 1721350000, paneCmd: 'claude' },
    { name: 'scratch', windows: 2, attached: false, activity: 1721349000, paneCmd: 'zsh' },
  ]);
});

test('parseTmuxSessions tolerates a missing pane command (older format / no panes)', () => {
  expect(parseTmuxSessions('web:1:1:1721350000\n')[0].paneCmd).toBe('');
});

test('parseMeta reads boxNowSec (the box clock) when present', () => {
  expect(parseMeta('__META__ boxNowSec=1721350123 memTotalKb=100 memAvailKb=40\n').boxNowSec).toBe(1721350123);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/status.test.js`
Expected: FAIL — `paneCmd` undefined; `boxNowSec` undefined.

- [ ] **Step 3: Implement**

In `status.js`, extend the session format with the active pane command (append `:#{pane_current_command}`):

```js
const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}:#{pane_current_command}';
```

`parseTmuxSessions` — parse the 5th field, defaulting to `''` (session names never contain `:`; the pane command is the last field so a `split(':')` positional read is safe here because only the trailing field is added):

```js
      const [name, windows, attached, activity, paneCmd] = line.split(':');
      return { name, windows: Number(windows), attached: attached === '1', activity: Number(activity), paneCmd: paneCmd || '' };
```

Add the box clock to the `__META__` line. In the `META_PROBE` template (the block ending `echo; } 2>/dev/null;`), before the final `echo;`, add:

```js
  `printf ' boxNowSec=%s' "$(date +%s)"; ` +
```

Add `boxNowSec` to `META_KEYS`:

```js
const META_KEYS = new Set([
  'load1', 'load5', 'load15', 'cpus', 'cpuUsageUsec',
  'memTotalKb', 'memAvailKb', 'diskTotalKb', 'diskUsedKb', 'diskPct', 'uptimeSec', 'boxNowSec',
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js test/status.test.js
git commit -m "feat(status): probe active-pane command and box clock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Config — `agentIdleSec`

**Files:**
- Modify: `src/server/config.js` (`DEFAULTS`, env mapping, the clamp block)
- Modify: `.env.example`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config.agentIdleSec: number` — default 45, clamped 10–3600.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
test('agentIdleSec defaults to 45 and is read from TMUXIFIER_AGENT_IDLE_SEC', () => {
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).agentIdleSec).toBe(45);
  expect(loadConfig({}, { env: { TMUXIFIER_AGENT_IDLE_SEC: '90' }, cwd: '/nonexistent' }).agentIdleSec).toBe(90);
});

test('agentIdleSec clamps out-of-range and non-numeric values to the default', () => {
  expect(loadConfig({}, { env: { TMUXIFIER_AGENT_IDLE_SEC: '2' }, cwd: '/nonexistent' }).agentIdleSec).toBe(45);
  expect(loadConfig({}, { env: { TMUXIFIER_AGENT_IDLE_SEC: 'abc' }, cwd: '/nonexistent' }).agentIdleSec).toBe(45);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `agentIdleSec` undefined.

- [ ] **Step 3: Implement**

In `DEFAULTS` (config.js), after `healthThresholdHysteresisPct: 5,`:

```js
  // Seconds a claude pane's tmux session must be idle (no output) before it is
  // read as "waiting for input" — see docs/superpowers/specs/2026-07-19-agent-notifications-design.md
  agentIdleSec: 45,
```

In the `envCfg` mapping (near the other health knobs), add:

```js
    agentIdleSec: e.TMUXIFIER_AGENT_IDLE_SEC ? Number(e.TMUXIFIER_AGENT_IDLE_SEC) : undefined,
```

In the clamp block (with the health clamps), add:

```js
  merged.agentIdleSec = clampInt(merged.agentIdleSec, 10, 3600, DEFAULTS.agentIdleSec);
```

Append to `.env.example`:

```
# Seconds a Claude pane's tmux session must be silent before Tmuxifier treats it
# as waiting for your input (agent-input notification). Default 45; range 10-3600.
#TMUXIFIER_AGENT_IDLE_SEC=45
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js .env.example test/config.test.js
git commit -m "feat(config): TMUXIFIER_AGENT_IDLE_SEC idle threshold

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Agent state — sample derivation + transitions + wiring

**Files:**
- Modify: `src/server/healthHistory.js` (`sampleOf`, `classifyTransitions`, `createHealthHistory`, `record`)
- Modify: `src/server/index.js` (pass `agentIdleSec` to `createHealthHistory`)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- Consumes: `parseTmuxSessions` entries with `paneCmd`, `attached`, `activity`; `parseMeta` `boxNowSec` (Task 1); `config.agentIdleSec` (Task 2).
- Produces: `sampleOf(status, at, opts)` — `opts = { sessionName?: string, agentIdleSec?: number }`; samples gain `agent?: 'working' | 'waiting'` and `agentAttached?: boolean`. `classifyTransitions` emits `{ kind: 'agent-input' }` and `{ kind: 'agent-done' }`. `createHealthHistory({ ..., agentIdleSec })`.

**Context:** `sampleOf(status, at)` (healthHistory.js) currently projects reachability + metrics. `record()` (healthHistory.js) calls `sampleOf(status, at)` then `classifyTransitions(prev, sample, thresholds, state)` per box and `emit`s each event with `{ boxId, label, host, t, kind }`. `status.sessions` is the `parseTmuxSessions` array; `status.metrics` is the `parseMeta` object (so `boxNowSec` lives at `status.metrics.boxNowSec`). A `claude`-family pane match: `/^claude(-|$)/`.

- [ ] **Step 1: Write the failing tests**

Append to `test/healthHistory.test.js`:

```js
const AGENT = { agentIdleSec: 45, sessionName: 'web' };
const withAgent = (over) => ({ reachable: true, metrics: { boxNowSec: 1000 }, sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'claude' }], ...over });

test('sampleOf marks a busy claude session working, an idle one waiting', () => {
  // active now → working
  expect(sampleOf(withAgent(), 5, AGENT).agent).toBe('working');
  // idle 60s (>= 45) → waiting
  const idle = withAgent({ sessions: [{ name: 'web', attached: false, activity: 940, paneCmd: 'claude' }] });
  expect(sampleOf(idle, 5, AGENT).agent).toBe('waiting');
});

test('sampleOf without a box clock reports presence with UNKNOWN idleness (never waiting, working, or absent)', () => {
  // A failed __META__ line must not erase the agent (a false agent-done), and
  // must not fabricate an observed idle state either: a fabricated 'working'
  // would make the recovery poll look like a genuine working->waiting edge and
  // fire a false agent-input one poll later. 'unknown' sits on neither side of
  // the input edge.
  const noMeta = withAgent({ metrics: undefined });
  expect(sampleOf(noMeta, 5, AGENT).agent).toBe('unknown');
});

test('a __META__ gap in the middle of a continuous wait fires no agent-input on recovery', () => {
  // waiting -> (clock missing: unknown) -> waiting must be silent end to end;
  // agent-done must still fire THROUGH an unknown sample (presence is
  // pane-based, not clock-based).
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  const unknown = { up: true, agent: 'unknown', agentAttached: false };
  const st0 = initThresholdState();
  const r1 = classifyTransitions(waiting, unknown, TH, st0);
  const r2 = classifyTransitions(unknown, waiting, TH, r1.state);
  expect([...r1.events, ...r2.events].filter((e) => e.kind.startsWith('agent-'))).toEqual([]);
  const gone = { up: true, agentAttached: false };
  expect(classifyTransitions(unknown, gone, TH, initThresholdState()).events).toContainEqual({ kind: 'agent-done' });
});

test('sampleOf ignores non-claude panes and the wrong session', () => {
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'zsh' }] }), 5, AGENT).agent).toBeUndefined();
  expect(sampleOf(withAgent({ sessions: [{ name: 'other', attached: false, activity: 940, paneCmd: 'claude' }] }), 5, AGENT).agent).toBeUndefined();
  expect(sampleOf(withAgent(), 5, {}).agent).toBeUndefined(); // no sessionName → no agent state
});

test('sampleOf carries the configured session attached flag even without a claude pane', () => {
  // Attachment is a SESSION property: it must survive the poll where claude
  // exits, so agent-done suppression can honor it on both ends of the edge.
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: true, activity: 940, paneCmd: 'claude' }] }), 5, AGENT).agentAttached).toBe(true);
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: true, activity: 940, paneCmd: 'zsh' }] }), 5, AGENT).agentAttached).toBe(true);
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: false, activity: 940, paneCmd: 'zsh' }] }), 5, AGENT).agent).toBeUndefined();
});

test('classifyTransitions emits agent-input on working->waiting when detached, once', () => {
  const th = TH;
  const w = { up: true, agent: 'working', agentAttached: false };
  const idle = { up: true, agent: 'waiting', agentAttached: false };
  const r1 = classifyTransitions(w, idle, th, initThresholdState());
  expect(r1.events).toContainEqual({ kind: 'agent-input' });
  // still waiting → no re-fire
  const r2 = classifyTransitions(idle, idle, th, r1.state);
  expect(r2.events).not.toContainEqual({ kind: 'agent-input' });
});

test('classifyTransitions suppresses agent-input while attached', () => {
  const w = { up: true, agent: 'working', agentAttached: true };
  const idle = { up: true, agent: 'waiting', agentAttached: true };
  expect(classifyTransitions(w, idle, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-input' });
});

test('classifyTransitions emits agent-done when the agent disappears on an up box, detached', () => {
  const w = { up: true, agent: 'working', agentAttached: false };
  const gone = { up: true, agentAttached: false };
  expect(classifyTransitions(w, gone, TH, initThresholdState()).events).toContainEqual({ kind: 'agent-done' });
  // suppressed if EITHER end of the edge was attached (watching = no ping)
  const wA = { up: true, agent: 'working', agentAttached: true };
  expect(classifyTransitions(wA, { up: true, agentAttached: false }, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-done' });
  expect(classifyTransitions(w, { up: true, agentAttached: true }, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-done' });
});

test('agent kinds never fire on the first sample (no prev)', () => {
  const idle = { up: true, agent: 'waiting', agentAttached: false };
  expect(classifyTransitions(null, idle, TH, initThresholdState()).events).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthHistory.test.js`
Expected: FAIL — `agent` undefined; new kinds not emitted.

- [ ] **Step 3: Implement**

`sampleOf` — add an options parameter and derive agent state before the return. Change the signature to `export function sampleOf(status, at, opts = {})` and insert before `return sample;`:

```js
  // Agent state for the box's configured session only (opts.sessionName).
  // PRESENCE comes from the pane command alone; the box clock only decides
  // working vs waiting. A poll whose __META__ line failed (no boxNowSec) must
  // neither erase the agent (false agent-done) nor fabricate an observed idle
  // state: a fabricated 'working' would make the recovery poll look like a
  // genuine working->waiting edge and fire a false agent-input one poll after
  // the gap. So no clock => 'unknown', which sits on neither side of the
  // input edge (at worst a real transition inside the gap is missed once).
  // agentAttached is a SESSION property, set whenever the configured session
  // exists, so suppression still sees attachment on the sample where claude
  // has already exited.
  const { sessionName, agentIdleSec } = opts;
  if (sessionName && Array.isArray(s.sessions)) {
    const sess = s.sessions.find((x) => x.name === sessionName);
    if (sess) {
      sample.agentAttached = !!sess.attached;
      if (/^claude(-|$)/.test(String(sess.paneCmd || ''))) {
        if (m && m.boxNowSec != null) {
          const idleSec = m.boxNowSec - Number(sess.activity || 0);
          sample.agent = idleSec >= Number(agentIdleSec ?? 45) ? 'waiting' : 'working';
        } else {
          sample.agent = 'unknown';
        }
      }
    }
  }
```

`classifyTransitions` — after the reachability/auth block and before the `mem`/`disk` loop (the agent edges are independent of thresholds), add:

```js
  // Agent edges (box's configured session only). Suppressed while that session
  // is attached — watching the terminal is its own notification; agent-done
  // checks BOTH ends of the edge, since the user may attach in the final poll
  // interval. 'unknown' (clock unavailable) matches neither side of the input
  // edge but still counts as presence for agent-done. Edge-triggered like the
  // others: no emission without a prev sample.
  if (prev) {
    if (prev.agent === 'working' && next.agent === 'waiting' && !next.agentAttached) {
      events.push({ kind: 'agent-input' });
    } else if (prev.agent && !next.agent && next.up && !prev.agentAttached && !next.agentAttached) {
      events.push({ kind: 'agent-done' });
    }
  }
```

(The `if (!prev) { ... return }` seed block already returns early, so the `if (prev)` guard is belt-and-suspenders and keeps the block self-contained.)

`createHealthHistory` — accept `agentIdleSec` in the destructured options (default 45) and store it; in `record`, pass it plus the box's session name to `sampleOf`:

```js
// in the factory signature options, alongside maxSamples/maxEvents/thresholds:
  agentIdleSec = 45,
```

```js
// in record(), replace the sampleOf call:
        const sample = sampleOf(status, at, { sessionName: box.sessionName, agentIdleSec });
```

`src/server/index.js` — pass the config value where `createHealthHistory` is constructed (it currently receives `maxSamples`, `maxEvents`, `thresholds`, `load`, `save`):

```js
  agentIdleSec: config.agentIdleSec,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthHistory.test.js`
Expected: PASS. Then `npx vitest run` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js src/server/index.js test/healthHistory.test.js
git commit -m "feat(health): derive agent state and emit agent-input/agent-done events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web types + event formatting

**Files:**
- Modify: `src/web/api.ts` (`HealthEventKind`)
- Modify: `src/web/healthEvents.ts` (`formatEvent`)
- Test: `test/healthEvents.test.js`

**Interfaces:**
- Produces: `HealthEventKind` includes `'agent-input' | 'agent-done'`; `formatEvent` renders both.

**Context:** `HealthEventKind` (api.ts) is the union `'down' | 'up' | 'needs-auth' | 'key-changed' | 'threshold' | 'threshold-clear'`. `formatEvent` (healthEvents.ts) switches on `e.kind` and returns `{ icon, text, level }`; it gained a `default` case in v1.7.7 so unknown kinds never break the panel.

- [ ] **Step 1: Write the failing tests**

Append to `test/healthEvents.test.js`:

```js
test('formatEvent renders the agent kinds', () => {
  const input = formatEvent({ ...base, kind: 'agent-input' });
  expect(input.text).toContain('waiting for input');
  expect(input.level).toBe('warn');
  const done = formatEvent({ ...base, kind: 'agent-done' });
  expect(done.text).toContain('finished');
  expect(done.level).toBe('ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthEvents.test.js`
Expected: FAIL — the two kinds hit the generic default (text won't contain "waiting for input").

- [ ] **Step 3: Implement**

`api.ts` — extend the union:

```ts
export type HealthEventKind = 'down' | 'up' | 'needs-auth' | 'key-changed' | 'threshold' | 'threshold-clear' | 'agent-input' | 'agent-done';
```

`healthEvents.ts` `formatEvent` — add two cases before the `default`:

```ts
    case 'agent-input': return { icon: '⌨️', text: `${name} — claude is waiting for input`, level: 'warn' };
    case 'agent-done': return { icon: '🤖', text: `${name} — claude finished`, level: 'ok' };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthEvents.test.js && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/healthEvents.ts test/healthEvents.test.js
git commit -m "feat(web): agent-input/agent-done event kinds and formatting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Notification preferences module + filtered counter

**Files:**
- Create: `src/web/notifyPrefs.ts`
- Modify: `src/web/healthEvents.ts` (add `unseenCountFiltered`)
- Test: `test/notifyPrefs.test.js` (new)
- Test: `test/healthEvents.test.js`

**Interfaces:**
- Produces:
  - `NOTIFY_KINDS: { kind: HealthEventKind; label: string }[]` — the catalog, in display order.
  - `defaultNotifyPrefs(): Record<HealthEventKind, boolean>` — all true except `up`, `threshold-clear`.
  - `loadNotifyPrefs(): Record<HealthEventKind, boolean>` / `saveNotifyPrefs(prefs)` — localStorage key `tmuxifier.notifyPrefs`, merged over defaults (a new kind added later defaults on).
  - `enabledKinds(prefs): Set<HealthEventKind>`.
  - `unseenCountFiltered(events, lastSeenSeq, enabled): number` in healthEvents.ts.

**Context:** `unseenCount(events, lastSeenSeq)` (healthEvents.ts) reduces events with `seq > lastSeenSeq`. localStorage keys in this codebase use the `tmuxifier.` prefix (e.g. `tmuxifier.sidebarCollapsed`).

- [ ] **Step 1: Write the failing tests**

Create `test/notifyPrefs.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import { NOTIFY_KINDS, defaultNotifyPrefs, loadNotifyPrefs, saveNotifyPrefs, enabledKinds } from '../src/web/notifyPrefs.ts';

beforeEach(() => {
  globalThis.localStorage = (() => {
    let store = {};
    return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { store = {}; } };
  })();
});

test('the catalog covers every event kind exactly once', () => {
  const kinds = NOTIFY_KINDS.map((k) => k.kind).sort();
  expect(kinds).toEqual(['agent-done', 'agent-input', 'down', 'key-changed', 'needs-auth', 'threshold', 'threshold-clear', 'up']);
});

test('defaults enable everything except up and threshold-clear', () => {
  const d = defaultNotifyPrefs();
  expect(d['down']).toBe(true);
  expect(d['agent-input']).toBe(true);
  expect(d['up']).toBe(false);
  expect(d['threshold-clear']).toBe(false);
});

test('load merges stored prefs over defaults; save round-trips', () => {
  saveNotifyPrefs({ ...defaultNotifyPrefs(), down: false });
  const loaded = loadNotifyPrefs();
  expect(loaded['down']).toBe(false);
  expect(loaded['needs-auth']).toBe(true); // untouched default
});

test('a corrupt/empty store falls back to defaults', () => {
  localStorage.setItem('tmuxifier.notifyPrefs', 'not json');
  expect(loadNotifyPrefs()['down']).toBe(true);
});

test('enabledKinds returns the set of enabled kinds', () => {
  const set = enabledKinds({ ...defaultNotifyPrefs(), down: false });
  expect(set.has('agent-input')).toBe(true);
  expect(set.has('down')).toBe(false);
  expect(set.has('up')).toBe(false);
});
```

Append to `test/healthEvents.test.js`:

```js
test('unseenCountFiltered counts only enabled kinds newer than the cursor', () => {
  const evs = [
    { ...base, seq: 5, kind: 'down' },
    { ...base, seq: 6, kind: 'up' },
    { ...base, seq: 7, kind: 'agent-input' },
  ];
  const enabled = new Set(['down', 'agent-input']);
  expect(unseenCountFiltered(evs, 4, enabled)).toBe(2); // down + agent-input, up excluded
  expect(unseenCountFiltered(evs, 6, enabled)).toBe(1); // only seq 7
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/notifyPrefs.test.js test/healthEvents.test.js`
Expected: FAIL — module missing; `unseenCountFiltered` undefined.

- [ ] **Step 3: Implement**

Create `src/web/notifyPrefs.ts`:

```ts
import type { HealthEventKind } from './api';

// Per-kind browser-notification preferences. Per-browser by design: the
// Notification permission is per-browser, so the filter that rides on it is
// too. Every event still enters the events log regardless of these — prefs
// govern only the events-button counter and browser notifications.
const KEY = 'tmuxifier.notifyPrefs';

export const NOTIFY_KINDS: { kind: HealthEventKind; label: string }[] = [
  { kind: 'agent-input', label: 'Claude waiting for input' },
  { kind: 'agent-done', label: 'Claude finished' },
  { kind: 'down', label: 'Box unreachable' },
  { kind: 'up', label: 'Box recovered' },
  { kind: 'needs-auth', label: 'Box needs login' },
  { kind: 'key-changed', label: 'Host key changed' },
  { kind: 'threshold', label: 'Resource threshold crossed' },
  { kind: 'threshold-clear', label: 'Resource threshold cleared' },
];

// Recovery kinds are noise by default; everything actionable is on.
const OFF_BY_DEFAULT: HealthEventKind[] = ['up', 'threshold-clear'];

export function defaultNotifyPrefs(): Record<HealthEventKind, boolean> {
  const out = {} as Record<HealthEventKind, boolean>;
  for (const { kind } of NOTIFY_KINDS) out[kind] = !OFF_BY_DEFAULT.includes(kind);
  return out;
}

export function loadNotifyPrefs(): Record<HealthEventKind, boolean> {
  const base = defaultNotifyPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return base;
    // Merge over defaults so a kind added in a later version defaults on.
    for (const { kind } of NOTIFY_KINDS) if (typeof stored[kind] === 'boolean') base[kind] = stored[kind];
    return base;
  } catch {
    return base;
  }
}

export function saveNotifyPrefs(prefs: Record<HealthEventKind, boolean>): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode / quota — in-memory only */ }
}

export function enabledKinds(prefs: Record<HealthEventKind, boolean>): Set<HealthEventKind> {
  return new Set(NOTIFY_KINDS.map((k) => k.kind).filter((k) => prefs[k]));
}
```

In `healthEvents.ts`, add next to `unseenCount`:

```ts
import type { HealthEvent, HealthEventKind } from './api';
// (extend the existing import if HealthEventKind isn't already imported)

export function unseenCountFiltered(events: HealthEvent[], lastSeenSeq: number, enabled: Set<HealthEventKind>): number {
  return events.reduce((c, e) => (e.seq > lastSeenSeq && enabled.has(e.kind) ? c + 1 : c), 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/notifyPrefs.test.js test/healthEvents.test.js && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/web/notifyPrefs.ts src/web/healthEvents.ts test/notifyPrefs.test.js test/healthEvents.test.js
git commit -m "feat(web): notification preferences module and filtered unseen counter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Settings → Notifications tab

**Files:**
- Create: `src/web/settingsNotifications.ts`
- Modify: `src/web/settingsUi.ts` (`SettingsTab`, `SECTIONS`)

**Interfaces:**
- Consumes: `NOTIFY_KINDS`, `loadNotifyPrefs`, `saveNotifyPrefs` (Task 5).
- Produces: `renderNotificationsSection(content: HTMLElement): void`, matching the `Section.render` signature `(content, close) => void | Promise<void>`.

**Context:** `settingsUi.ts` — `SettingsTab` is a string-union type; `SECTIONS` is `Record<SettingsTab, { label, render }>`. `renderNetboxSection`/`renderProxmoxSection` are the sibling sections; follow their DOM idiom using `el` from `dom.ts`. No unit test — DOM wiring in a node env; verified by typecheck + live check.

- [ ] **Step 1: Implement the section module**

Create `src/web/settingsNotifications.ts`:

```ts
import { el } from './dom';
import { NOTIFY_KINDS, loadNotifyPrefs, saveNotifyPrefs } from './notifyPrefs';

// Settings → Notifications: browser-notification permission flow plus per-kind
// toggles. Per-browser (localStorage + the Notification permission are both
// per-browser). Every event still enters the events log regardless of these.
export function renderNotificationsSection(content: HTMLElement): void {
  const prefs = loadNotifyPrefs();
  const supported = typeof Notification !== 'undefined';

  const permLine = el('div', { class: 'pve-sub' });
  const enableBtn = el('button', { type: 'button', class: 'pve-primary' }, ['Enable browser notifications']) as HTMLButtonElement;
  const refreshPerm = () => {
    if (!supported) { permLine.textContent = 'This browser does not support notifications.'; enableBtn.style.display = 'none'; return; }
    const p = Notification.permission;
    permLine.textContent = p === 'granted'
      ? 'Browser notifications: enabled.'
      : p === 'denied'
        ? 'Browser notifications are blocked — re-enable them in your browser’s site settings for this page.'
        : 'Browser notifications are not enabled yet.';
    enableBtn.style.display = p === 'default' ? '' : 'none';
  };
  enableBtn.onclick = () => { void Notification.requestPermission().then(refreshPerm); };
  refreshPerm();

  const rows = NOTIFY_KINDS.map(({ kind, label }) => {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = !!prefs[kind];
    cb.onchange = () => { prefs[kind] = cb.checked; saveNotifyPrefs(prefs); };
    return el('label', { class: 'check-field' }, [cb, el('span', {}, [label])]);
  });

  content.replaceChildren(
    el('h3', {}, ['Notifications']),
    permLine,
    enableBtn,
    el('div', { class: 'pve-eyebrow' }, ['Notify me about']),
    ...rows,
    el('p', { class: 'pve-sub' }, ['These settings are per-browser. Every event always appears in the events log regardless of what is selected here.']),
  );
}
```

- [ ] **Step 2: Register the tab**

In `settingsUi.ts`: import the section, extend the type, add the entry:

```ts
import { renderNotificationsSection } from './settingsNotifications';
// ...
export type SettingsTab = 'netbox' | 'proxmox' | 'notifications';
// ...
const SECTIONS: Record<SettingsTab, Section> = {
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
  notifications: { label: 'Notifications', render: (content) => renderNotificationsSection(content) },
};
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck, full suite green (no new unit tests — DOM section).

- [ ] **Step 4: Commit**

```bash
git add src/web/settingsNotifications.ts src/web/settingsUi.ts
git commit -m "feat(ui): Notifications settings tab with per-kind toggles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Fire browser notifications + filter the counter

**Files:**
- Modify: `src/web/main.ts` (imports; `updateEventsBadge`; `pollHealth`)

**Interfaces:**
- Consumes: `loadNotifyPrefs`, `enabledKinds` (Task 5); `unseenCountFiltered` (Task 5); `formatEvent` (already imported).

**Context:** `pollHealth()` (main.ts) fetches `{ events, latestSeq }` into `latestEvents`/`latestEventSeq`, self-heals the seen cursor, and calls `updateEventsBadge()`. `updateEventsBadge()` (main.ts) uses `unseenCount(latestEvents, readLastSeenSeq())`. There is no unit seam for DOM/Notification here — typecheck + live verification.

- [ ] **Step 1: Import prefs + the filtered counter and formatter**

At the top of `main.ts`, extend the healthEvents import and add notifyPrefs:

```ts
import { formatEvent, relTime, unseenCountFiltered } from './healthEvents';
import { loadNotifyPrefs, enabledKinds } from './notifyPrefs';
```

(Remove `unseenCount` from the import if it becomes unused after the badge change; keep `relTime`/`formatEvent`.)

- [ ] **Step 2: Filter the events-button counter**

Change `updateEventsBadge()` to count only enabled kinds:

```ts
function updateEventsBadge() {
  const badge = document.getElementById('events-badge');
  if (!badge) return;
  const n = unseenCountFiltered(latestEvents, readLastSeenSeq(), enabledKinds(loadNotifyPrefs()));
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}
```

- [ ] **Step 3: Fire notifications for newly-arrived enabled events**

Add a module-level cursor near the other poll state (e.g. beside `latestEventSeq`):

```ts
let lastNotifiedSeq = -1; // -1 until the first poll seeds it (no startup flood)
```

In `pollHealth()`, after `latestEventSeq = latestSeq;` and the stale-cursor self-heal, before `updateEventsBadge()`, add:

```ts
    // Browser notifications for newly-arrived enabled events. Seed the cursor
    // on the first poll so a page load never replays history. Fire only when
    // permission is granted and this tab is not focused — a focused tab already
    // shows the badge, so a popup would be redundant.
    // Self-heal like the seen-cursor above: a server events-log reset restarts
    // seq below our cursor, which would otherwise mute notifications forever.
    if (lastNotifiedSeq > latestSeq) lastNotifiedSeq = latestSeq;
    if (lastNotifiedSeq < 0) {
      lastNotifiedSeq = latestSeq;
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
      const enabled = enabledKinds(loadNotifyPrefs());
      for (const e of events) {
        if (e.seq > lastNotifiedSeq && enabled.has(e.kind)) {
          const line = formatEvent(e);
          try {
            const n = new Notification(`Tmuxifier — ${e.label || e.host}`, { body: line.text, tag: `${e.kind}:${e.boxId}` });
            n.onclick = () => { window.focus(); n.close(); };
          } catch { /* notifications unavailable */ }
        }
      }
      lastNotifiedSeq = latestSeq;
    } else {
      lastNotifiedSeq = latestSeq; // keep the cursor current while unfocused-but-denied or focused
    }
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(ui): fire browser notifications for enabled event kinds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (identical: web-module list + health/status notes)
- Modify: `README.md` (notifications passage)

- [ ] **Step 1: CLAUDE.md / AGENTS.md (identical wording in both)**

Add `notifyPrefs.ts` and `settingsNotifications.ts` to the web-module list (near `healthEvents.ts` and `settingsUi.ts` respectively). In the `healthHistory.js` / `status.js` module notes, add a sentence that the status probe now also reports each session's active-pane command and the box clock, and that `healthHistory` derives a per-box agent state for the configured session and emits edge-triggered `agent-input`/`agent-done` events (suppressed while the session is attached). Ground the wording in the shipped code.

- [ ] **Step 2: README**

Near the events/health passage (or the Host Shell section), add a short paragraph: Tmuxifier watches the box's configured tmux session for Claude Code and raises **claude is waiting for input** / **claude finished** events; browser notifications for these and the box-health events can be toggled per kind in **Settings → Notifications** (per-browser; requires granting the browser notification permission, and an HTTPS dashboard). Note that all events always appear in the events log regardless. Placeholders only.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: green (typecheck + full suite + build).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: document agent idle detection and notifications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
