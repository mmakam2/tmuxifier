# Gate the box terminal while setup is running — design

**Date:** 2026-07-21
**Status:** approved, ready for an implementation plan
**Follows:** `docs/superpowers/specs/2026-07-21-server-side-ai-auth-seed-trigger-design.md`

## Problem

A shell reads its rc files once, at startup. The AI-auth seed appends the Claude token as an
`export` line to `~/.profile`, `~/.bashrc`, and `~/.zshrc` (`aiAuthSeed.js:19-30`). So any shell
that started *before* the seed ran holds an environment snapshot with no token in it: `claude`
shows as logged out despite a perfectly valid seeded credential sitting in the rc file.

Observed on a freshly provisioned box: Codex worked, Claude did not. Codex is unaffected because
its credential is a file (`~/.codex/auth.json`) read at invocation, not an environment variable
captured at shell start. Clicking the box's refresh button fixed it — that kills the PTY, the
tmux session respawns a shell, the shell re-reads rc, and the token appears.

The trigger is timing. Provisioning auto-starts a server-side setup job while the Proxmox hub sits
there offering an "Open terminal" button, so it is easy — natural, even — to attach before setup
finishes. This also invalidates an assumption recorded when seeding shipped: that freshly
provisioned boxes were safe because "the seed completes before first attach."

The same staleness applies beyond credentials. A shell opened while `oh-my-zsh`, `node`, `gh`, or
the CLI tools are still installing has the wrong `PATH` and a half-configured shell. Credentials
are simply the case that bites hardest, because the failure looks like "seeding is broken" rather
than "I opened this too early."

## Goals

- A box terminal cannot be opened while that box's setup job is running.
- Clicking a box mid-setup gives useful feedback — live status and log — not a dead click.
- When setup finishes, the terminal opens on its own.
- No box can ever become permanently unreachable because of the gate.

## Non-goals

- Killing or respawning existing tmux sessions after a seed. Considered as an alternative fix; it
  yanks a session out from under whatever is running in it and does nothing for `PATH` staleness.
- Changing how the seed delivers the token. The rc `export` is what `claude` reads.
- Gating anything other than the normal box terminal — provision-mode terminals and the local
  shell are explicitly out.

## Decisions

| Question | Decision |
|---|---|
| What the gate protects | "This box isn't ready" in general, not just seeded credentials. |
| Which statuses block | Only `running` (which includes the `seeding` phase). |
| Panel behavior on completion | Auto-opens the terminal. |
| Enforcement | Both: the client renders a panel, and `/term` independently refuses. |

### Why only `running`

`needs-interactive`, `error`, and `interrupted` are paused or dead states — nothing is mutating
the box, and those are precisely the boxes a shell is needed on to diagnose. Blocking
`needs-interactive` would be actively harmful: a job can sit parked for days.

This also guarantees no permanent lockout. `running` is bounded by `taskTimeoutMs` (600000, so 10
minutes worst case) after which the job errors and the gate lifts, and a server restart reconciles
a `running` job to `interrupted` on load, which lifts it immediately.

### Why enforce on both sides

The client gate is the user experience; the server gate is the guarantee. A tab left open from
before the setup started already holds a live socket, reconnects on its own schedule, and never
consults any client-side check. A second browser doesn't either.

## Architecture

### Client gate

`openBox(b)` gains a second early return, directly after the existing Proxmox-stopped one
(`main.ts:942`) which it deliberately mirrors:

```ts
const job = latestSetups.find((s) => s.boxId === b.id);
if (blocksTerminal(job?.status) && !opts?.fromSetupGate) { closeTab(b.id); showSettingUpBox(b); return; }
```

`latestSetups` is already maintained (`main.ts:661`) and already feeds the sidebar's "setting up"
badge, so no new fetching is introduced.

`showSettingUpBox(b)` mirrors `showStoppedBox` (`main.ts:913`) — same stage takeover, same panel
conventions — but instead of static content it runs `createSetupJobPoller` against
`api.getBoxSetup(b.id)`, rendering `setupStatusText(job)` and the tail of `job.log`. Because it
reuses that helper, the seeding phase displays as "Seeding AI credentials…" for free. When the
poller observes a status other than `running`, it calls `openBox(b, { fromSetupGate: true })`.

### The bypass flag is load-bearing

Without it the two views ping-pong: the panel's poller sees `done` and calls `openBox`, which
re-checks `latestSetups` — refreshed on the dashboard's own cadence and possibly still saying
`running` — and bounces straight back into the panel, whose poller immediately sees `done` again.

The panel has just read authoritative job state directly from the API, so re-consulting a cached
list at that moment is strictly worse information. The server gate remains the real guarantee, so
the bypass cannot open a terminal that should not exist.

### Server gate

In the normal-box branch of `/term`, after `store.getBox` and **below** the `mode === 'provision'`
block:

