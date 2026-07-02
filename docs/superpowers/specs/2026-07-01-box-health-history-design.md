# Box Health History & In-App Events (Phase 1 — no push delivery)

## Summary

The status poller already opens one SSH connection to every box every 30s and, since the
box-health-metrics feature, parses CPU / memory / disk / load off that probe — then keeps only the
**latest** sample: `statusPoller.js` builds a fresh `{ [boxId]: status }` snapshot each cycle and
swaps it in wholesale (`statusPoller.js:16-27`), discarding the previous one. `GET /api/status`
(`server.js:396-412`) serves that single point-in-time map. There is no history and no record of
*when* a box changed state.

This feature retains a bounded, rolling **time-series per box** from the poll we already pay for, and
derives an **events timeline** from state changes (unreachable ↔ reachable, needs-login,
metric-threshold crossings). Both are surfaced in the dashboard: a compact **sparkline** on each box
row and a chronological **Events panel** with an unseen-count badge.

By explicit scope, this phase delivers those signals **in-app only**. It does **not** add browser/OS
notifications, email, or outbound webhooks. Detection emits events through an `onEvent` seam so any of
those delivery channels can bolt on later (Phase 2) without touching the detection or storage code.

No new SSH connections, no change to the probe command, no change to the `/api/status` contract.

## Goals

- Retain a compact per-box series (CPU / mem / disk / up-down) from the existing 30s probe and render
  a trend **sparkline** with zero additional SSH.
- Derive **edge-triggered** events with hysteresis so a box that stays down (or stays hot) produces
  one event, not one per poll.
- Surface events as an **in-app** timeline (the existing Fleet-Jobs-panel pattern) plus a subtle
  "N new" badge — no OS notification, no email, no webhook in this phase.
- Keep the events log **durable across the frequent service restarts** (a restart happens on every
  release, per `CLAUDE.md`); the high-volume series may be ephemeral.
- Keep all detection/formatting **pure and DI-tested with canned snapshots**, matching
  `test/status.test.js` / `test/statusDot.test.js`. No change to the SSH probe or its injection
  surface.
- Degrade gracefully: a box with no metrics (non-Linux, locked-down, or a live terminal with no live
  master) simply shows sparkline gaps and never breaks status.

## Current Context

- `src/server/statusPoller.js`
  - `pollOnce` (`statusPoller.js:16-27`) lists boxes, probes each via `statusChecker.checkBox` under
    bounded concurrency, builds `next`, and swaps `snapshot = next`. The prior snapshot is dropped —
    this is the single seam where history must be captured.
  - `start` seeds one poll then schedules the interval; `pollOnce().catch(() => {})` guards the loop
    (`statusPoller.js:34`).
- `src/server/status.js`
  - `probe` attaches `metrics` to a reachable result via `parseMeta` (`status.js:133-138`); `parseMeta`
    returns `null` when no numeric fields are present (`status.js:45-59`) — the natural "no metrics"
    signal.
  - The live-session branch of `checkBox` probes over the live ControlMaster when it is up, so the box
    you have a terminal open to **still yields metric samples** (`status.js:151-160`); when the master
    is not up it returns `{ reachable:false, needsAuth:true }` (a valid "needs-login" sample).
  - **Backoff returns the last-known status without re-probing** while inside the window
    (`status.js:166-168`). Consecutive polls of a still-down box therefore return an *identical*
    status object — which is exactly why events must be edge-triggered (prev == next ⇒ no event) and
    why a down box's series is naturally flat/gapped rather than noisy.
- `src/server/server.js` — `GET /api/status` returns the poller snapshot verbatim (`server.js:396-412`);
  every `/api/*` route is `preHandler: requireAuth` and `cache-control: no-store` (`server.js:103`).
- `src/web/api.ts` — `Status` / `BoxMetrics` types (`api.ts:6-13`); `api.status()` fetches
  `/api/status?t=<ts>` (cache-busted, `api.ts:54`).
