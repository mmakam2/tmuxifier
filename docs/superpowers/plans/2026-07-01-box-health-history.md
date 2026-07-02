# Box Health History & In-App Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: `docs/superpowers/specs/2026-07-01-box-health-history-design.md`.

**Goal:** Retain a bounded, rolling health time-series per box from the 30s status poll we already run, derive an edge-triggered events timeline (down / up / needs-login / metric-threshold), and surface both in the dashboard — a per-row sparkline and an Events panel with an unseen-count badge. **In-app only:** no browser/OS notifications, no email, no outbound webhook this phase; detection emits through an `onEvent` seam so those bolt on later.

**Architecture:** A new `createHealthHistory` (server-side, factory + DI) owns per-box ring buffers (in-memory) and an events log (persisted to `data/health-events.json` via a `fleetStore`-style debounced writer). The status poller calls `history.record(snapshot, boxes)` after it swaps the snapshot; `record` appends a compact `Sample` per box and runs the pure `classifyTransitions` to emit `HealthEvent`s. Two auth-gated read routes (`GET /api/health/series`, `GET /api/health/events`) serve them from memory. The web client polls both on the existing 30s tick, drawing an SVG sparkline per row (`sparkline.ts`) and rendering the Events panel (`healthEvents.ts`). No new SSH, no probe change, no change to the `/api/status` contract.

**Tech Stack:** Node 20+ ESM, Fastify, vitest (unit + integration, real code + DI, no mocks), Playwright (e2e), TypeScript + xterm.js web client bundled by Vite.

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+. Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first; tests use **real code + dependency injection**, never a mocking library. Inject collaborators (`now`, `load`, `save`); spy with tiny hand-written stubs that push into a `calls[]` array.
- `loadConfig` is **pure and injectable** — never read `process.env`/`process.cwd()` inside it or its tests; pass explicit `{ env, cwd }`.
- **Detection/formatting stay pure** (`sampleOf`, `classifyTransitions`, `sparkline`, `formatEvent`, `relTime`, `unseenCount`), tested with canned input like `test/statusDot.test.js` / `test/status.test.js`.
- **`record` must never break the status snapshot.** The poller swaps `snapshot` *before* calling `history.record`, and wraps the call in `try/catch`.
- **No push delivery this phase.** No `Notification` API, no email, no webhook, no outbound request. The only new network calls are two same-origin `GET`s. `createHealthHistory` exposes `onEvent(cb)` as the Phase-2 seam; it stays unused in Phase 1.
- **Events fire on edges only.** Because status backoff replays the last-known status without re-probing (`status.js:166-168`), `prev` equals `next` on those polls and no event is produced. The **first** sample for a box seeds state and emits nothing (a restart must not replay "down"/"over" for boxes already in that state).
- No PII in committed code/tests/docs — use `example.com`, RFC1918 IPs, generic box names (`web-01`, `db-01`).
- Vitest discovers `test/**/*.test.js`; `fileParallelism: false`. Web `.ts` helpers are imported directly from `.test.js` (see `test/statusDot.test.js`). Test timeout 20000.
- Conventional-commit messages (`feat(health): …`, `test(health): …`). Commit after each task.
- New config defaults (copied verbatim into Task 1): `healthHistoryMax=120`, `healthEventsMax=200`, `healthCpuWarnPct=90`, `healthMemWarnPct=90`, `healthDiskWarnPct=90`, `healthThresholdHysteresisPct=5`.
- Data model (every task uses exactly these field names):
  - `Sample`: `{ t:number, up:boolean, tmux?:boolean, needsAuth?:boolean, cpuPct?:number, memPct?:number, diskPct?:number }` — a missing metric is **omitted**, never `0`.
  - `HealthEvent`: `{ seq:number, boxId:string, label:string, host:string, t:number, kind:'down'|'up'|'needs-auth'|'threshold'|'threshold-clear', reason?:string, metric?:'cpu'|'mem'|'disk', value?:number }`.
  - Threshold state is in-memory per box (`{ cpu, cpuStreak, mem, disk }`), never persisted.

---

### Task 1: Config knobs for health history

**Files:**
- Modify: `src/server/config.js` (DEFAULTS ~line 5-44; envCfg ~line 67-99; clamp near line 119-122)
- Modify: `.env.example` (append a new section)
- Modify: `README.md` (config table)
- Test: `test/config.test.js`

**Interfaces:**
- Produces on `loadConfig(...)`: `healthHistoryMax`, `healthEventsMax`, `healthCpuWarnPct`, `healthMemWarnPct`, `healthDiskWarnPct`, `healthThresholdHysteresisPct` (all numbers, clamped).

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.js`:

```js
test('health history knobs have defaults, override via env, and clamp', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.healthHistoryMax).toBe(120);
  expect(d.healthEventsMax).toBe(200);
  expect(d.healthCpuWarnPct).toBe(90);
  expect(d.healthMemWarnPct).toBe(90);
  expect(d.healthDiskWarnPct).toBe(90);
  expect(d.healthThresholdHysteresisPct).toBe(5);
  const e = loadConfig({}, {
    env: {
      TMUXIFIER_HEALTH_HISTORY_MAX: '60',
      TMUXIFIER_HEALTH_EVENTS_MAX: '50',
      TMUXIFIER_HEALTH_CPU_WARN_PCT: '80',
      TMUXIFIER_HEALTH_MEM_WARN_PCT: '85',
      TMUXIFIER_HEALTH_DISK_WARN_PCT: '95',
      TMUXIFIER_HEALTH_HYSTERESIS_PCT: '3',
    },
    cwd: '/app',
  });
  expect(e.healthHistoryMax).toBe(60);
  expect(e.healthEventsMax).toBe(50);
  expect(e.healthCpuWarnPct).toBe(80);
  expect(e.healthMemWarnPct).toBe(85);
  expect(e.healthDiskWarnPct).toBe(95);
  expect(e.healthThresholdHysteresisPct).toBe(3);
  // out-of-range values fall back to the default (clamped), not passed through
  const c = loadConfig({}, { env: { TMUXIFIER_HEALTH_HISTORY_MAX: '5', TMUXIFIER_HEALTH_CPU_WARN_PCT: '999' }, cwd: '/app' });
  expect(c.healthHistoryMax).toBe(120); // below the sane floor → default
  expect(c.healthCpuWarnPct).toBe(90);  // above 100 → default
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js -t "health history knobs"`
Expected: FAIL (`expected undefined to be 120`).

- [ ] **Step 3: Add the defaults**

In `src/server/config.js`, inside `DEFAULTS` (after the `fleetMaxOutputBytes` line, before the Proxmox block):

```js
  // Box health history + in-app events. The status poll already collects
  // CPU/mem/disk every statusPollMs; keep a rolling per-box series (maxSamples)
  // and an edge-triggered events log (maxEvents, persisted). Thresholds drive
  // the "metric crossed a limit" events with a hysteresis clear margin.
  healthHistoryMax: 120,   // samples retained per box (~1h at 30s)
  healthEventsMax: 200,    // events retained in data/health-events.json
  healthCpuWarnPct: 90,
  healthMemWarnPct: 90,
  healthDiskWarnPct: 90,
  healthThresholdHysteresisPct: 5,
