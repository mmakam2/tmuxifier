# Agent workers: starting an agent on a box that has none

**Date:** 2026-11-19
**Status:** design, awaiting the operator's approval. Nothing is built.
**Builds on:** agent messaging (`2026-11-14-agent-messaging-design.md`, section 12 "After this
version": fresh workers) and its OpenCode counterpart. Read `docs/agent-messaging.md` and the
"Agent messaging" part of `CLAUDE.md` first; this document only says what changes.

## 1. Intent

Today a message can only reach a box where the operator has already opened a terminal and
started Claude Code by hand. A send to a box with no agent is refused (`refused: <box> is not
running an agent`). The operator wants a lead agent to be able to hand work to another box
without that manual step, and wants to be able to start an agent on a box from the dashboard
for the same reason.

A **worker** is an agent session that Tmuxifier started. It is an ordinary interactive Claude
Code in its own tmux session on the box. Nobody is attached when it starts; the operator can
open it at any time, watch it, type into it and answer its prompts, exactly as with a session
they started themselves.

## 2. What the operator decided

- A worker is a real session to watch and step into. Headless (`claude -p`) workers may come
  later and are not part of this version.
- An agent is started when a box has none, so the operator does not have to open Claude on
  each box.
- If an agent is already running on the box, mail is delivered there, as today.
- A box usually has one project directory (often `/opt/<project>`, sometimes under `/root`),
  but several per box must not be ruled out.
- No per-box "never deliver into my running sessions" setting.
- Approach 1 of the three considered (section 6).

## 3. Goals, non-goals, anti-goals

**Goals**

- A send to a box with no agent running starts a worker there, when the box allows it, and
  the message is delivered once the worker is up.
- A lead can ask for a new worker explicitly, even when agents are running on the target.
- The operator can start a worker from the dashboard with the same operation.
- The operator sets, per box, where a worker starts and whether mail may start one.
- A worker that fails to come up is reported to the lead and to the operator, never left as a
  silent queue.

**Non-goals for this version**

- Headless workers. The starter takes a `mode` that has one value, `interactive`.
- OpenCode or any other agent as a worker. OpenCode's mail target depends on operator
  evidence in the session (`session.viewed` or a `user` inbox item), which a never-touched
  worker does not have; it needs its own investigation.
- Restarting a worker that exited, resuming its conversation, or surviving a box reboot.
- Closing workers automatically.
- Starting workers from a device token (Android app, MCP).
- The Host Shell as a place to start workers.
- A push notification for a worker stuck at start-up (section 5.6 says what is shown instead).
- MCP turn tracking (`send_text` + `wait_for_agent`). Separate, small, its own design.

**Anti-goals** (a failure even if everything else works)

- Task text typed into a terminal, or passed in a command line.
- A lead choosing a path, a command or a flag. A lead names a box and at most a project.
- A worker started on a box whose setup job is running.
- A registry of workers kept in Tmuxifier. The box's tmux is the list.

## 4. Spike results (2026-11-19)

Throwaway; nothing kept. Claude Code 2.1.328, tmux 3.6, on the Tmuxifier host in a private tmux
server with an isolated `HOME` shaped like a seeded box (token in
`~/.tmuxifier-auth/claude-token`, the tagged rc lines, `{"hasCompletedOnboarding": true}`), the
product's own agent hook installed by `buildAgentHooksInstallScript`, and a stub `asyncRewake`
waiter. zsh and bash as the default shell.

**Launch environment**

| How the session is created | Result |
|---|---|
| `new-session -d -s <name> -c <dir> 'claude'` | **Fails.** tmux runs the command with `default-shell -c`, a non-interactive shell that reads no rc file: `claude` is not on `PATH` and there is no token. The session ends at once |
| `new-session -d -s <name> -c <dir>`, then `send-keys` the word `claude` | Works. Leaves a shell behind when Claude exits |
| `new-session -d -s <name> -c <dir> "exec <shell> -ic 'exec claude'"` | **Works**, zsh and bash: found on `PATH`, token set, cwd right, a tty. `pane_current_command` is `claude` |
| the same with `-lic` | Works |

**Folder trust**

- In a directory Claude Code has not seen, the worker stops at the trust dialog. Its default
  choice is "No, exit". **No hook fires and no marker is written** while it is shown;
  `pane_current_command` is already `claude`.
- Setting `projects["<dir>"].hasTrustDialogAccepted = true` in `~/.claude.json` before the
  launch skips the dialog. This key is not a documented contract.
- A trusted parent covers a child directory.
- (From the 2026-11-14 spike:) answering the dialog once records the directory as trusted.

**Start, then deliver**

- With trust in place and a message already waiting, a detached, never-attached session went
  `SessionStart` at +0.3 s, was woken at once, ran the turn and wrote `ready/stop` at +2 s. The
  markers were correct throughout (`working/resume`, then `ready/stop`). With nothing waiting, the
  marker reads `ready/start`.
- A fresh seeded home starts Claude Code in auto mode.
- `/exit` ends the tmux session and removes the marker.
- A launch whose binary is missing ends the session with no trace.

## 5. The design

### 5.1 Settings: `data/agent-workers.json`

A new store, `agentWorkerStore.js`, written `0o600` through `jsonFile.js`, mutations serialised
on one chain like `agentMailPolicyStore.js`. It is separate from `boxes.json` for the same
reasons the mail policy is: the box export, `store.js`'s field rebuild and the device-readable
`GET /api/boxes` never see it, and a directory that reaches a shell on the box never rides the
box `PATCH`.

```
<box id>: {
  projects: [ { name, dir, trust } ],   // 0..8, order kept; the first is the default
  mailStart: false,                     // may a message start a worker here
  max: 3                                // worker sessions allowed on this box, 1..8
}
```

- `name`: `^[a-z0-9][a-z0-9-]{0,23}$`, unique within the box.
- `dir`: absolute, `^/[A-Za-z0-9._/-]{1,199}$`, no `..` segment, no `//`, no trailing `/`.
  Validated on write **and again immediately before it is quoted into a remote script**.
- `trust`: boolean, default `false` (section 5.5).
- A box with no projects cannot have workers started on it, by mail or by the operator.
- Removing a box removes its record (`boxRemoval.js`'s `onRemoved`).
- The store is built whether or not agent messaging is on. `mailStart` has no effect when it
  is off.

Box ids are user-controlled keys: `Object.hasOwn`, null-prototype maps, as in the policy code.

### 5.2 The starter: `agentWorkers.js`

A factory with injected dependencies (`execCommand` over the ControlMaster, the worker store,
`setupManager`, the poller snapshot). One operation:

```
start(box, { project, mode: 'interactive' }) -> { ok, session } | { ok: false, code }
```

1. Refuse while the box's setup job is `running` (`setup-running`). rc files before sessions.
2. Look the project up by name in the box's record (`no-project`). No name means the first.
3. Pick the session name: `worker-<project>-<n>`, `n` the lowest number from 1 that is not a
   session in the box's current listing. The name always passes `SESSION_NAME_RE`.
4. Count the box's sessions whose name starts with `worker-` **and whose active pane runs
   `claude`**. At `max` or more, refuse (`worker-cap`). The count comes from the box's tmux
   listing, so it survives a Tmuxifier restart and needs no stored state. A session the
   operator named `worker-…` by hand counts while Claude runs in it. The pane command is part
   of the test because a worker's name can outlive its Claude (section 5.8): a leftover shell
   keeps its name, so step 3 skips it, but it does not use up the cap.
5. Run one remote script under `BatchMode`. Its steps, each reported as one `WORKER: <code>`
   line:
   - resolve tmux as the other session remotes do (`no-tmux`);
   - `[ -d <dir> ]` (`no-dir`);
   - the agent is installed: `command -v claude` or `~/.local/bin/claude`, the same test the
     hook installer uses (`no-agent-binary`);
   - when `trust` is set, the trust write of section 5.5;
   - `has-session -t '=<name>'` (`exists`: a lost race, the caller retries once with the next
     number);
   - `new-session -d -s '<name>' -c '<dir>' "exec \"$SHELL\" -ic 'exec claude'"` (`started`).
6. Report the result. The starter does not wait for Claude to come up; section 5.6 does.

The launch word is a constant looked up by agent id in a closed table (`WORKER_AGENTS`, one
entry, `claude`). Nothing a lead sent is in the script. The project name is a lookup key; the
directory is the operator's, re-validated and single-quoted.

Starts are single-flight per box: a second `start` for a box while one is running waits for
it, so two sends arriving together do not race for the same name.

`mode` is validated against a closed list holding only `interactive`. It exists so headless
can be added without changing callers.

### 5.3 Mail: when a send starts a worker

Changes are in `agentMailHub.js`'s `send`. Every existing check stays, in its order: caller
runs an agent, caller's send switch, target resolves, body, `mayStart` (all four switches and
lists), target reachable.

**Which session a send goes to**

For every bare-name row, "an agent" means a session that could take mail: it has a marker,
and its active pane's agent kind (`agentKindOf` of the pane command in the snapshot) is
`claude`, `opencode` or unknown. A session whose pane runs Codex, pi or agy has a marker but
no mail waiter, so it does not count, in the configured session or elsewhere: a box whose only
agent is one of those gets a worker, not a message that queues forever. The caller's own
session never counts, so a lead that sends to its own box's bare name with no other agent
there starts a worker beside itself. When the box's session listing is not known, every
session with a marker counts, which is today's test. An explicit `box/session` target keeps
today's test (a marker), whatever wrote it.

| Target | Agents running on the box | Result |
|---|---|---|
| `box/session` | — | That session, as today. No agent there: refused `no-agent`, as today. A named session is never started |
| `box` | one in the configured session | That session, as today |
| `box` | none in the configured session, exactly one elsewhere | That session (**new**; refused today) |
| `box` | none in the configured session, two or more elsewhere | Refused: name one (`tmx who`) |
| `box` | none | Start a worker in the default project (**new**) |
| `--fresh` | any | Start a worker in the default project |
| `--fresh --project <name>` | any | Start a worker in that project |

**Starting one from a send** needs, beyond `mayStart`:

- the target box's `mailStart` is on, else `no-agent` as today (bare name) or a new refusal
  `workers-off` (`--fresh`);
- the box's mail tools are installed (`forward.status(boxId).installed`), else a new refusal
  `mail-not-set-up`: a worker without the waiter hook could never receive the message;
- room in the store (`hasRoom`), asked before the start, not after;
- the starter's own refusals (`setup-running`, `no-project`, `worker-cap`, `no-dir`,
  `no-agent-binary`, `no-tmux`), each with its own wording.