- `src/web/statusDot.ts` — the pure display layer: `metaSegmentsFor` builds the CPU/mem/disk chip
  (`statusDot.ts:80-110`), `cpuLevel` tiers at 70/100 (`statusDot.ts:61`), `cpuLoadPct` normalizes
  load (`statusDot.ts:50`), `classifyError` maps ssh stderr to a plain-language reason
  (`statusDot.ts:20-31`). Reuse these; do not duplicate.
- `src/web/main.ts` — `pollStatus` runs on a 30s `POLL_MS` tick (`main.ts:222`, `main.ts:246`) and
  updates each row's dot + meta line; `createBoxRow` (`main.ts:366`) builds the row; the Fleet Jobs
  overlay (`#fleet-panel`) is the panel pattern to follow for the Events panel.
- `src/server/config.js` — `DEFAULTS` (`config.js:5-44`) + `envCfg` (`config.js:67-99`); numeric knobs
  are clamped (e.g. `termFontSize`, `config.js:121-122`).
- `src/server/fleetStore.js` / `src/server/provisionStore.js` — the debounced, write-never-crashes
  JSON persistence pattern (`fleetStore.js:18-20`) to reuse for the events log.
- `src/server/index.js` — composition root; the poller is created and `buildServer` wired at
  `index.js:92-99`.

## Behavior

### Part A — Rolling series (in-memory)

A new module `src/server/healthHistory.js` exposes `createHealthHistory({ maxSamples, maxEvents,
thresholds, load, save, now })` and two exported pure helpers.

- `sampleOf(status, at)` — pure projection of a `Status` into the minimum a sparkline needs:

  ```
  { t: at, up, tmux?, needsAuth?, cpuPct?, memPct?, diskPct? }
  ```

  - `up = !!status.reachable && !status.needsAuth`.
  - `cpuPct` reuses the display rule: `metrics.cpuPct` when present, else `cpuLoadPct(metrics)`
    (load ÷ cores), else omitted. `memPct = round((1 - memAvailKb/memTotalKb) * 100)` when both are
    present. `diskPct` from `metrics.diskPct` (or `diskUsedKb/diskTotalKb`).
  - Any missing source is **omitted** (not zero) → the sparkline renders a gap, never a false 0%.

- `record(snapshot, boxIds)` — called by the poller each cycle:
  1. For each `boxId` in the current `boxIds`, push `sampleOf(snapshot[boxId], now())` onto that box's
     ring buffer (capped at `maxSamples`, oldest dropped).
  2. Classify transitions against that box's **previous** sample and append any events (Part B).
  3. **Prune** the series + last-sample state for boxes absent from `boxIds` (removed boxes) so memory
     tracks the fleet, mirroring the wholesale-swap drop the poller already does for `/api/status`.

- `getSeries(boxId?)` → one box's `Sample[]`, or the full `{ [boxId]: Sample[] }` map (compact) when
  no id is given.

### Part B — Events (edge-triggered, hysteresis, persisted)