```

- [ ] **Step 4: Map the env vars**

In `src/server/config.js`, inside the `envCfg = clean({ ... })` object (after the fleet lines):

```js
    healthHistoryMax: e.TMUXIFIER_HEALTH_HISTORY_MAX ? Number(e.TMUXIFIER_HEALTH_HISTORY_MAX) : undefined,
    healthEventsMax: e.TMUXIFIER_HEALTH_EVENTS_MAX ? Number(e.TMUXIFIER_HEALTH_EVENTS_MAX) : undefined,
    healthCpuWarnPct: e.TMUXIFIER_HEALTH_CPU_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_CPU_WARN_PCT) : undefined,
    healthMemWarnPct: e.TMUXIFIER_HEALTH_MEM_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_MEM_WARN_PCT) : undefined,
    healthDiskWarnPct: e.TMUXIFIER_HEALTH_DISK_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_DISK_WARN_PCT) : undefined,
    healthThresholdHysteresisPct: e.TMUXIFIER_HEALTH_HYSTERESIS_PCT ? Number(e.TMUXIFIER_HEALTH_HYSTERESIS_PCT) : undefined,
```

- [ ] **Step 5: Clamp to sane ranges**

In `src/server/config.js`, just before `return merged;` (near the `termFontSize` clamp), add:

```js
  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : dflt;
  };
  merged.healthHistoryMax = clampInt(merged.healthHistoryMax, 10, 5000, 120);
  merged.healthEventsMax = clampInt(merged.healthEventsMax, 10, 5000, 200);
  merged.healthCpuWarnPct = clampInt(merged.healthCpuWarnPct, 1, 100, 90);
  merged.healthMemWarnPct = clampInt(merged.healthMemWarnPct, 1, 100, 90);
  merged.healthDiskWarnPct = clampInt(merged.healthDiskWarnPct, 1, 100, 90);
  merged.healthThresholdHysteresisPct = clampInt(merged.healthThresholdHysteresisPct, 0, 50, 5);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/config.test.js -t "health history knobs"`
Expected: PASS.

- [ ] **Step 7: Document the knobs**

In `.env.example`, append:

```
# --- Box health history & in-app events --------------------------------------
# The status poll already collects CPU/mem/disk; these retain a rolling per-box
# series (for row sparklines) and an edge-triggered events log (persisted to
# data/health-events.json). No notifications are sent — in-app display only.
#TMUXIFIER_HEALTH_HISTORY_MAX=120
#TMUXIFIER_HEALTH_EVENTS_MAX=200
# Metric-threshold events fire when a box crosses these (percent), with a
# hysteresis margin before the "cleared" event re-arms them.
#TMUXIFIER_HEALTH_CPU_WARN_PCT=90
#TMUXIFIER_HEALTH_MEM_WARN_PCT=90
#TMUXIFIER_HEALTH_DISK_WARN_PCT=90
#TMUXIFIER_HEALTH_HYSTERESIS_PCT=5
```

In `README.md`, add to the config table after the fleet rows:

```
| health history samples/box | `TMUXIFIER_HEALTH_HISTORY_MAX` | `120` |
| health events retained | `TMUXIFIER_HEALTH_EVENTS_MAX` | `200` |
| health cpu/mem/disk warn % | `TMUXIFIER_HEALTH_{CPU,MEM,DISK}_WARN_PCT` | `90` |
| health threshold hysteresis % | `TMUXIFIER_HEALTH_HYSTERESIS_PCT` | `5` |
```

- [ ] **Step 8: Commit**

```bash
git add src/server/config.js test/config.test.js .env.example README.md
git commit -m "feat(health): add box health history config knobs"
```

---

### Task 2: `healthEventsStore` — persist events to `data/health-events.json`

**Files:**
- Create: `src/server/healthEventsStore.js`
- Modify: `CLAUDE.md` and `AGENTS.md` (the `data/` inventory line)
- Test: `test/healthEventsStore.test.js`

**Interfaces:**
- Produces: `createHealthEventsStore({ dataDir }) -> { load(): HealthEvent[], save(events): void }`. Synchronous (events fire rarely; the writer is called fire-and-forget). `load` returns `[]` on missing/corrupt file; `save` is best-effort and never throws. Mirrors `fleetStore.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/healthEventsStore.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHealthEventsStore } from '../src/server/healthEventsStore.js';