```js
if (setupManager?.currentForBox(boxId)?.status === 'running') {
  socket.close(1008, 'setting up');
  return;
}
```

Placement below the provision branch is what keeps "Finish interactively" working on exactly the
boxes that are parked mid-setup. Optional chaining means a server built without a `setupManager`
(as several tests do) simply has no gate, consistent with how the route already treats it.

### Reconnect handling

`terminal.ts`'s `ws.onclose` (line 315) ignores the close code entirely: every close increments
`failures` and schedules `reconnectDelay(failures)`, escalating toward a 5-minute floor. An
already-open tab whose box starts a new setup run (the Edit-box path) would therefore print
`[disconnected — retrying in …]` and could idle for minutes after setup finished.

A `'setting up'` close is handled as its own case: write
`\r\n[setting up — reconnecting when ready…]` and retry on a fixed short interval **without**
incrementing `failures`. This is a known bounded wait, not a failure, and must not poison the
backoff state that real outages depend on.

The rejected alternative — having the tab tear itself down and re-enter `showSettingUpBox` — is
more correct-looking but requires `terminal.ts` to reach into `main.ts`'s stage management, a
dependency that does not currently exist.

## Edge cases

| Case | Behavior |
|---|---|
| `latestSetups` stale (says nothing, job actually running) | Client opens a terminal; server closes it with `'setting up'`; the terminal shows the reconnect line and lands correctly moments later. Defense in depth working as designed. |
| `latestSetups` stale (says running, job actually done) | Panel opens, its poller immediately reads `done`, auto-opens the terminal with the bypass. Self-correcting. |
| Job never finishes | Bounded by `taskTimeoutMs` = 10 minutes, then `error`, then the gate lifts. |
| Server restart mid-run | Job reconciles to `interrupted` on load; gate lifts immediately. |
| Provision-mode terminal | Ungated by construction — the guard sits below that branch. |
| Local shell (`__local__`) | Returns before the guard; has no setup jobs at all. |
| No `setupManager` wired | Optional chaining, no gate. Fails open. |
| Box deleted while the panel is open | The poll starts failing and the panel keeps retrying until the user clicks elsewhere. Accepted: a dead-end view for a box that no longer exists, and `refresh()` already drops it from the sidebar. |

## Testing

**Pure helper**, so the rule is stated once and testable: `blocksTerminal(status?: SetupStatus):
boolean` in `setupStatus.ts`, `true` only for `'running'`. `test/setupStatus.test.js` covers every
status value plus `undefined`, which pins "needs-interactive must not block" as a test rather than
a comment.

**Server gate**, in `test/server.ws.integration.test.js` (which already drives real WebSocket
connections and already asserts a `1008` close at line 83, and already opens a provision-mode
socket at line 146 — both templates to follow):

1. Box with a `running` job → `/term` closes, code `1008`, reason `setting up`.
2. Same box, job `done` → connects normally.
3. Job `running`, `mode=provision` → connects normally. This is the deadlock guard: it fails if
   the block is ever moved above the provision branch.
4. No `setupManager` wired → connects normally.

**Not automatically tested:** the client gate — `openBox`'s early return, the panel, the
auto-open, and the bypass flag. This is DOM code, which this repo deliberately does not unit-test,
so `npm run typecheck` catches shape errors and nothing more. An e2e test was considered and
rejected: it would have to race a setup job that completes in about 30 seconds, making it
timing-dependent, and this repo already carries three red voice specs from exactly that kind of
environmental coupling. The auto-open loop above is the real risk here, and a test racing a live
job would catch it only intermittently.

**Manual check** — also the check that proves the original bug is fixed:

1. Provision a fresh box with the seed option ticked, or Edit-box → re-run setup on an existing
   one.
2. Click the box in the sidebar *while setup is running*. Expect the setting-up panel with a live
   log, not a terminal, and expect "Seeding AI credentials…" near the end.
3. Touch nothing. The terminal should open by itself when the job finishes.
4. In that terminal, `echo $CLAUDE_CODE_OAUTH_TOKEN` is non-empty and interactive `claude` shows
   as logged in — with no box refresh.

Step 4 is the point. That is what required a manual refresh before.

## Files touched

| File | Change |
|---|---|
| `src/web/setupStatus.ts` | New pure `blocksTerminal()`. |
| `src/web/main.ts` | `openBox` gate + bypass option; new `showSettingUpBox`. |
| `src/web/terminal.ts` | Handle a `'setting up'` close as a bounded wait, not a failure. |
| `src/server/server.js` | `/term` refuses a box with a running setup job. |
| `test/setupStatus.test.js` | `blocksTerminal()` across all statuses. |
| `test/server.ws.integration.test.js` | The four gate cases. |
| `CLAUDE.md` / `AGENTS.md` | Note the gate on the `server.js` and `main.ts` entries. |