Pure `classifyTransitions(prev, next, thresholds, active)` → `{ events, active }`, where `active` is
the per-box, per-metric "already over threshold" bit-set the module threads across polls (so a
sustained-high metric doesn't re-fire every 30s). Event kinds:

| Condition (prev → next) | Kind | Notes |
| --- | --- | --- |
| `up` → not `up`, `next.needsAuth` | `needs-auth` | purple/auth tier, reads as an action |
| `up` → not `up`, otherwise | `down` | `reason` = `classifyError(next.error)` bucket |
| not `up` → `up` | `up` | recovery |
| metric rises to ≥ warn (was below) | `threshold` | `metric`, `value`; fires **once** |
| metric falls below `warn − hysteresis` | `threshold-clear` | clears the active bit |

- **Edge-only.** Because backoff replays the identical cached status while a box stays down
  (`status.js:166-168`), `prev` deep-equals `next` on those polls and no event is produced — a box
  down for an hour yields exactly one `down` event.
- **Hysteresis.** Disk/mem fire on the up-crossing and only re-arm after dropping below
  `warn − healthThresholdHysteresisPct`. CPU is spiky, so a CPU `threshold` event additionally
  requires the crossing to **persist across two consecutive samples** before firing.
- Each event: `{ seq, boxId, label, host, t, kind, reason?, metric?, value? }`. `seq` is a strictly
  increasing counter; on load it is restored to `1 + max(persisted seq)` (0 when none) so ids stay
  monotonic across restarts.
- Events are **persisted** to `data/health-events.json` via a debounced store that reuses the
  `fleetStore` contract (best-effort, write-never-crashes, `fleetStore.js:18-20`), capped at
  `maxEvents`. Rationale: events fire only on edges, so writes are rare and cheap, and a down/up
  timeline that survives the frequent release restarts is where the durable value lives. The
  per-sample series stays in-memory (high-volume, cheap to rebuild within `maxSamples × interval`).

### Part C — Read API (auth-gated, served from memory)

Two new `preHandler: requireAuth` routes, no new SSH, no change to `/api/status`:

- `GET /api/health/series` → `{ [boxId]: Sample[] }` for row sparklines. `?box=<id>` → that box's
  series (for an expanded detail view).
- `GET /api/health/events?since=<seq>` → `{ events: HealthEvent[], latestSeq }`, returning events with
  `seq > since` newest-first (or the most recent `maxEvents` when `since` is absent).

### Part D — Client (in-app only)

- `src/web/api.ts` gains `healthSeries()` / `healthEvents(since?)` and the `Sample` / `HealthEvent`
  types.
- The existing 30s `pollStatus` tick (`main.ts:246`) also fetches `/api/health/series` (one extra
  same-origin GET) and renders a compact **sparkline** on each reachable row via a new pure
  `src/web/sparkline.ts` (a `Sample[]` → SVG polyline/path builder; gaps for missing samples). The row
  shows the **CPU** series by default; a small dashboard toggle (persisted in `localStorage`) cycles
  cpu/mem/disk. The `?box=` detail view can show all three.
- A new **Events panel** (`src/web/healthEvents.ts` + a `#fleet-panel`-style overlay) is opened from an
  "Events" button added to the sidebar `fleet-actions` cluster. It lists events newest-first with an
  icon, a plain-language line, and a relative timestamp, e.g.:
  - `🔴 web-prod — unreachable (Port-22 banned — fail2ban?) · 3m ago`
  - `🟢 db-01 — recovered · 1m ago`
  - `💾 backup-02 — disk 92% · 12m ago`

  The panel polls `?since=latestSeq` on the same tick and shows an unobtrusive **count badge** of
  unseen events on the button; opening the panel records `lastSeenSeq` in `localStorage` and clears the
  badge. This badge is a passive in-app indicator, **not** an OS notification.
- Explicitly **not** in the client: `Notification` API, sound, email, or any outbound request beyond
  the two same-origin GETs.

## Data Model

```ts
// src/web/api.ts (mirrors the server’s emitted shapes; wire keys == field names)
interface Sample {
  t: number;                 // epoch ms of the poll
  up: boolean;               // reachable && !needsAuth
  tmux?: boolean;
  needsAuth?: boolean;
  cpuPct?: number; memPct?: number; diskPct?: number;   // omitted when the source was absent
}
type EventKind = 'down' | 'up' | 'needs-auth' | 'threshold' | 'threshold-clear';
interface HealthEvent {
  seq: number;               // strictly increasing; monotonic across restarts
  boxId: string; label: string; host: string;
  t: number;                 // epoch ms
  kind: EventKind;
  reason?: string;           // classifyError bucket for `down`
  metric?: 'cpu' | 'mem' | 'disk';
  value?: number;            // percent, for threshold kinds
}
```

New config (`config.js` `DEFAULTS` + `envCfg`, each clamped like `termFontSize`):

| Config | Env | Default |
| --- | --- | --- |
| `healthHistoryMax` (samples/box) | `TMUXIFIER_HEALTH_HISTORY_MAX` | `120` (~1h at 30s) |
| `healthEventsMax` (events retained) | `TMUXIFIER_HEALTH_EVENTS_MAX` | `200` |
| `healthCpuWarnPct` | `TMUXIFIER_HEALTH_CPU_WARN_PCT` | `90` |
| `healthMemWarnPct` | `TMUXIFIER_HEALTH_MEM_WARN_PCT` | `90` |
| `healthDiskWarnPct` | `TMUXIFIER_HEALTH_DISK_WARN_PCT` | `90` |
| `healthThresholdHysteresisPct` | `TMUXIFIER_HEALTH_HYSTERESIS_PCT` | `5` |

## Architecture & Data Flow

```
status poll (30s) ─▶ statusPoller.pollOnce  (unchanged: one SSH conn per box, bounded concurrency)
                      ├─ snapshot = next                         (existing; /api/status serves it)
                      └─ history.record(next, boxIds)            (NEW; wrapped so it can never
                             ├─ ring.push(sampleOf(status))       break the snapshot swap)
                             │        [in-memory, cap maxSamples, prune removed boxes]
                             └─ classifyTransitions(prev, sample) ─▶ events (+ debounced persist)

client 30s tick ─▶ GET /api/status              (dots + meta line — existing)
               ├─▶ GET /api/health/series       (per-row sparkline — NEW)
               └─▶ GET /api/health/events?since= (Events panel + unseen badge — NEW)

Phase 2 seam (NOT built here): history.onEvent(e) ─▶ [ browser Notification | webhook POST | email ]
```

All parsing/formatting is pure and tested with canned input; no new SSH connection, no probe change,
no `/api/status` change.

## Server Changes

- **New `src/server/healthHistory.js`** — `createHealthHistory(...)` plus exported pure `sampleOf` and
  `classifyTransitions`. In-memory ring buffers + last-sample/active state; injects `load`/`save`
  (events store) and `now` for testability. Exposes `record`, `getSeries`, `getEvents({ since })`, and
  an `onEvent(cb)` registration that is the Phase-2 delivery seam (unused in Phase 1).
- **New `src/server/healthEventsStore.js`** — debounced `data/health-events.json` persistence, a copy
  of the `fleetStore.js` shape (mkdir, coalesced writes, corrupt/missing → empty, write errors
  swallowed).
- **`src/server/statusPoller.js`** — accept an optional `history` dep; after the snapshot swap:

  ```js
  snapshot = next;
  if (history) { try { history.record(next, boxes.map((b) => b.id)); } catch { /* never break the poll */ } }
  ```

  Swapping `snapshot` **before** `record` guarantees `/api/status` availability is independent of the
  history path. Existing tests (no `history`) are unaffected.
- **`src/server/config.js`** — add the six knobs to `DEFAULTS` and `envCfg`, clamped to sane ranges.
- **`src/server/server.js`** — inject `history` into `buildServer`; add the two auth-gated GET routes.
- **`src/server/index.js`** — build `healthEventsStore` + `healthHistory`, pass `history` into
  `createStatusPoller` and `buildServer` (`index.js:92-99`).

## Client / UI Changes

- `src/web/api.ts` — `Sample` / `HealthEvent` types + `healthSeries()` / `healthEvents(since?)`.
- **New `src/web/sparkline.ts`** — pure `sparklinePath(samples, metric, opts)` → an SVG path/points
  string (handles empty, single-point, and gapped series). Unit-tested, no DOM.
- **New `src/web/healthEvents.ts`** — pure `formatEvent(e, now)` (icon + phrase + relative time, reusing
  `classifyError`) and `unseenCount(events, lastSeenSeq)`. Unit-tested.
- `src/web/main.ts` — extend `pollStatus` to fetch the series and render a row sparkline; add the
  Events panel toggle (in `fleet-actions`), render, `?since` polling, and the `localStorage`
  `lastSeenSeq` badge.
- `src/web/style.css` — `.spark` sizing/stroke; `.events-panel` / `.event-row` reusing the existing
  `ok|warn|crit|auth` severity vars; `.events-badge`.

## Error Handling & Portability

- Absent metrics (non-Linux, locked-down, or live-terminal-no-master) → `sampleOf` omits those fields
  → sparkline gap; never throws (mirrors `parseMeta` → `null`, `status.js:45`).
- `history.record` is wrapped in the poller so any defect in history can never affect `/api/status`;
  the snapshot is swapped first.
- The events store follows the `fleetStore` best-effort contract: a corrupt/missing file starts empty
  (`fleetStore.js` load path), and write failures (full disk) are swallowed rather than crashing the
  poll — at worst the timeline loses its newest entries.
- Bounded memory: series capped at `maxSamples` per box and pruned for removed boxes; events capped at
  `maxEvents`. Worst case ≈ `boxes × maxSamples` small objects.
- `seq` monotonicity is restored from the persisted max on boot, so client `?since` cursors stay valid
  across restarts.

## Testing

TDD, real code + DI, canned input — matching `test/status.test.js` / `test/statusDot.test.js` /
`test/statusPoller.test.js`.

- **`test/healthHistory.test.js`**
  - `sampleOf`: reachable-with-metrics → cpu/mem/disk present; `needsAuth` → `up:false`, `needsAuth`;
    unreachable → `up:false`, metrics omitted; missing sources omitted (never 0).
  - `classifyTransitions`: `down` / `up` / `needs-auth` edges; **no event when prev == next** (the
    backoff-cache case); `threshold` fires once on cross-up and only re-arms after the hysteresis
    clear; CPU threshold requires two consecutive over-samples; `threshold-clear` on drop.
  - `record`: caps the ring at `maxSamples`; prunes series for a box absent from `boxIds`; assigns
    strictly increasing `seq`; `getEvents({ since })` filters correctly.
  - `seq` restored to `1 + max(persisted)` on load.
- **`test/statusPoller.test.js`** — an injected `history` stub receives `record(snapshot, boxIds)` each
  `pollOnce`; a `history.record` that **throws** does not prevent `getSnapshot()` from returning the
  new snapshot.
- **`test/config.test.js`** — the six knobs default correctly, override via env, and clamp.
- **`test/server.test.js`** — `/api/health/series` and `/api/health/events` are 401 without the cookie;
  return the injected history's data; `?since` and `?box` filter; shapes match the data model.
- **Client** — `test/sparkline.test.js` (path over canned samples incl. gaps/empty/single);
  `test/healthEvents.test.js` (down/up/threshold phrasing, relative time via injected `now`, unseen
  count).
- **E2E (optional, existing patterns)** — a row shows a sparkline; opening the Events panel lists a
  transition; the badge clears on open.

## Not Included (deferred)

- **No browser/OS notifications, no email, and no outbound webhook** (per this phase's scope). The
  `onEvent` seam exists so Phase 2 can add any of them without touching detection or storage.
- **No persistence of the per-sample series** — in-memory only; it rebuilds within `maxSamples ×
  interval` after a restart. Only the **events** log is persisted.
- No per-box configurable thresholds (global defaults only this phase).
- No long-term / downsampled retention, rollups, or full graphs (RRD-style) — the sparkline is the
  last `maxSamples` window only.
- No new SSH, no probe change, no change to the `/api/status` shape or the status dot/meta line
  semantics.
- No metrics for a box whose live terminal has no live master yet (unchanged: that path is
  needs-auth / no-metrics by design, `status.js:151-160`).

## Acceptance Criteria

- Each reachable box row shows a sparkline built from up to `maxSamples` poll samples, with gaps where
  metrics were absent, and **no additional SSH connections** beyond the existing 30s probe.
- A box transitioning unreachable ↔ reachable (or into needs-login) produces exactly one edge event
  each way; a box that stays down produces a single `down` event, not one per poll.
- Disk/mem crossing its warn threshold emits one `threshold` event and does not re-fire until it clears
  past the hysteresis margin; CPU requires a sustained (two-poll) crossing.
- The Events panel lists events newest-first with plain-language reasons (reusing `classifyError`),
  relative timestamps, and an unseen-count badge that clears on open — **all in-app; no OS
  notification, email, or webhook is emitted**.
- The events log survives a service restart (persisted, capped at `maxEvents`, `seq` strictly
  increasing); the series may reset on restart.
- New detection/formatting helpers are pure and covered by unit tests with canned input; an injected
  `history` that throws never affects `/api/status`.
- Every new config knob has a documented default, an env override, and is clamped to a sane range.