When the start reports `started`, the thread is created with the peer
`{ boxId, session: <worker session> }`, the message is added `queued`, and the answer to the
sender is the usual sent text. From there nothing is new: the worker's `SessionStart` arms
`tmx hook-wait`, the agent hook writes `ready/start`, the watch stream's `c` runs
`refreshAgents`, `onAgents` calls `hub.boxChanged`, and the message is handed to the waiter and
acknowledged by the prompt hook.

**One pending start per box for bare names.** While a worker started for a bare-name send has
no marker yet, a second bare-name send to that box goes to the same worker session. A
`--fresh` send always starts its own.

**`tmx`** gains `tmx send --fresh [--project <name>] <target> [text]`. The wire format gains
one optional form field on `POST /v1/threads`, `fresh`, empty or a project name, allowlisted by
the listener before the hub is called. `--fresh` with a `box/session` target, and `--project`
without `--fresh`, are usage errors. The spelling has no `=` on purpose: the OpenCode plugin's
permission handler allows a `tmx` command only when every argument passes `TMX_ARGS_RE`, which
excludes `=`, and that allowlist is not widened here. `--fresh`, `--project` and a project
name all pass it as it is, so an OpenCode lead can use both forms with no plugin change.

**`tmx who`** gains one line per box the caller may send to that has `mailStart` on and at
least one project: `<box>  can start an agent (projects: api, web)`. Without it a lead cannot
know that a box showing no sessions is still reachable.

