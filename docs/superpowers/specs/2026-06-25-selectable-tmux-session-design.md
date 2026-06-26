# Selectable tmux Session Name Design

## Summary

Tmuxifier attaches each box's browser terminal to a tmux session named by the box's
`sessionName` field, which defaults to `web`. That field already exists end-to-end —
`store.js` normalizes and `sanitizeSession`-cleans it on both add and update, `buildAttachArgv`
uses it for `tmux new-session -A -D -s <name>`, and provisioning (`buildEnsureTmuxRemote`) ensures
that named session exists — but it is **not surfaced anywhere in the UI**. The only way to point a
box at a different session today is to hand-edit `data/boxes.json`.

Users sometimes keep their own tmux sessions on a host (not Tmuxifier's `web`). This change exposes
`sessionName` in the Add/Edit box dialog as a **type-or-pick** field: a free-text input (so a
brand-new session name can be typed) accompanied by clickable **chips** of the available session
names, defaulting to `web`. The chips pre-fill for free from the sessions the status poller already
caches, and a **⟳** button does an on-demand live probe when the user wants a fresh list.

Because the store and attach/provision paths already honor `sessionName`, this is almost entirely a
UI surfacing change plus one new read-only probe endpoint.

## Rate-ban safety (why the probe is shaped this way)

This repo has a documented history of host-side port-22 rate bans triggered by SSH-connection
amplification (multi-tab status probes; fail2ban on at least one box). The live fetch is therefore
constrained to add **no surprise** SSH volume:

- The dropdown pre-fills from the **already-cached** `/api/status` snapshot — opening the dialog
  costs **0 new SSH connections**.
- A live re-probe fires **only** on an explicit ⟳ click (never on dialog open, never on keystroke).
- The probe reuses the box's shared **ControlMaster** socket (keyed by the `%C` hash of
  user/host/port, not box id) and the status checker's **in-flight de-dup**, so a fetch rides the
  open master instead of opening a fresh TCP+auth handshake.
- If the box has a **live interactive session**, the probe still runs **as long as that session's
  ControlMaster is established** — `tmux ls` then multiplexes over the live master as a separate
  channel without disturbing the terminal. The probe is skipped **only in the narrow mid-login
  window** (session open but the master not up yet), where it would race the login (the documented
  garbled-prompt bug); then the client keeps its cached pre-fill. A socket-only `masterAlive`
  (`ssh -O check`, no network/auth) tells the two apart.

> **Amendment (2026-06-26, from testing feedback):** the original design skipped the probe whenever
> any interactive session was open, which made ⟳ useless precisely on the boxes a user is actively
> working on (the dropdown showed only `web`). Refined to the `masterAlive`-gated behavior above:
> refresh works on a live box; only the brief mid-login window is deferred. Updated `listSessions`,
> its tests, and the `inUse` hint copy ("terminal still connecting — retry shortly").

## Behavior

### Server

**`status.js` — new `listSessions(box)`** (sibling to the existing `probe()`, reusing `run`,
`PROBE_REMOTE`, `parseTmuxSessions`, the `controlDir`/`controlPersist` args, and in-flight de-dup):

- If `hasLiveSession(box.id)` is true, check `masterAlive(box)` (socket-only `ssh -O check`):
  - master **not** alive (mid-login, or `masterAlive` not wired) → **do not probe**. Return
    `{ reachable: true, tmux: true, inUse: true, sessions: [] }`.
  - master **alive** → fall through and probe over the shared master (multiplexed, safe).
- Otherwise run `buildProbeArgv(box, PROBE_REMOTE, { hostKeyPolicy, sshConfigFile, controlDir,
  controlPersist })` through `run` and return, mirroring `probe()`:
  - reachable + tmux running → `{ reachable: true, tmux: true, sessions: [...] }`
  - `__NO_TMUX__` → `{ reachable: true, tmux: false, sessions: [] }`
  - auth failure (`AUTH_FAIL_RE`) → `{ reachable: false, needsAuth: true, error }`
  - otherwise unreachable → `{ reachable: false, error }`
- Never throws — a thrown/invalid box becomes `{ reachable: false, error }`.
- Coalesce concurrent calls for the same box key via an in-flight map (a double-click must not
  double-probe).

**`server.js` — new `POST /api/boxes/probe-sessions`** (auth-gated like every other `/api/*` route):

- Body: `{ id?, host, user, port, proxyJump }`. `id` is optional and used only for the
  `hasLiveSession` guard (present in edit mode, absent in add mode).
- Calls `statusChecker.listSessions(spec)` and returns its result as JSON.
- `assertBoxSafe` (already called inside `buildProbeArgv`) rejects unsafe host/user/port/proxyJump
  → respond `400`. No new privilege surface: an authenticated user can already open an SSH session
  to any host via add/edit; `BatchMode=yes` prevents password prompts and `ConnectTimeout` bounds a
  hang.

