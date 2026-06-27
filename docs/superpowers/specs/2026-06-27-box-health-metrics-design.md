# Box Health Metrics, Red-Box Diagnostics, And Activity Badges

## Summary

The status poller already opens an SSH connection to every box every 30s and runs a `tmux ls`
probe over it, but the dashboard renders only a single colored dot per box. Three pieces of
high-value information are collected (or are one cheap line away) yet discarded:

1. The **real failure reason** (`status.error`) is captured but never shown — a red box is just
   "Unreachable", so diagnosing *why* (host-side fail2ban ban vs. sshd down vs. host offline vs.
   needs-login) is guesswork.
2. **Host health** (load / memory / disk) is one extra line on the probe we already pay for, but
   isn't collected at all.
3. The probe already returns each session's **`attached` / `activity`**, but the client type drops
   both, so there's no signal that a background session has produced new output.

This feature surfaces all three: a classified failure hint, host metrics from an extended probe,
and an unseen-activity badge — rendered as an always-visible second line under each box label, with
no new SSH connections and no new endpoint.

## Goals

- Tell the user *why* a box is red, in plain language, from the error the probe already returns.
- Add load / memory / disk at a glance, piggybacked on the existing 30s probe (no extra SSH).
- Flag boxes whose background tmux sessions have new activity since the user last opened them.
- Keep the probe remote command a static, non-interpolated string (no new injection surface).
- Degrade gracefully: a non-Linux or locked-down box still reports status; metrics just go absent.
- Stay inside the dependency-injected, pure-and-tested-with-canned-input conventions of the repo.

## Current Context

- `src/server/status.js`
  - `PROBE_REMOTE` (`status.js:5`) runs `tmux ls -F '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}'`.
  - `parseTmuxSessions` (`status.js:21`) splits each line on `:` into `{name, windows, attached, activity}`,
    skipping blank lines and `__NO_TMUX__`.
  - `probe()` (`status.js:44`) already classifies failures into `{ reachable:false, needsAuth, error }`
    and `{ reachable:true, tmux, sessions }`.
  - The live-session branch of `checkBox` (`status.js:81`) returns a synthetic status with `sessions: []`
    and runs **no** probe (so metrics/activity are naturally absent for a box you have a terminal open to).
- `src/server/statusPoller.js` builds the `{ [boxId]: status }` snapshot every 30s; `GET /api/status`
  (`server.js:402`) returns it verbatim.
- `src/web/api.ts:6` — `Status.sessions` is typed `{ name; windows }[]`, dropping `attached`/`activity`;
  `Status.error` exists but is unused.
- `src/web/statusDot.ts` — `dotClassFor` / `dotTitleFor` are the single source of truth for the dot;
  `dotTitleFor` ignores `st.error`.
- `src/web/main.ts` — `createBoxRow` (`main.ts:366`) appends `check, dotEl, nameEl, refreshBtn, edit, rm`
  to a flexbox `.box` row (`.name { flex: 1 }`); `pollStatus` (`main.ts:222`) updates only the dot's
  class and title each poll.

## Behavior

### Part A — Red-box diagnostics (no probe change)

A new pure `classifyError(error)` maps the raw ssh stderr the probe already captured to a short hint:

| Error signature (case-insensitive) | Hint |
| --- | --- |
| `kex_exchange_identification`, `connection reset by peer`, `banner exchange` | Port-22 rate-limited or banned (host-side fail2ban?) |
| `connection refused` | sshd down or wrong port |
| `connection timed out`, `timed out`, `no route to host`, `network is unreachable` | Host offline or network down |
| `remote host identification has changed`, `host key` | Host key changed — verify the box |
| anything else | the raw error string, trimmed |

