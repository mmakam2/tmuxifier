# Feature suggestions — 2026-06-21

A point-in-time review of Tmuxifier with three high-value feature candidates. Captured as
ideas/roadmap input, not yet specs or plans. When one is picked up, run it through
brainstorming and write a dated spec/plan under `docs/superpowers/`.

## Where the product is today

Solid single-user core: per-box persistent tmux over SSH, OAuth/password auth, import from
`~/.ssh/config`, live-streamed provisioning, a local "Host Shell," and a 30s reachability poll
that paints a green/amber/red dot per box. The architecture is clean — injectable factories,
all SSH args funneled through `assertBoxSafe`, ControlMaster multiplexing already in place.

The tagline is "manage your **whole fleet**," but the product is really "one terminal per box."
The highest-leverage additions are the ones that make it feel like a *fleet* tool. The three
below are ordered by value-to-effort.

## 1. Fleet command runner — run one command across selected boxes

The single highest-value gap. Tmuxifier can already SSH into every box safely; `sshRun.js` +
`buildProbeArgv` + ControlMaster multiplexing are exactly the plumbing needed. Add a
multi-select in the sidebar, a command box, and a results panel that collects/streams stdout
per box (`apt update`, `uptime`, `df -h`, "is the service up?").

- **Why high-value:** turns N terminals into one operation — the reason to have a fleet
  dashboard instead of N SSH tabs.
- **Fits the architecture:** reuse `createStatusChecker`'s pattern — `Promise.all` over boxes,
  each through the validated probe argv. No new injection surface, no new command-injection
  risk if it rides the same `assertBoxSafe` path.
- **Scope:** medium. New `POST /api/run` (or a WS for live output) plus a results component.
  The security review centers on how the typed command is quoted — the same care already
  applied to `startupCommand`.

## 2. Tags & grouping — activate the dormant `tags` field

`store.js:33` already normalizes and persists `tags: []` on every box, but nothing in the UI
ever sets, shows, or filters by them. Search (`main.ts:18`) only matches label/host. Add tag
editing in the box dialog, tag chips on rows, and group/collapse the sidebar by tag
(prod/staging, db/web).

- **Why high-value:** past ~10 boxes the flat list doesn't scale. Grouping is essential
  navigation, and it pairs naturally with #1 ("run on all `prod` boxes").
- **Fits the architecture:** the data field already exists and round-trips — mostly client work
  plus extending search to match tags. Low risk, contained.
- **Scope:** small–medium.

## 3. Richer health at a glance — extend the probe you already pay for

The status poll already does a full SSH round-trip per box every 30s, and `parseTmuxSessions`
already returns `windows`, `attached`, and `session_activity` — then the UI throws all of it
away and renders a single reachable/tmux dot (`main.ts:101`). Two cheap wins on the call you're
already making:

- Piggyback `uptime` / `df -h /` / memory onto `PROBE_REMOTE` (`status.js:5`) and surface
  load/disk in a tooltip or expandable row — near-zero added cost since the SSH connection is
  already open.
- Surface the already-collected `session_activity`/`attached` as an activity badge (e.g. a bell
  when a background session has output since you last viewed it).

- **Why high-value:** makes the dashboard a lightweight fleet monitor, not just a launcher — and
  most of the data is already in hand.
- **Scope:** small. One probe-string change, a parser tweak, and UI.

## Ranking

- **#1** for impact (the fleet operation use case).
- **#3** for cheapest value (data already collected and discarded).
- **#2** as the connective tissue between them (organize, then act on a group).

All three stay inside the self-contained, dependency-injected, validated-SSH model the repo
already enforces.