**`server.js` — `PATCH /api/boxes/:id`** gains a session-switch hook: it reads the box before the
update and, if `updated.sessionName !== before.sessionName`, calls `sessions.closeKey(id)`. The live
PTY was opened against the *old* session and `sessions.open()` reuses a live key, so without this a
save would persist the new name but the terminal would stay on the old session until a manual
reconnect. Dropping the PTY makes the browser terminal auto-reconnect (~1s) and the `/term` handler
re-reads the box, attaching to the new session. The ControlMaster (keyed by host/user/port) is left
untouched — the reattach multiplexes over it, so no re-auth (rate-ban safe). A no-op session change
does not drop the PTY.

**`store.js`** — unchanged. `normalize()` already threads `spec.sessionName` through
`sanitizeSession` for both `addBox` and `updateBox`, so the field round-trips already.

### Web client

**`api.ts`** — new `probeSessions(spec)` → `POST /api/boxes/probe-sessions`, returning
`{ reachable, tmux, sessions, needsAuth?, inUse?, error? }`.

**`main.ts` `openBoxDialog`** — add a `sessionName` field **between the ProxyJump field and the
provisioning toggles** (it governs which session the terminal/provisioner targets, not a
provisioning extra):

- A free-text `<input>` with a **⟳** button beside it, and a row of clickable session **chips**
  below. (A native `<datalist>` was tried first but its popup filters options by the text already in
  the field, so a pre-filled session name hid every other option — chips always show the full set.)
- Placeholder `web`. In edit mode, prefilled with `box.sessionName`. Clicking a chip fills the input
  and marks that chip selected; the input stays editable for typing a brand-new name.
- **Pre-fill (free):** chips = `web` (default) merged with the names from `status[box.id]?.sessions`
  in the already-fetched status map. Edit-mode opens with the live list and zero new SSH.
- **⟳ click:** reads the dialog's current host/user/port/proxyJump (plus `id` in edit mode — so it
  works before save in add mode and reflects edited connection fields) and calls `probeSessions`.
  An inline status line beside the field reflects the outcome:
  - probing… (disabled spinner state)
  - success → rebuild chips (`web` + returned names)
  - `tmux === false` → "tmux not running"
  - `inUse` → "terminal still connecting — retry shortly" (keeps existing chips)
  - `needsAuth` → "needs login — open the terminal"
  - unreachable / error → "couldn't reach host" (keeps existing chips)
- **Submit:** `sessionName = input.value.trim() || 'web'`, **always** included in the spec (add) and
  patch (edit). Always sending it removes the add-vs-edit asymmetry in `store.normalize`
  (`spec.sessionName || base.sessionName || 'web'`): clearing the field in edit mode predictably
  reverts the box to `web` rather than silently keeping the old value. Server `sanitizeSession` is
  the source of truth; no client-side validation is required (the input may legally contain
  characters the server will fold to `-`).

## Components & data flow

```
Add/Edit dialog (main.ts)
  ├─ open: read status[box.id].sessions (cached)  ──►  session chips (0 SSH)
  ├─ ⟳ click: api.probeSessions({id?,host,user,port,proxyJump})
  │      └─ POST /api/boxes/probe-sessions (server.js, auth-gated)
  │             └─ statusChecker.listSessions(spec) (status.js)
  │                    ├─ hasLiveSession(id) && !masterAlive ─► inUse, no SSH (mid-login)
  │                    └─ else: buildProbeArgv + run over shared ControlMaster ─► sessions
  └─ submit: spec.sessionName / patch.sessionName ─► store.normalize ─► sanitizeSession
                                                          └─► buildAttachArgv / buildEnsureTmuxRemote
```

## Error handling

- Probe never throws; all failure modes resolve to a typed result the client renders inline.
- A failed/unreachable/in-use probe is non-destructive: the dialog keeps its cached options and the
  user can still type any name and save.
- Unsafe connection fields are rejected at the endpoint (`400`) before any `ssh` runs.

## Testing (TDD; real code with an injected `run`, per repo convention)

- **Unit — `status.listSessions`:**
  - reachable + tmux → parsed sessions
  - `__NO_TMUX__` → `{ tmux: false, sessions: [] }`
  - unreachable → `{ reachable: false, error }`
  - auth failure → `{ reachable: false, needsAuth: true }`
  - live session + master **not** alive (mid-login) → `{ inUse: true }` **and asserts the injected
    `run` was never called**; live session + master alive → **probes** and returns parsed sessions
- **Integration — `POST /api/boxes/probe-sessions`:**
  - returns sessions for a stubbed `run`
  - `401` without the auth cookie
  - unsafe host → `400`
- **Store:** assert `sessionName` round-trips through `addBox` and `updateBox` (add coverage if not
  already present).
- **e2e:** out of scope for this change; optional follow-up against the sshd-backed test box.

## Out of scope / YAGNI

- No automatic probe on dialog open or on field focus (rate-ban safety; user-triggered only).
- No strict `<select>` that forbids typing a new name — the field must accept user-entered names.
- No per-session metadata in the dropdown beyond the name (window counts etc. are nice-to-have, not
  required); keep the option list to plain names plus the `web` default marker.