test('load returns [] when the file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  expect(createHealthEventsStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips and creates the data dir', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  const dir = path.join(base, 'data');
  const store = createHealthEventsStore({ dataDir: dir });
  const events = [{ seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', t: 1, kind: 'down' }];
  store.save(events);
  expect(store.load()).toEqual(events);
  await expect(fs.stat(path.join(dir, 'health-events.json'))).resolves.toBeTruthy();
});

test('load returns [] on a corrupt file instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-health-'));
  await fs.writeFile(path.join(dir, 'health-events.json'), 'not json');
  expect(createHealthEventsStore({ dataDir: dir }).load()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthEventsStore.test.js`
Expected: FAIL (`Cannot find module '.../healthEventsStore.js'`).

- [ ] **Step 3: Implement `healthEventsStore.js`**

Create `src/server/healthEventsStore.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

// Persist health events to data/health-events.json. Synchronous on purpose: the
// history manager calls save() only on an edge (a state change), so writes are
// rare, and the file is capped to healthEventsMax. The whole data/ dir is already
// gitignored, so this file needs no .gitignore entry. Same best-effort contract
// as fleetStore.js — persistence must never crash the status poll.
export function createHealthEventsStore({ dataDir }) {
  const file = path.join(dataDir, 'health-events.json');
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    save(events) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(events, null, 2));
      } catch {
        // Best effort: persistence must never crash a poll cycle.
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthEventsStore.test.js`
Expected: PASS (all three).

- [ ] **Step 5: Update the self-contained data/ inventory docs**

In `CLAUDE.md` (Self-contained principle), extend the `data/` line to add `health-events.json` (in-app health event log). Make the identical edit in `AGENTS.md`.

- [ ] **Step 6: Commit**

```bash
git add src/server/healthEventsStore.js test/healthEventsStore.test.js CLAUDE.md AGENTS.md
git commit -m "feat(health): persist health events to data/health-events.json"
```

---

### Task 3: Pure helpers — `sampleOf` + `classifyTransitions`

**Files:**
- Create: `src/server/healthHistory.js` (helpers first; the factory is Task 4)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- Produces (pure, exported):
  - `sampleOf(status, at) -> Sample` — projects a status result into a compact sample; missing metrics omitted.
  - `initThresholdState() -> { cpu:false, cpuStreak:0, mem:false, disk:false }`.
  - `classifyTransitions(prev, next, thresholds, state) -> { events: {kind, metric?, value?}[], state }` — reachability/auth edges (stateless) + metric-threshold edges (hysteresis; cpu needs 2 consecutive over-samples). `prev` nullish ⇒ **seed only** (no events).

- [ ] **Step 1: Write the failing tests**

Create `test/healthHistory.test.js`:

```js
import { test, expect } from 'vitest';
import { sampleOf, classifyTransitions, initThresholdState } from '../src/server/healthHistory.js';

const TH = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 };

test('sampleOf projects reachable status with metrics', () => {
  const s = sampleOf({ reachable: true, tmux: true, metrics: { cpuPct: 40, memTotalKb: 1000, memAvailKb: 250, diskPct: 61 } }, 5);
  expect(s).toEqual({ t: 5, up: true, tmux: true, cpuPct: 40, memPct: 75, diskPct: 61 });
});

test('sampleOf marks needsAuth and unreachable as down, omitting metrics', () => {
  expect(sampleOf({ reachable: false, needsAuth: true }, 1)).toEqual({ t: 1, up: false, needsAuth: true });
  expect(sampleOf({ reachable: false, error: 'x' }, 2)).toEqual({ t: 2, up: false });
});

test('sampleOf omits absent metrics instead of zeroing, and falls back to load when no cgroup', () => {
  const s = sampleOf({ reachable: true, metrics: { load1: 2, cpus: 4 } }, 3); // no cpuPct, no cpuUsageUsec
  expect(s.cpuPct).toBe(50);       // 2/4 → 50%
  expect('memPct' in s).toBe(false);
  expect('diskPct' in s).toBe(false);
});

test('classifyTransitions: reachability edges', () => {
  expect(classifyTransitions({ up: true }, { up: false }, TH, initThresholdState()).events).toEqual([{ kind: 'down' }]);
  expect(classifyTransitions({ up: true }, { up: false, needsAuth: true }, TH, initThresholdState()).events).toEqual([{ kind: 'needs-auth' }]);
  expect(classifyTransitions({ up: false }, { up: true }, TH, initThresholdState()).events).toEqual([{ kind: 'up' }]);
  expect(classifyTransitions({ up: true }, { up: true }, TH, initThresholdState()).events).toEqual([]);
});

test('classifyTransitions: first sample (no prev) seeds without emitting', () => {
  const r = classifyTransitions(undefined, { up: true, diskPct: 95 }, TH, undefined);
  expect(r.events).toEqual([]);
  expect(r.state.disk).toBe(true); // seeded "already over" so it will not re-fire
});

test('classifyTransitions: disk crosses up once, then clears past hysteresis', () => {
  let st = initThresholdState();
  let r = classifyTransitions({ up: true, diskPct: 80 }, { up: true, diskPct: 92 }, TH, st);
  expect(r.events).toEqual([{ kind: 'threshold', metric: 'disk', value: 92 }]);
  st = r.state;
  r = classifyTransitions({ up: true, diskPct: 92 }, { up: true, diskPct: 91 }, TH, st); // still high, no re-fire
  expect(r.events).toEqual([]);
  st = r.state;
  r = classifyTransitions({ up: true, diskPct: 91 }, { up: true, diskPct: 84 }, TH, st); // < 90-5
  expect(r.events).toEqual([{ kind: 'threshold-clear', metric: 'disk', value: 84 }]);
});