**The skill** (`tmuxifier-mail-skill.md`) is updated: a box with no agent may start one, how
to ask for a fresh one and when (unrelated work, clean context), and that a new worker knows
nothing the lead does not put in the message.

Boxes get the new `tmx` and skill on their next setup run. A bare-name send that starts a
worker needs nothing new on either box.

### 5.4 The operator's Start

`POST /api/boxes/:id/workers/start` `{ project? }`, browser session only (absent from
`DEVICE_ALLOWED_ROUTES` and 403 for a device id inside the handler). It calls the same
`start`. `mailStart` does not apply; `max` does.

`GET`/`PUT /api/boxes/:id/workers` read and write the record, browser session only.

In the dashboard:

- **Edit Box** gets an "Agent workers" section (edit mode only), saved after the box save like
  the mail section:

  ```
  Agent workers
    Projects
      api    /opt/billing-api    [ ] Skip Claude's folder-trust question     ×
      + Add project
    [ ] Let agent messages start an agent here       (shown when messaging is on)
    At most  3  worker sessions
  ```

- **The pane's session picker** gets one row per project, `Start Claude in <project>`, below
  the session rows, when the box has projects. Picking it starts the worker and switches the
  pane to the new session (the pane-local session override). Not in phone mode, where the
  picker has no targets.