`needsAuth` is already handled separately (it's a status flag, not an error string) and keeps its
existing "Needs login" wording. `dotTitleFor` appends the classified hint on red dots; the existing
`paused` wording is preserved and composes with it.

### Part B — Host metrics (one extra probe line)

`PROBE_REMOTE` is extended to emit a single sentinel line **before** the tmux output:

```
__META__ load1=0.42 load5=0.31 load15=0.20 cpus=4 memTotalKb=8160000 memAvailKb=3120000 diskTotalKb=51474912 diskUsedKb=31200000 diskPct=61 uptimeSec=183942
web:2:1:1718000000        ← existing tmux output, unchanged
```

- **`KEY=VALUE` space-separated**, not fixed positions — a metric whose source is unavailable is
  simply omitted, and the parser tolerates any subset. This is the key robustness decision: a
  missing `/proc` file must not shift the remaining fields.
- Sources are POSIX-portable and cheap, each wrapped so failure prints nothing:
  `/proc/loadavg` (load1/5/15), `nproc` (cpus), `/proc/meminfo` (`MemTotal`/`MemAvailable`),
  `df -P /` (total/used/percent — `-P` for stable columns), `/proc/uptime` (seconds).
- The remote command stays a **static constant** with no box-field interpolation, exactly like
  today's `PROBE_REMOTE`, so `assertBoxSafe` + the existing argv builder remain the whole injection
  surface.

Representative remote (final form is a one-line constant; values absent on any failure):

```sh
printf '__META__';
{ read l1 l5 l15 _ </proc/loadavg 2>/dev/null && printf ' load1=%s load5=%s load15=%s' "$l1" "$l5" "$l15"; } 2>/dev/null;
c=$(nproc 2>/dev/null) && printf ' cpus=%s' "$c";
awk '/^MemTotal:/{printf " memTotalKb=%s",$2} /^MemAvailable:/{printf " memAvailKb=%s",$2}' /proc/meminfo 2>/dev/null;
df -P / 2>/dev/null | awk 'NR==2{sub(/%/,"",$5); printf " diskTotalKb=%s diskUsedKb=%s diskPct=%s",$2,$3,$5}';
u=$(awk '{printf "%d",$1}' /proc/uptime 2>/dev/null) && printf ' uptimeSec=%s' "$u";
printf '\n';
# ...then the existing: if command -v tmux ...; then tmux ls -F '...'; else echo __NO_TMUX__; fi
```

Parsing:

- `parseTmuxSessions` additionally skips any line starting with `__META__`.
- A new pure `parseMeta(stdout)` finds the `__META__` line, splits the `KEY=VALUE` tokens, keeps only
  finite numbers, and returns the metrics object — or `null` when the line is absent or yields no
  numeric fields.
- `probe()` attaches `metrics` to a reachable result (and omits it when `parseMeta` returns `null`).
  The live-session branch (`status.js:81`) has no probe output, so metrics stay absent while a
  terminal is open to that box — acceptable; the open terminal *is* the live view.

### Part C — Unseen-activity badge

`session_activity` is a per-session epoch second of last activity; `attached` says whether a client
is connected. Two pure helpers:

- `latestActivity(st)` → the max `activity` across the box's sessions (`0` when none).
- `hasUnseenActivity(st, seen)` → `latestActivity(st) > (seen ?? 0)`.

The client keeps a `{ [boxId]: number }` last-seen map in `localStorage`. A box shows a small badge
when it is **not** the active tab and `hasUnseenActivity` is true. Opening a box (`openBox`) writes
that box's current `latestActivity` into the map (clearing its badge), and while a box is the active
tab each poll keeps its last-seen advanced — so switching away starts clean rather than immediately
re-badging.

The badge is for boxes you have *not* opened a terminal to but whose tmux sessions are doing work
(the probe sees their activity timestamps); the box you're attached to reports `sessions: []` and so
never badges itself.

## Data Model

`Status` (`src/web/api.ts`) gains:

```ts
interface BoxMetrics {
  load1?: number; load5?: number; load15?: number; cpus?: number;
  memTotalKb?: number; memAvailKb?: number;
  diskTotalKb?: number; diskUsedKb?: number; diskPct?: number;
  uptimeSec?: number;
}
interface Status {
  // ...existing fields...
  sessions?: { name: string; windows: number; attached?: boolean; activity?: number }[];
  metrics?: BoxMetrics;
  // error?: string already exists; now actually consumed by the client
}
```

Wire keys equal the `BoxMetrics` keys, so there is no server-side rename table.

## Architecture & Data Flow

```
status poll (30s) ─▶ GET /api/status ─▶ statusPoller snapshot
                                          └─▶ checkBox → probe (one SSH conn, now also emits __META__)
                                                ├─ parseTmuxSessions  (skips __META__)
                                                └─ parseMeta          → status.metrics
client pollStatus() ─▶ per row: dotClassFor/dotTitleFor (dot) + metaLineFor (2nd line) + activity badge
openBox(box) ─▶ lastSeenActivity[boxId] = latestActivity(st)   (clears that box's badge)
```

All parsing and formatting are pure functions tested with canned input; no new endpoint, no new
SSH connection, no new server module.

## Server Changes (`src/server/status.js`)

- Extend `PROBE_REMOTE` with the `__META__` block (still a static string).
- `parseTmuxSessions`: also skip lines starting with `__META__`.
- Add `parseMeta(stdout)` (exported for unit tests).
- `probe()`: attach `metrics: parseMeta(res.stdout)` to reachable results when non-null.

No change to `statusPoller.js`, `server.js`, `sshCommand.js`, or any endpoint.

## Client / UI Changes

- `src/web/api.ts`: extend the `Status` type as above.
- `src/web/statusDot.ts`: add exported `classifyError`, `metaLineFor`, `latestActivity`,
  `hasUnseenActivity`; `dotTitleFor` appends the classified hint on red dots. `dotClassFor` is
  unchanged (colors stay as they are).
  - `metaLineFor(st)` returns: the classified error (error-styled) when unreachable;
    `"0.42 · 38% mem · 61% /"` when metrics are present (mem% = `1 - memAvailKb/memTotalKb`; any
    missing segment is omitted); and `""` when reachable but no metrics (row shows just the name).
- `src/web/main.ts`:
  - `createBoxRow`: wrap `nameEl` + a new `.box-meta` element in a `.box-main` column
    (`flex:1; min-width:0`), and add a `.box-activity` badge element. Dot and action buttons stay
    beside the column.
  - `pollStatus`: alongside the dot, set `.box-meta` text/class from `metaLineFor` and toggle the
    activity badge from `hasUnseenActivity`.
  - `openBox`: update the `lastSeenActivity` localStorage map for the opened box.
- `src/web/style.css`: `.box` aligns dot + `.box-main` column + buttons; `.box-meta` is small/muted;
  `.box-meta.error` is red; `.box-activity` is a small accent dot/badge.

## Error Handling & Portability

- A box that can't produce any metric still returns normal status; `metrics` is simply absent and
  `metaLineFor` falls back to the name-only row.
- `parseMeta` never throws on malformed input — non-numeric or partial lines yield `null` or a
  partial object; positions can't shift because parsing is `KEY=VALUE`, not columnar.
- The metrics block is best-effort and adds no failure mode to reachability: every metrics
  sub-command is `2>/dev/null` and the probe's exit code / tmux output still determine status.

## Testing

TDD with real code and canned `run` results (no mocks), matching `test/status.test.js` and
`test/statusDot.test.js`.

Server (`test/status.test.js`):

- `parseTmuxSessions` ignores a `__META__` line and still parses the session lines after it.
- `parseMeta` extracts a full line; tolerates a subset of keys; returns `null` when the line is
  absent or has no numeric fields; ignores non-numeric values.
- `checkBox` returns `metrics` when the probe stdout contains a `__META__` line, and omits `metrics`
  when it does not — both driven by a scripted `run` returning canned stdout.

Client (`test/statusDot.test.js`):

- `classifyError` maps each signature row above (incl. the fail2ban-style `kex_exchange_identification`)
  and passes through an unknown error unchanged.
- `dotTitleFor` includes the classified hint on a red status and composes with `paused`.
- `metaLineFor` formats present metrics, omits missing segments, returns the error hint when
  unreachable, and returns `""` when reachable with no metrics.
- `latestActivity` / `hasUnseenActivity` over sessions with mixed `attached`/`activity`, including the
  no-sessions and stale-`seen` cases.

E2E (optional, follows existing patterns): a box row shows a metrics second line; a red box shows a
reason; opening a box clears its activity badge.

## Not Included

- No metrics history, graphs, or time series — current snapshot only.
- No alerting / notifications on down or up transitions (a later feature).
- No per-box configurable thresholds or color-coding of high load/disk in this iteration.
- No metrics for the box you currently have a terminal open to (no probe runs there by design).
- No new endpoint, config knob, or persisted file.

## Acceptance Criteria

- A red box's row and dot tooltip state a plain-language reason derived from the probe's error.
- Reachable boxes show a compact `load · mem% · disk%` line under the label, sourced from the same
  30s probe with no additional SSH connections.
- A box with background tmux activity since it was last opened shows a badge that clears on open.
- A non-Linux or restricted box still shows correct reachability/tmux status with metrics absent.
- The probe remote command remains a static, non-interpolated string; no new injection surface.
- All new parsing/formatting helpers are pure and covered by unit tests with canned input.