test('classifyTransitions: cpu requires two consecutive over-samples', () => {
  let st = initThresholdState();
  let r = classifyTransitions({ up: true, cpuPct: 50 }, { up: true, cpuPct: 95 }, TH, st);
  expect(r.events).toEqual([]);            // first over-sample: wait
  st = r.state;
  r = classifyTransitions({ up: true, cpuPct: 95 }, { up: true, cpuPct: 96 }, TH, st);
  expect(r.events).toEqual([{ kind: 'threshold', metric: 'cpu', value: 96 }]); // sustained → fire
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthHistory.test.js`
Expected: FAIL (`Cannot find module '.../healthHistory.js'`).

- [ ] **Step 3: Implement the helpers**

Create `src/server/healthHistory.js`:

```js
// Mirrors src/web/statusDot.ts `cpuLoadPct`: normalize load average by core count
// to a percent, only usable when both are present. Kept in sync by hand (server
// is .js, that helper is .ts) — the display and the sample must read the same.
function cpuLoadPct(m) {
  if (!m || m.load1 == null || !m.cpus) return undefined;
  return Math.round((m.load1 / m.cpus) * 100);
}

// Project a status result (from the poll snapshot) into the compact numbers a
// sparkline needs. A missing source is OMITTED (never 0) so the sparkline renders
// a gap, not a false floor. `up` = reachable and not needs-login.
export function sampleOf(status, at) {
  const s = status || {};
  const sample = { t: at, up: !!s.reachable && !s.needsAuth };
  if (s.tmux != null) sample.tmux = !!s.tmux;
  if (s.needsAuth) sample.needsAuth = true;
  const m = s.metrics;
  if (m) {
    // Prefer true cgroup utilization; fall back to load only when there is no
    // cgroup counter at all; omit while a cgroup host is warming up (one sample).
    let cpu;
    if (m.cpuPct != null) cpu = m.cpuPct;
    else if (m.cpuUsageUsec == null) cpu = cpuLoadPct(m);
    if (cpu != null) sample.cpuPct = cpu;
    if (m.memTotalKb && m.memAvailKb != null) sample.memPct = Math.round((1 - m.memAvailKb / m.memTotalKb) * 100);
    const disk = m.diskPct != null
      ? m.diskPct
      : (m.diskTotalKb && m.diskUsedKb != null ? Math.round((m.diskUsedKb / m.diskTotalKb) * 100) : undefined);
    if (disk != null) sample.diskPct = disk;
  }
  return sample;
}

export function initThresholdState() {
  return { cpu: false, cpuStreak: 0, mem: false, disk: false };
}

// Pure edge detector. Reachability/auth edges compare prev↔next (stateless).
// Metric-threshold edges use `state` + hysteresis so a box that stays hot fires
// once; cpu additionally needs two consecutive over-samples (it is spiky). A
// nullish `prev` means this is the box's first sample: seed the threshold state
// to match current values but emit nothing (a restart must not replay
// down/over for boxes already in that state). Returns { events, state }.
export function classifyTransitions(prev, next, thresholds, state) {
  const st = { ...(state || initThresholdState()) };
  const events = [];
  const warn = { cpu: thresholds.cpu, mem: thresholds.mem, disk: thresholds.disk };
  const clear = thresholds.hysteresis;

  if (!prev) {
    st.mem = !!(next.up && next.memPct != null && next.memPct >= warn.mem);
    st.disk = !!(next.up && next.diskPct != null && next.diskPct >= warn.disk);
    st.cpu = !!(next.up && next.cpuPct != null && next.cpuPct >= warn.cpu);
    st.cpuStreak = st.cpu ? 2 : 0;
    return { events, state: st };
  }

  // reachability / auth edges
  if (prev.up && !next.up) events.push(next.needsAuth ? { kind: 'needs-auth' } : { kind: 'down' });
  else if (!prev.up && next.up) events.push({ kind: 'up' });
  else if (!prev.up && !next.up && !prev.needsAuth && next.needsAuth) events.push({ kind: 'needs-auth' });

  // mem / disk: immediate crossing with hysteresis clear
  for (const metric of ['mem', 'disk']) {
    const v = next[`${metric}Pct`];
    if (v == null || !next.up) continue;
    if (!st[metric] && v >= warn[metric]) { st[metric] = true; events.push({ kind: 'threshold', metric, value: v }); }
    else if (st[metric] && v < warn[metric] - clear) { st[metric] = false; events.push({ kind: 'threshold-clear', metric, value: v }); }
  }

  // cpu: require two consecutive over-samples before firing (spiky metric)
  const cpu = next.cpuPct;
  if (cpu == null || !next.up) {
    st.cpuStreak = 0;
  } else if (cpu >= warn.cpu) {
    st.cpuStreak = Math.min(2, st.cpuStreak + 1);
    if (!st.cpu && st.cpuStreak >= 2) { st.cpu = true; events.push({ kind: 'threshold', metric: 'cpu', value: cpu }); }
  } else {
    st.cpuStreak = 0;
    if (st.cpu && cpu < warn.cpu - clear) { st.cpu = false; events.push({ kind: 'threshold-clear', metric: 'cpu', value: cpu }); }
  }

  return { events, state: st };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthHistory.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): pure sample + transition helpers"
```

---

### Task 4: `createHealthHistory` — ring buffers, events log, read API

**Files:**
- Modify: `src/server/healthHistory.js` (add the factory)
- Test: `test/healthHistory.test.js` (add cases)

**Interfaces:**
- Produces: `createHealthHistory({ maxSamples, maxEvents, thresholds, load, save, now, onEvent }) -> { record(snapshot, boxes), getSeries(boxId?), getEvents({ since }), onEvent(cb) }`.
  - `record(snapshot, boxes)` — appends a `Sample` per box (ring capped `maxSamples`), emits `HealthEvent`s (seq-stamped, persisted via `save`, dispatched to listeners), and prunes series/state for boxes absent from `boxes`.
  - `getSeries(boxId)` → that box's `Sample[]`; `getSeries()` → `{ [boxId]: Sample[] }`.
  - `getEvents({ since })` → `{ events: HealthEvent[] /* newest-first, seq>since */, latestSeq }`.
  - `onEvent(cb)` — register a delivery listener (the Phase-2 seam; unused in Phase 1).
  - seq is restored to `1 + max(persisted seq)` on construction.

- [ ] **Step 1: Write the failing tests**

Add to `test/healthHistory.test.js`:

```js
import { createHealthHistory } from '../src/server/healthHistory.js';

const BOXES = [{ id: 'b1', label: 'web-01', host: 'h1' }, { id: 'b2', label: 'db-01', host: 'h2' }];
function fixedNow(seq) { let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; }

test('record builds per-box series capped at maxSamples', () => {
  const h = createHealthHistory({ maxSamples: 2, now: (() => { let t = 0; return () => (t += 10); })() });
  for (let i = 0; i < 3; i++) h.record({ b1: { reachable: true, metrics: { cpuPct: i } } }, [BOXES[0]]);
  const s = h.getSeries('b1');
  expect(s).toHaveLength(2);                 // oldest dropped
  expect(s.map((x) => x.cpuPct)).toEqual([1, 2]);
});

test('record emits a down event on transition, persists it, and stamps increasing seq', () => {
  const saved = [];
  const h = createHealthHistory({ save: (evs) => saved.push(evs.length), now: (() => { let t = 0; return () => (t += 1); })() });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);                       // seed — no event
  h.record({ b1: { reachable: false, error: 'kex_exchange_identification' } }, [BOXES[0]]); // down
  const { events, latestSeq } = h.getEvents({});
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', kind: 'down', reason: 'kex_exchange_identification' });
  expect(latestSeq).toBe(1);
  expect(saved[saved.length - 1]).toBe(1); // persisted on the edge
});

test('record fires no event when the status is unchanged (backoff replay)', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: false, error: 'x' } }, [BOXES[0]]); // seed
  h.record({ b1: { reachable: false, error: 'x' } }, [BOXES[0]]); // identical → no edge
  expect(h.getEvents({}).events).toHaveLength(0);
});

