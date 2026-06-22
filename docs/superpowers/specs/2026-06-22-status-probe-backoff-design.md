# Adaptive Status-Probe Backoff Design

## Summary

The dashboard polls `/api/status` every 30s, and the server probes every box over SSH on each
poll. For a box that is failing — unreachable, or up-but-needs-a-password — this means a fresh
SSH handshake (and, for password boxes, a failed authentication) every 30s. On a box running
fail2ban / sshguard / an iptables rate-limit, that repeated hammering gets the Tmuxifier host's
IP banned, which makes the box appear permanently red until the ban expires (the real reason the
remove → wait → re-add ritual "works" is the wait).

This feature adds a per-box backoff so a failing box is probed less and less often, down to a
gentle 5-minute floor. Probing never fully stops, so a box that recovers turns green on its own
within ≤5 minutes with no user action. Engaging a box (opening it, or clicking its reconnect
button) resets the backoff and retries immediately.

## Behavior

Per box, the status checker tracks the number of consecutive failed probes. A **failure** is any
result with `reachable === false` (this includes `needsAuth`). A **success** is `reachable === true`
(tmux running or not).

Probe cadence as a function of consecutive failures:

| Situation | Next-probe interval |
| --- | --- |
| Reachable (healthy) | normal 30s, driven by the client poll |
| Unreachable, `n` consecutive fails | `min(30 * n, 300)` seconds → 30, 60, 90, … escalating to a **300s (5m)** floor |
| `needsAuth` (box up, needs password) | **jumps straight to the 300s floor** on the first occurrence — no escalation |

Rationale for the `needsAuth` jump: a `BatchMode` probe can never authenticate a password box, so
fast probing there only produces failed auths (the exact fail2ban trigger) and can never succeed
until the user types the password. A 5-minute cadence is at most 2 attempts per 10-minute window,
which stays under typical fail2ban thresholds while keeping the dot fresh.

Nothing ever fully stops probing; the 5-minute floor applies to both unreachable and `needsAuth`
boxes. A box sitting at the floor is considered **paused** for UI purposes.

While a box is inside its current interval (`now < nextProbeAt`), `checkBox` returns the box's
**last-known status** without performing an SSH probe.

### Reset to fast (30s) cadence

Backoff state for a box is cleared — returning it to the normal 30s cadence and forcing an
immediate probe — on either of:

- **A successful probe** (`reachable === true`): automatic recovery.
- **User engagement**, via `resetBackoff(boxId)`:
  - **Opening the box as active** (clicking it) — so the user never needs the reconnect button
    when switching to a box.
  - **The ↻ reconnect button** — same reset, for a box the user is *not* currently viewing.

Both engagement paths also trigger an immediate client status refresh so the dot updates at once
rather than on the next 30s poll.

## Architecture

All backoff logic lives **server-side** in `createStatusChecker` (`src/server/status.js`). This is
the only place every box is probed, it persists across the stateless 30s polls, it coordinates a
single source of truth across zero-or-many browser tabs, and it fits the existing
dependency-injection/factory pattern. Client-side state was rejected (dies on tab close, no
cross-tab coordination); on-disk persistence was rejected (YAGNI — probing once on restart is
correct).

`createStatusChecker` gains:

- An in-memory `Map<boxId, { fails, nextProbeAt, paused, last }>`.
- An injectable `now = () => Date.now()` for deterministic time travel in tests.
- Options `stepSec = 30` and `capSec = 300` (constructor args with defaults; not env-exposed for
  now). `capCount = Math.ceil(capSec / stepSec)` is the failure count that reaches the floor.
- A `resetBackoff(boxId)` method that deletes the box's state entry.

`checkBox(box)` logic:

1. Read state `s` for the box. If `s` exists and `now() < s.nextProbeAt`, return
   `{ ...s.last, paused: s.paused, nextProbeAt: s.nextProbeAt }` **without** probing.
2. Otherwise run the existing probe (`buildProbeArgv` + `run`, including the existing
   stale-socket reap on `disabling multiplexing`).
3. On success (`reachable === true`): delete state, return the plain result.
4. On failure: compute the new failure count —
   - `needsAuth` → `fails = capCount` (jump to floor),
   - otherwise → `fails = (s?.fails ?? 0) + 1`.
   Then `intervalSec = min(stepSec * fails, capSec)`, `paused = intervalSec >= capSec`,
   `nextProbeAt = now() + intervalSec * 1000`. Store `{ fails, nextProbeAt, paused, last: result }`
   and return `{ ...result, paused, nextProbeAt }`.

`createStatusChecker` now returns `{ checkBox, resetBackoff }`.

## Data flow

```
client poll (30s) ─▶ GET /api/status ─▶ mapWithConcurrency(boxes, 4)
                                          └─▶ checkBox(box)
                                                ├─ inside interval ─▶ cached last-known (no SSH)
                                                └─ due ─▶ SSH probe ─▶ update/clear state
user opens box / clicks ↻ ─▶ resetBackoff(id) ─▶ next probe runs immediately
                          └─▶ client pollStatus() ─▶ instant dot refresh
```

## API and UI changes

- `src/server/server.js`:
  - `POST /api/boxes/:id/reconnect` calls `statusChecker.resetBackoff(id)` before/after its
    existing reconnect work.
  - The `/term` WebSocket calls `statusChecker.resetBackoff(boxId)` on a successful box attach, so
    opening a box clears its backoff. (`statusChecker` is already injected into `buildServer`.)
- `src/server/index.js`: no behavior change beyond `createStatusChecker` now also returning
  `resetBackoff`; it is already passed into `buildServer`.
- `src/web/api.ts`: extend the `Status` type with optional `paused?: boolean` and
  `nextProbeAt?: number`. No new endpoints.
- `src/web/statusDot.ts`: `dotClassFor` is unchanged (paused boxes keep their `red`/`auth` color).
  `dotTitleFor` appends a hint when `paused` is set — e.g. unreachable →
  `"Unreachable — retrying every 5m; click the box or ↻ to retry now"`, and the `needsAuth` title
  notes it can be re-tried by clicking the box.
- `src/web/main.ts`: after opening a box (`openBox`) and after the reconnect-button handler, call
  the existing `pollStatus()` once for an immediate dot refresh. The 30s `setInterval` poll is
  unchanged.

## Error handling

No new error surfaces. A probe that throws still resolves to `{ reachable: false, error }` as
today, which counts as a failure for backoff. `resetBackoff` on an unknown box id is a no-op.
Backoff state is best-effort and in-memory: a server restart clears it, after which every box is
probed once on the next poll (correct behavior).

## Testing

TDD with real code and injected dependencies (no mocks), per repo convention. New unit tests on
`createStatusChecker` using a scripted `run` (to sequence fail/success results) and an injected
`now` (to advance the clock):

- A box inside its interval is **not** re-probed (`run` not called) and returns the cached status.
- Consecutive unreachable failures escalate the interval 30 → 60 → 90 → … and cap at 300s.
- A `needsAuth` result jumps straight to the 300s interval and sets `paused: true` on the first
  occurrence (no escalation through 30/60/…).
- The floor never becomes a full stop: after the cap, the box is still probed once each 300s
  window.
- A successful probe resets state — the next probe happens immediately and the interval returns to
  the base.
- `resetBackoff(id)` clears state so the next `checkBox` probes immediately.

Plus one server test that `POST /api/boxes/:id/reconnect` invokes `resetBackoff` (and that a
subsequent status probe is no longer throttled).