Layout and wording within `DESIGN.md` are the builder's.

### 5.5 Folder trust

Per project, a tick: **Skip Claude's folder-trust question**, off by default.

- **Off:** Tmuxifier writes nothing. A worker in a directory Claude Code has not seen stops
  at the dialog and is reported as stuck (section 5.6). The operator opens the session and
  answers once; Claude Code remembers it for that directory.
- **On:** the starter's script, before the launch, sets
  `projects["<dir>"].hasTrustDialogAccepted = true` in `~/.claude.json` (jq → node → python3,
  temp file + rename, the file's mode kept). It **reads first and writes only when the key
  is not already `true`**, because running Claude Code sessions rewrite that file. A failed
  write is not an error: the launch goes ahead and the stuck report covers it.

The operator ticking the box in a browser session is the consent. The key is undocumented;
the build must record, against the real Claude Code, that it still works, and the design does
not depend on it: when it stops working the worker stops at the dialog and says so.

### 5.6 A worker that does not come up

The hub keeps, in memory only, each start it made for mail: box, session, thread, time. On
every `boxChanged` for that box it reads the box's listing and markers:

| What the box shows | Meaning | What happens |
|---|---|---|
| a marker for the session | up | The entry is dropped. Delivery is the existing path |
| 30 s after the start, the session is not listed or its active pane does not run `claude` | Claude exited at start-up (binary broke, the dialog was answered "No") | The thread is closed with a new reason, `worker did not start`. The lead's `tmx wait` ends with that line. A refusal-log entry records it for the operator |
| the session is listed, its pane runs `claude`, no marker, 60 s since the start | stuck at a start-up prompt (trust, sign-in) | The message stays `queued`. Its status reads `queued: the new agent on <box> is waiting for the operator at a start-up prompt`, for the lead and in the Messages drawer. If a marker appears later, delivery proceeds |

The second row waits 30 s and looks at the pane command for three reasons. The listing the
hub reads may have been taken before the session existed. For the first seconds the pane runs
the shell that is loading its rc files, which is not a failure. And a session name does not
disappear while a browser pane is on it (section 5.8), so "not listed" alone would never fire
in that case.

After a Tmuxifier restart the entries are gone. A queued message for a worker that never came
up then reads `queued: <box> is not running an agent`, the existing wording for a target whose
agent is gone, until the operator stops the thread.

A worker started by the operator's Start is not tracked: the operator is looking at it.

Every new sentence an agent reads is added to `agentMailText.js` and nowhere else.

### 5.7 What does not change

- Delivery, acknowledgement, the waiter, the agent hook and the markers.
- A message is never typed into a terminal.
- The permission a thread needs, and its re-check at every post, read and delivery.
- A worker runs with the box's own Claude Code settings. A prompt it raises reads `blocked`
  and notifies the operator, as for any session.
- A worker appears in the sidebar, the AGENTS board, the agent switcher and the session
  picker with no extra work, because it is a tmux session with a marker.
- The kill × in the session picker closes a worker, under the rule every session has today
  (section 5.8).

### 5.8 A worker's name can outlive its Claude

A browser pane attaches with `tmux new-session -A -s <session>` and reconnects without limit,
and a saved pane layout is restored by name. So when a worker's Claude ends while a pane is on
its session (`/exit`, "No" at the trust dialog, the kill × from that pane), the pane's
reconnect recreates the session under the same name as a plain shell, or as the box's
`startupCommand`. This is today's behaviour for every session, the kill route says so in its
own comment, and it is not changed here: no attach path is touched.

What follows from it, already written into the sections above:

- The operator's Start switches the pane to the worker, so this is the ordinary case there.
- A leftover `worker-<project>-<n>` shell keeps its number (5.2 step 3) and is not counted
  against the cap (5.2 step 4).
- A failed start is recognised by the pane command, not only by the session being gone (5.6).
- If the operator starts Claude by hand in a leftover shell, it is an agent session like any
  other and counts again.

## 6. Approaches

1. **Start on demand, deliver as ordinary mail. Chosen by the operator.** One delivery path;
   hooks, `tmx` delivery and markers untouched. Cost: the first task waits for Claude to boot,
   and a stalled start-up stalls delivery (section 5.6 exists because of that).
2. **Start on demand, the task as the launch prompt.** The first turn starts sooner and
   headless would launch the same way. Rejected for this version: a second delivery path with
   its own acknowledgement and failure cases, and the task text in a file on the box. It is
   the likely mechanism for headless later.
3. **A standing agent on every enabled box.** No start-on-send logic and it would cover a box
   reboot. Rejected: an idle Claude on every box, one long-lived context per box, no fresh
   worker on request.

Within approach 1, the launch is the interactive-shell `exec` from section 4. Typing `claude`
into a new shell also works but leaves a shell behind every time Claude exits; with `exec` a
worker nobody is looking at disappears when its Claude ends, and a shell is left only in the
case of section 5.8.

## 7. Constraints

- Every load-bearing rule in `CLAUDE.md` holds. The ones this touches: exact tmux targets
  (`-t '=name'`), validate and never rewrite explicit names, rc files before sessions, a
  running setup job gates the box, box output is untrusted (the `WORKER:` line goes through an
  allowlisting parser), closed allowlists are the chokepoints.
- Box-side script runs under the box's login shell, often zsh, with a bare `PATH`.
- Tests use real code: the starter's script against a private tmux server and a fixture home
  with a stand-in `claude` (never the default tmux server; `env -u TMUX -u TMUX_PANE tmux -S
  <scratch socket>`), under sh, bash and zsh. The hub with a real starter over a local
  transport.
- Acceptance is a live walk with a real Claude Code on two real boxes, in auto mode: bare-name
  start, `--fresh`, a second project, the cap, the trust tick on and off, a stuck start, a
  failed start, the operator's Start.

## 8. Calls made by Claude, not yet confirmed by the operator

1. **The trust tick, off by default** (5.5). The alternative is no tick: typing the directory
   is the consent and trust is always written.
2. **A bare box name goes to the only running agent** when the configured session has none
   (5.3). Stated in the conversation without objection.
3. **Workers stay until closed, with a per-box cap, default 3** (5.2). Stated in the
   conversation without objection. The cap applies to the operator's Start too.
4. **Settings in their own file**, not in `boxes.json` or the mail policy (5.1).
5. **Session names `worker-<project>-<n>`** (5.2).
6. **The operator's Start lives in the session picker** (5.4).
7. **No push notification for a stuck start**; it shows in the thread status and the Messages
   drawer (5.6).
8. **A second bare-name send joins a worker that is still starting** (5.3).
9. **A named session is never started**: `box/session` with no agent is refused as today.
10. **Claude Code only** as a worker in this version.
11. **A Codex, pi or agy session does not count as an agent** when a bare name is resolved, so
    such a box gets a worker (5.3). From the design review.
12. **A lead's own session does not count** either: a bare-name send to its own box starts a
    worker beside it when no other agent is there (5.3). From the design review.
13. **A worker's name can be left behind as a plain shell** when its Claude ends while a pane
    is on it, as with any session today; the cap ignores such leftovers (5.8). From the design
    review. The alternative, an attach that never creates, changes the terminal path for
    every session and is not proposed.
14. **`--fresh --project <name>`**, not `--fresh=<name>`, so the OpenCode plugin's argument
    allowlist stays as it is (5.3). From the design review.

## 9. Left to the builder

- Module boundaries beyond the store and the starter.
- The exact wording of every new refusal and status line, and of the skill.
- The trust write's three implementations and their shared tests.
- How the hub learns the box's session listing (the poller snapshot already carries it).
- Layout of the Edit Box section and the picker rows, within `DESIGN.md`.
- Documentation: `docs/agent-messaging.md`, `docs/boxes-and-setup.md`, the `data/` table and
  module entries in `CLAUDE.md` and `AGENTS.md`.

To verify against the real Claude Code during the build, since the spike did not:

- The real `tmx hook-wait` (not the stub) taking a message that was queued before the
  worker's `SessionStart`.
- Whether `~/.claude.json` moves with `CLAUDE_CONFIG_DIR`.
- A worker under a default shell other than zsh or bash on a real box.

## 10. After this version

Headless workers (`mode: 'headless'`, launched inside a tmux session, the task as the run's
prompt, the result posted as the reply); OpenCode workers; restarting or resuming a worker;
a push for a stuck start; starting workers through MCP together with turn tracking.