test('getEvents newest-first and filters by since', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: true } }, [BOXES[0]]);           // seed
  h.record({ b1: { reachable: false } }, [BOXES[0]]);          // seq 1 down
  h.record({ b1: { reachable: true } }, [BOXES[0]]);           // seq 2 up
  const all = h.getEvents({});
  expect(all.events.map((e) => e.kind)).toEqual(['up', 'down']); // newest-first
  expect(h.getEvents({ since: 1 }).events.map((e) => e.seq)).toEqual([2]);
});

test('record prunes series + state for removed boxes', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: true }, b2: { reachable: true } }, BOXES);
  expect(Object.keys(h.getSeries())).toEqual(['b1', 'b2']);
  h.record({ b1: { reachable: true } }, [BOXES[0]]); // b2 gone
  expect(Object.keys(h.getSeries())).toEqual(['b1']);
});

test('seq is restored from the persisted log', () => {
  const h = createHealthHistory({ load: () => [{ seq: 41, boxId: 'b1', label: 'web-01', host: 'h1', t: 1, kind: 'down' }] });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);  // seed
  h.record({ b1: { reachable: false } }, [BOXES[0]]); // next event
  expect(h.getEvents({}).events[0].seq).toBe(42);
});

test('onEvent listeners receive each emitted event (Phase-2 delivery seam)', () => {
  const got = [];
  const h = createHealthHistory({ onEvent: (e) => got.push(e.kind) });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);
  h.record({ b1: { reachable: false } }, [BOXES[0]]);
  expect(got).toEqual(['down']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthHistory.test.js -t "record\|getEvents\|seq\|onEvent"`
Expected: FAIL (`createHealthHistory is not a function`).

- [ ] **Step 3: Implement the factory**

Append to `src/server/healthHistory.js`:

```js
export function createHealthHistory({
  maxSamples = 120,
  maxEvents = 200,
  thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 },
  load = () => [],
  save = () => {},
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  const series = new Map();      // boxId -> Sample[]
  const lastSample = new Map();  // boxId -> Sample
  const threshState = new Map(); // boxId -> threshold state
  const loaded = load();
  const events = Array.isArray(loaded) ? loaded.slice(-maxEvents) : []; // oldest first
  let seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const listeners = new Set();
  if (typeof onEvent === 'function') listeners.add(onEvent);

  function emit(e) {
    e.seq = ++seq;
    events.push(e);
    while (events.length > maxEvents) events.shift();
    save(events);
    // Phase-2 delivery seam: browser/webhook/email would subscribe here. A
    // listener error must never break the poll.
    for (const fn of listeners) { try { fn(e); } catch { /* ignore */ } }
  }

  return {
    record(snapshot, boxes) {
      const at = now();
      const present = new Set();
      for (const box of boxes) {
        present.add(box.id);
        const status = snapshot[box.id];
        if (!status) continue;
        const sample = sampleOf(status, at);
        const ring = series.get(box.id) || [];
        ring.push(sample);
        while (ring.length > maxSamples) ring.shift();
        series.set(box.id, ring);

        const prev = lastSample.get(box.id);
        const { events: evs, state } = classifyTransitions(prev, sample, thresholds, threshState.get(box.id));
        threshState.set(box.id, state);
        lastSample.set(box.id, sample);
        for (const ev of evs) {
          const out = { boxId: box.id, label: box.label || box.host, host: box.host, t: at, kind: ev.kind };
          if (ev.metric) { out.metric = ev.metric; out.value = ev.value; }
          if (ev.kind === 'down' && status.error) out.reason = status.error;
          emit(out);
        }
      }
      for (const id of [...series.keys()]) {
        if (!present.has(id)) { series.delete(id); lastSample.delete(id); threshState.delete(id); }
      }
    },
    getSeries(boxId) {
      if (boxId) return series.get(boxId) || [];
      const out = {};
      for (const [id, ring] of series) out[id] = ring;
      return out;
    },
    getEvents({ since = 0 } = {}) {
      const filtered = since ? events.filter((e) => e.seq > since) : events.slice();
      return { events: filtered.reverse(), latestSeq: seq };
    },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthHistory.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): health history manager (series, events, read API)"
```

---

### Task 5: Feed the poller into history

**Files:**
- Modify: `src/server/statusPoller.js` (optional `history` dep; call `record` after the snapshot swap)
- Test: `test/statusPoller.test.js` (add cases)

**Interfaces:**
- Consumes: optional `history.record(snapshot, boxes)`.
- Produces: unchanged public surface. `record` runs after `snapshot = next`, wrapped so a throw can never affect `getSnapshot()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/statusPoller.test.js`:

```js
test('pollOnce feeds the snapshot and the boxes to history.record', async () => {
  const calls = [];
  const boxes = [{ id: 'a', host: 'ha', label: 'web-01' }];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    history: { record: (snap, bx) => calls.push([snap, bx]) },
  });
  await poller.pollOnce();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toEqual({ a: { reachable: true } });
  expect(calls[0][1]).toBe(boxes);
});

test('a throwing history.record never prevents the snapshot swap', async () => {
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'a', host: 'ha' }]),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    history: { record: () => { throw new Error('boom'); } },
  });
  await expect(poller.pollOnce()).resolves.toBeTruthy();
  expect(poller.getSnapshot()).toEqual({ a: { reachable: true } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/statusPoller.test.js -t history`
Expected: FAIL (`history` not consumed).

- [ ] **Step 3: Wire `history` into the poller**

In `src/server/statusPoller.js`, add `history = null` to the destructured params, and in `pollOnce` after `snapshot = next;`:

```js
    snapshot = next;
    if (history) {
      // History must never affect status availability: the snapshot is already
      // swapped, so a bug here can't blank /api/status.
      try { history.record(next, boxes); } catch { /* swallowed on purpose */ }
    }
    return snapshot;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/statusPoller.test.js`
Expected: PASS (all, including the two new).

- [ ] **Step 5: Commit**

```bash
git add src/server/statusPoller.js test/statusPoller.test.js
git commit -m "feat(health): record every status poll into health history"
```

---

### Task 6: REST routes for series + events

**Files:**
- Modify: `src/server/server.js` (add `history` to `buildServer` params; two routes after `/api/status`)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `history.getSeries(boxId?)`, `history.getEvents({ since })`.
- Produces (both `preHandler: requireAuth`):
  - `GET /api/health/series[?box=<id>]` → `{ [boxId]: Sample[] }`
  - `GET /api/health/events[?since=<seq>]` → `{ events: HealthEvent[], latestSeq }`

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js` a stub factory (near the other stubs):

```js
function historyStub() {
  return {
    getSeries: (boxId) => (boxId ? { [boxId]: [{ t: 1, up: true, cpuPct: 10 }] }
      : { b1: [{ t: 1, up: true, cpuPct: 10 }], b2: [{ t: 1, up: false }] }),
    getEvents: ({ since = 0 } = {}) => ({ events: [{ seq: 2, boxId: 'b1', label: 'web-01', host: 'h1', t: 9, kind: 'down' }].filter((e) => e.seq > since), latestSeq: 2 }),
  };
}
```

Then:

```js
test('GET /api/health/series requires auth', async () => {
  app = await makeApp({ history: historyStub() });
  expect((await app.inject({ method: 'GET', url: '/api/health/series' })).statusCode).toBe(401);
});

test('GET /api/health/series returns the full map or one box', async () => {
  app = await makeApp({ history: historyStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const all = await app.inject({ method: 'GET', url: '/api/health/series', headers });
  expect(all.statusCode).toBe(200);
  expect(Object.keys(all.json())).toEqual(['b1', 'b2']);
  const one = await app.inject({ method: 'GET', url: '/api/health/series?box=b1', headers });
  expect(Object.keys(one.json())).toEqual(['b1']);
});

test('GET /api/health/events returns events + latestSeq, filtered by since', async () => {
  app = await makeApp({ history: historyStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const all = await app.inject({ method: 'GET', url: '/api/health/events', headers });
  expect(all.json()).toMatchObject({ latestSeq: 2 });
  expect(all.json().events).toHaveLength(1);
  const since = await app.inject({ method: 'GET', url: '/api/health/events?since=2', headers });
  expect(since.json().events).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js -t health`
Expected: FAIL (routes not registered).

- [ ] **Step 3: Add `history` to `buildServer` params**

In `src/server/server.js`, add `history` to the destructured `buildServer({ ... })` params (near `fleetManager`).

- [ ] **Step 4: Add the routes**

In `src/server/server.js`, immediately after the `GET /api/status` handler:

```js
  // Rolling per-box health series (for row sparklines) and the in-app events
  // timeline. Served from the in-memory history the poller feeds — no new SSH,
  // no change to /api/status. `?box=` narrows the series to one box.
  app.get('/api/health/series', { preHandler: requireAuth }, async (req) => {
    const box = req.query?.box;
    return box ? { [box]: history.getSeries(box) } : history.getSeries();
  });
  app.get('/api/health/events', { preHandler: requireAuth }, async (req) => {
    const since = Number(req.query?.since) || 0;
    return history.getEvents({ since });
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js -t health`
Expected: PASS.

Run: `npx vitest run test/server.test.js`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(health): REST routes for health series + events"
```

---

### Task 7: Wire history into the entrypoint

**Files:**
- Modify: `src/server/index.js`

**Interfaces:**
- Consumes: `createHealthEventsStore` (Task 2), `createHealthHistory` (Tasks 3-4), `config.health*` (Task 1).
- Produces: a `history` passed into both `createStatusPoller` and `buildServer`.

- [ ] **Step 1: Add imports**

In `src/server/index.js`, near the other store/manager imports:

```js
import { createHealthEventsStore } from './healthEventsStore.js';
import { createHealthHistory } from './healthHistory.js';
```

- [ ] **Step 2: Construct history before the poller**

In `src/server/index.js`, **above** the `const statusPoller = createStatusPoller({...})` block:

```js
const healthEventsStore = createHealthEventsStore({ dataDir: config.dataDir });
const history = createHealthHistory({
  maxSamples: config.healthHistoryMax,
  maxEvents: config.healthEventsMax,
  thresholds: {
    cpu: config.healthCpuWarnPct,
    mem: config.healthMemWarnPct,
    disk: config.healthDiskWarnPct,
    hysteresis: config.healthThresholdHysteresisPct,
  },
  load: () => healthEventsStore.load(),
  save: (events) => healthEventsStore.save(events),
});
```

- [ ] **Step 3: Pass `history` to the poller and the server**

In `src/server/index.js`, add `history` to the `createStatusPoller({ ... })` deps and to the `buildServer({ ... })` call.

- [ ] **Step 4: Verify it boots and the full suite passes**

Run: `node --check src/server/index.js`
Expected: no output.

Run: `npx vitest run`
Expected: PASS (entire suite).

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js
git commit -m "feat(health): wire health history into the entrypoint"
```

---

### Task 8: Web API client — types + methods

**Files:**
- Modify: `src/web/api.ts`

**Interfaces:**
- Produces: `Sample`, `HealthEvent`, `HealthEventKind` types; `api.healthSeries()`, `api.healthEvents(since?)`.

- [ ] **Step 1: Add the types**

In `src/web/api.ts`, after the `Status` interface:

```ts
export interface Sample { t: number; up: boolean; tmux?: boolean; needsAuth?: boolean; cpuPct?: number; memPct?: number; diskPct?: number; }
export type HealthEventKind = 'down' | 'up' | 'needs-auth' | 'threshold' | 'threshold-clear';
export interface HealthEvent {
  seq: number; boxId: string; label: string; host: string; t: number;
  kind: HealthEventKind; reason?: string; metric?: 'cpu' | 'mem' | 'disk'; value?: number;
}
```

- [ ] **Step 2: Add the methods**

In `src/web/api.ts`, inside the `api` object (after `status()`):

```ts
  async healthSeries() { return j<Record<string, Sample[]>>(await fetch(`/api/health/series?t=${Date.now()}`)); },
  async healthEvents(since = 0) { return j<{ events: HealthEvent[]; latestSeq: number }>(await fetch(`/api/health/events?since=${since}&t=${Date.now()}`)); },
```

- [ ] **Step 3: Verify the bundle type-builds**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(health): web api client for series + events"
```

---

### Task 9: Pure sparkline builder (`sparkline.ts`)

**Files:**
- Create: `src/web/sparkline.ts`
- Test: `test/sparkline.test.js`

**Interfaces:**
- Produces: `sparkline(samples: Sample[], metric: 'cpuPct'|'memPct'|'diskPct', opts?): string` → an SVG `path` `d` string (viewBox `0 0 w h`), with gaps where the metric is missing. Empty string for `< 2` plotted points.

- [ ] **Step 1: Write the failing tests**

Create `test/sparkline.test.js`:

```js
import { test, expect } from 'vitest';
import { sparkline } from '../src/web/sparkline.ts';

const S = (cpu) => ({ t: 0, up: true, cpuPct: cpu });

test('returns empty for fewer than two plotted points', () => {
  expect(sparkline([], 'cpuPct')).toBe('');
  expect(sparkline([S(10)], 'cpuPct')).toBe('');
});

test('builds a moveto+lineto path across the series', () => {
  const d = sparkline([S(0), S(50), S(100)], 'cpuPct', { w: 10, h: 10, max: 100 });
  expect(d.startsWith('M')).toBe(true);
  expect((d.match(/L/g) || []).length).toBe(2); // three points → one M, two L
});

test('gaps (missing metric) split the path into separate segments', () => {
  const d = sparkline([S(10), { t: 0, up: false }, S(20), S(30)], 'cpuPct', { w: 10, h: 10 });
  expect((d.match(/M/g) || []).length).toBe(2); // a new subpath starts after the gap
});

test('clamps values into the box', () => {
  const d = sparkline([S(-20), S(200)], 'cpuPct', { w: 10, h: 10, max: 100 });
  expect(d).not.toMatch(/-/);        // no negative coordinates
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sparkline.test.js`
Expected: FAIL (`Cannot find module '.../sparkline.ts'`).

- [ ] **Step 3: Implement `sparkline.ts`**

Create `src/web/sparkline.ts`:

```ts
import type { Sample } from './api';

// Build an SVG path `d` for a metric series. Coordinates map i→x left-to-right
// and value→y (inverted, 0 at the bottom). A missing metric is a gap: the pen
// lifts and a new subpath (M) starts after it, so a down box shows a break, not
// a line to zero. Returns '' when fewer than two points can be plotted.
export function sparkline(
  samples: Sample[],
  metric: 'cpuPct' | 'memPct' | 'diskPct',
  opts: { w?: number; h?: number; max?: number } = {},
): string {
  const w = opts.w ?? 64, h = opts.h ?? 16, max = opts.max ?? 100;
  const vals = samples.map((s) => s[metric]);
  const plotted = vals.filter((v) => v != null).length;
  if (plotted < 2) return '';
  const n = vals.length;
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * (w - 1)) + 0.5;
  const y = (v: number) => h - 0.5 - (Math.max(0, Math.min(max, v)) / max) * (h - 1);
  let d = ''; let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sparkline.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/sparkline.ts test/sparkline.test.js
git commit -m "feat(health): pure svg sparkline builder"
```

---

### Task 10: Pure event formatters (`healthEvents.ts`)

**Files:**
- Create: `src/web/healthEvents.ts`
- Test: `test/healthEvents.test.js`

**Interfaces:**
- Produces:
  - `formatEvent(e: HealthEvent) -> { icon: string; text: string; level: 'ok'|'warn'|'crit'|'auth' }` (reuses `classifyError` for `down`).
  - `relTime(t: number, now: number) -> string`.
  - `unseenCount(events: HealthEvent[], lastSeenSeq: number) -> number`.

- [ ] **Step 1: Write the failing tests**

Create `test/healthEvents.test.js`:

```js
import { test, expect } from 'vitest';
import { formatEvent, relTime, unseenCount } from '../src/web/healthEvents.ts';

const base = { seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', t: 0 };

test('formatEvent phrases each kind with the right level', () => {
  expect(formatEvent({ ...base, kind: 'up' })).toMatchObject({ level: 'ok', text: 'web-01 — recovered' });
  expect(formatEvent({ ...base, kind: 'needs-auth' })).toMatchObject({ level: 'auth' });
  expect(formatEvent({ ...base, kind: 'down', reason: 'kex_exchange_identification' }))
    .toMatchObject({ level: 'crit', text: 'web-01 — unreachable (Port-22 rate-limited or banned (fail2ban?))' });
  expect(formatEvent({ ...base, kind: 'threshold', metric: 'disk', value: 92 }))
    .toMatchObject({ level: 'warn', text: 'web-01 — disk 92%' });
  expect(formatEvent({ ...base, kind: 'threshold-clear', metric: 'cpu', value: 40 }))
    .toMatchObject({ level: 'ok' });
});

test('relTime renders coarse buckets from an injected now', () => {
  expect(relTime(10_000, 12_000)).toBe('2s ago');
  expect(relTime(0, 120_000)).toBe('2m ago');
  expect(relTime(0, 3 * 3600_000)).toBe('3h ago');
});

test('unseenCount counts events past the last-seen seq', () => {
  const evs = [{ ...base, seq: 3 }, { ...base, seq: 2 }, { ...base, seq: 1 }];
  expect(unseenCount(evs, 1)).toBe(2);
  expect(unseenCount(evs, 3)).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthEvents.test.js`
Expected: FAIL (`Cannot find module '.../healthEvents.ts'`).

- [ ] **Step 3: Implement `healthEvents.ts`**

Create `src/web/healthEvents.ts`:

```ts
import type { HealthEvent } from './api';
import { classifyError } from './statusDot';

export type EventLevel = 'ok' | 'warn' | 'crit' | 'auth';
export interface EventLine { icon: string; text: string; level: EventLevel; }

const METRIC_LABEL = { cpu: 'CPU', mem: 'memory', disk: 'disk' } as const;
const METRIC_ICON = { cpu: '🔥', mem: '🧠', disk: '💾' } as const;

export function formatEvent(e: HealthEvent): EventLine {
  const name = e.label || e.host;
  switch (e.kind) {
    case 'up': return { icon: '🟢', text: `${name} — recovered`, level: 'ok' };
    case 'needs-auth': return { icon: '🟣', text: `${name} — needs login`, level: 'auth' };
    case 'down': {
      const reason = classifyError(e.reason);
      const suffix = reason && reason !== 'Unreachable' ? ` (${reason})` : '';
      return { icon: '🔴', text: `${name} — unreachable${suffix}`, level: 'crit' };
    }
    case 'threshold':
      return { icon: METRIC_ICON[e.metric!], text: `${name} — ${METRIC_LABEL[e.metric!]} ${e.value}%`, level: 'warn' };
    case 'threshold-clear':
      return { icon: '✅', text: `${name} — ${METRIC_LABEL[e.metric!]} back to ${e.value}%`, level: 'ok' };
  }
}

export function relTime(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function unseenCount(events: HealthEvent[], lastSeenSeq: number): number {
  return events.reduce((c, e) => (e.seq > lastSeenSeq ? c + 1 : c), 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/healthEvents.test.js`
Expected: PASS. (If the `down` expectation mismatches, copy the exact string `classifyError` returns for `kex_exchange_identification` from `src/web/statusDot.ts` — do not weaken the assertion.)

- [ ] **Step 5: Commit**

```bash
git add src/web/healthEvents.ts test/healthEvents.test.js
git commit -m "feat(health): pure event line formatters"
```

---

### Task 11: Dashboard integration — row sparkline + Events panel

**Files:**
- Modify: `src/web/main.ts`, `src/web/style.css`, `src/web/index.html`

**Interfaces:**
- Consumes: `api.healthSeries()`, `api.healthEvents(since)`, `sparkline`, `formatEvent`, `relTime`, `unseenCount`.
- No new server surface. Follow the existing **Fleet Jobs panel** wiring (`#fleet-panel`, its toggle in the `fleet-actions` cluster, and its polling loop) as the template.

- [ ] **Step 1: Row sparkline**
  - In `createBoxRow` (`main.ts:366`), add a `.spark` `<span>` inside the `.box-main` column, under the `.box-meta` line.
  - In `pollStatus` (`main.ts:246`), after fetching status, also `const series = await api.healthSeries()` on the same tick, then for each row set the sparkline: build `<svg viewBox="0 0 64 16" class="spark-svg"><path d="${sparkline(series[id] || [], metric)}"/></svg>` (skip when the path is empty). Default `metric = 'cpuPct'`; store the current choice in `localStorage` (`tmuxifier.sparkMetric`) and cycle cpu→mem→disk on click of the sparkline (or a small control) — a pure `localStorage` preference, no server call.
  - Guard the extra fetch: if `healthSeries()` rejects, skip the sparkline update this tick (status must still render).

- [ ] **Step 2: Events panel + badge**
  - Add an **Events** button to the sidebar `fleet-actions` cluster and an `#events-panel` overlay in `index.html` mirroring `#fleet-panel`.
  - Keep `lastSeenSeq` in `localStorage` (`tmuxifier.eventsSeen`). On each `pollStatus` tick call `api.healthEvents(0)` (cheap; capped at `healthEventsMax`), then set the button badge to `unseenCount(events, lastSeenSeq)` (hide when 0).
  - Opening the panel renders the events newest-first via `formatEvent` + `relTime(e.t, Date.now())`, colouring each row by `level` (reuse the `ok|warn|crit|auth` CSS vars), and writes the newest `latestSeq` into `lastSeenSeq` (clearing the badge).
  - This badge is a passive in-app indicator only — **do not** call the `Notification` API or emit any outbound request.

- [ ] **Step 3: Styles**
  - In `style.css`: `.spark-svg { width: 64px; height: 16px; }` with `path { fill: none; stroke: var(--accent); stroke-width: 1; }`; `.events-panel` / `.event-row` copying `.fleet-panel` layout; `.event-row.crit/.warn/.auth/.ok` using the existing severity vars; `.events-badge` a small count pill on the button.

- [ ] **Step 4: Build and manual smoke**

Run: `npm run build`
Expected: build succeeds.

Manual (see the deployment health-check in `CLAUDE.md`): rebuild + restart the service, open the dashboard, confirm rows show a sparkline and the Events panel lists a transition (e.g. reconnect a box to force an `up`, or point a box at a bad port to force a `down`), and the badge clears on open. No browser notification should appear.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/style.css src/web/index.html
git commit -m "feat(health): row sparklines + in-app events panel"
```

---

### Task 12: E2E — sparkline renders, events list, badge clears (optional)

**Files:**
- Create/Modify: `test/e2e/health.spec.ts` (follow `test/e2e/fleet.spec.ts` patterns + `test/e2e/global-setup.js`)

**Interfaces:**
- Consumes: the e2e harness (a local sshd-backed box).

- [ ] **Step 1: Write the e2e**
  - Load the dashboard; assert a box row eventually shows a `.spark-svg path` with a non-empty `d`.
  - Force a transition (stop/point the box's sshd at a dead port, or reconnect) and assert the Events panel lists a row with the expected phrase; assert the unseen badge appears then clears after opening. Do **not** weaken assertions if the environment lacks sshd — skip with a note, matching the other integration/e2e prerequisites.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- health`
Expected: PASS (or skipped-with-note when no sshd).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/health.spec.ts
git commit -m "test(health): e2e for sparklines + events panel"
```

---

### Task 13: Docs + final verification

**Files:**
- Modify: `README.md` (a short "Box health history" note under the health/status section), `CLAUDE.md` + `AGENTS.md` (a one-line mention of `healthHistory.js` / `healthEventsStore.js` in the architecture list, kept in sync)

- [ ] **Step 1: Document the feature**
  - README: one paragraph — the dashboard keeps a rolling per-box CPU/mem/disk trend (sparkline) and an in-app Events timeline of down/up/needs-login/threshold changes, all from the existing 30s poll; **no notifications are sent** (a future phase). List the config knobs already added in Task 1.
  - CLAUDE.md / AGENTS.md architecture bullets: add `healthHistory.js` (ring-buffer series + edge-triggered events; `onEvent` is the deferred delivery seam) and `healthEventsStore.js` (debounced `data/health-events.json`).

- [ ] **Step 2: Full suite + build**

Run: `npx vitest run`
Expected: PASS (entire unit + integration suite).

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs(health): document box health history & in-app events"
```

---

## Deferred (Phase 2 — explicitly not in this plan)

- **All push delivery** — browser/OS `Notification`, email, and outbound webhooks. They subscribe to `history.onEvent(cb)`; add a delivery module + config (e.g. `TMUXIFIER_ALERT_WEBHOOK`) without touching detection or storage.
- **Persisting the per-sample series** (in-memory only this phase; only the events log is persisted).
- **Per-box configurable thresholds**, long-term/downsampled retention, and full graphs beyond the rolling sparkline window.
- No change to the SSH probe, the `/api/status` shape, or the status dot/meta-line semantics.
