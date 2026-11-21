# Agent workers: build notes for the first version

**Date:** 2026-11-21
**Status:** record of the build on branch `feat/agent-workers`, written when the documentation
was added. Point-in-time: it is not updated as the code moves on. The live walk on real boxes
had not been done when it was written (see the last section).
**Design:** `2026-11-19-agent-workers-design.md`; plan: `docs/superpowers/plans/2026-11-20-agent-workers.md`.
Read this beside the design: every item below is a place where the design no longer describes the
code. Section numbers in brackets are the design's. The operator guide is the "Starting an agent
on a box that has none" section of `docs/agent-messaging.md` and "Agent workers" in
`docs/boxes-and-setup.md`; the module map is in `CLAUDE.md`.

Box names (`orders`, `billing`), project names (`api`) and folders (`/opt/billing-api`) are
placeholders.

## Where the build departs from the design

1. **A failed start is judged on two looks [5.6].** The design closes a thread when, 30 s after
   the start, the session is not listed or its pane does not run `claude`. As built, the hub
   closes it only on a second failing look after the first one at 30 s or more. The age it
   checks is the start's age at the look, not the listing's, and a sweep can read a box before
   the session existed and be applied 30 s later: a healthy worker's thread would have been
   closed. A genuine failure is therefore reported one look later, up to about a minute after
   the start. Any look that does not fail (a `claude` pane, no listing, too young) clears the
   first. The stuck report (60 s, on `claude`, no marker) is unchanged.

2. **The send checks again after the start [5.3].** A start can take up to 20 s. Once it has
   resolved, `send` reads the boxes and the policies again: a target box that is no longer listed
   is refused `unknown-box`, and a pair that `mayStart` no longer allows is refused with its own
   code. The worker is left running either way and no thread is made. Without this, a box
   removal or a withdrawn permission during the start was missed by the sweeps and left an open
   thread.

3. **A box with the tick on and no projects [5.1, 5.3].** It is treated as not starting agents.
   A bare send there is refused as it was before (`no-agent`, or `no-other-agent` on the
   caller's own box); `--fresh` without a project name is `workers-off`. `no-project` is only for
   a project that was named and is not in the record, so a refusal never reads `has no project
   named ""`.

4. **A bare send to the caller's own box [5.3].** The design excludes the caller's own session
   from the candidates of a bare target, so a bare send from the configured session no longer
   answers `own-session`; only an explicit `./<own session>` or `box/<own session>` does. With
   no other agent and no start, the answer is a new refusal, `no other agent is running on
   <box>`, naming the box by its label (a send to `.` would otherwise read `…running on .`). The
   old wording, "is not running an agent" about the session that is running, was untrue to the
   agent. One existing test was updated for this.

5. **A symbolic `~/.claude.json` is never written [5.5].** The design keeps the file's mode and
   says a failed write is not an error. As built, a `~/.claude.json` that is a symbolic link, or
   anything but a regular file, is left alone (the trust code is `failed`) because a rename would
   replace the link with a file. The launch goes ahead and the worker waits at the trust
   question. Also: a file that does not exist is created `0600` holding only the key, put in
   place with `ln` so a file Claude Code created in the meantime is never replaced; a file that
   is not one JSON object, or whose `projects` entry is not an object, is left alone.

6. **The starter remembers its own starts [5.2 steps 3 and 4].** The design reads the names and
   the cap from the box's listing alone; as built, the starter remembers its own starts for up to
   60 s because the listing it reads lags them, and trusts the box's listing for them once two
   newer status reads have been applied to the box (`statusPoller.listingSeq`), so a killed worker
   stops counting once the list shows it gone.

7. **`tmx send` options [5.3].** As designed, with three things the design does not say.
   Options must come before the target: a second argument that is exactly `--fresh` or
   `--project` is a usage error (exit 2), because `tmx send billing --fresh` would otherwise have
   gone, irreversibly, to a running agent as the literal message `--fresh`. A `--project` value
   starting with `-` is refused, and so is an option given twice. The usage text keeps the old
   description of `send` (stdin, prints the id), since agents read it after an error.

8. **`tmx who` [5.3].** A box gets its `can start an agent (projects: …)` line only when it is
   reachable, the caller may start a thread with it (the caller's own box included), its record
   has the tick on and a project, and its mail tools are installed. An unreachable box lists
   nothing.

9. **Wording [9].** The design left it to the build. Two refusals read as "try again" and carry no
   `refused:`: `setup-running` and `start-failed`. `bad-mode` and any code the hub does not know
   read `start-failed`. The new status phrases are in `agentMailText.js` and nowhere else.

10. **The operator's drawer reads agent-directed phrases [5.6].** The status phrases are one set
    for the agents and the drawer. The new close, `closed-worker-failed`, reads `closed: the new
    agent did not start; tell your operator` in both, and the stuck phrase reads `is waiting for
    its operator at a start-up prompt`. The thread's state column says `closed: the new agent did
    not start`. An operator variant of the phrases was not built. The web client's close-reason
    type also gained `storage limit`, which the server already sent.

11. **The routes [5.4].** `GET /api/boxes/:id/workers` also answers `mail`, whether messaging is
    on, so the tick can be shown only then. `PUT` takes only `projects`, `mailStart` and `max` and
    answers a rule failure as 400 with the rule's message. `POST …/workers/start` answers a
    refusal as `{ error, code }` (409 for `setup-running` and `worker-cap`, 400 for `no-project`,
    else 502) and a success only after a best-effort re-probe of the box. All three work with
    messaging off and answer 503 only when the store or the starter could not be built. The
    wording for an unknown box is `box not found`, as the session routes have it, not `unknown
    box` as the mail routes do.

12. **The Edit Box section [5.4].** A row or `max` that fails the rules is refused when saving,
    after the box itself was saved, so the error reads `Box saved, but the agent worker settings
    were not: <problem>`, the same prefix a failed `PUT` gets. The wording of the `max` problem
    and of `At most 8 projects` is the build's. A project row added with **Add project** shows its
    empty-name problem at once.

13. **The hub's factory line.** `createAgentMailHub`'s signature has to stay on one source line:
    `test/opencodeAgentMailClient.test.js` matches `holdMs = 300000 }` in the source text.

## Known limitations

- **A worker's name can outlive its Claude [5.8]**, as designed. The leftover shell keeps its
  number and does not count against the cap.
- **A box whose default shell is `sh` (dash)** may not start `claude`. Under dash `sh -ic` reads
  only `$ENV`, so a `claude` in `~/.local/bin` is not found; the script still prints `started`
  and only the failed-start check catches it. The approved launch line is `-ic`; `-lic` would
  read `.profile` under dash but changes which rc files bash reads.
- **The trust key is undocumented**, as the design says. The write also goes to `~/.claude.json`
  in the login user's home, and was not checked against a box with `CLAUDE_CONFIG_DIR` set.
- **The cap can be exceeded by one for a moment.** The retry after `exists` (a lost race for a
  name) does not ask for the cap again.
- **The failed-start check looks at the pane command.** A Claude Code installed through npm can
  report `node` as its pane command, and a worker stopped at a start-up dialog would then read as
  "did not start". A listing cut at 200 rows reads as "not listed", which the two-look rule
  softens for a passing glitch only.
- **A reused session name** can attach an older start's entry to a new worker of the same name:
  the hub looks the entry up by `find`, not `findLast`.
- **No record survives a Tmuxifier restart.** The hub's list of starts and the starter's memory
  are in memory only. A message queued for a worker that never came up reads `is not running an
  agent` until the worker reports or the thread is stopped.
- **The operator's Start gives no sign of progress** for the few seconds it takes, and the
  picker's Start rows follow a saved project the next time the picker opens.
- **A stored entry that fails the rules is dropped without a word** when `data/agent-workers.json`
  is loaded, and the next write removes it for good. `removeBox` of an unknown id still writes
  the file. The store's first load can overwrite a map written in the meantime, as
  `agentMailPolicyStore.js` can.
- **Two counters per removed box id** live for the life of the process, one in the hub (`removals`)
  and one in the status poller (`listings`).
- **Not in this version** (design 3, 10): headless workers, a worker other than Claude Code,
  restarting or resuming one, a push for a stuck start, starting one from the Android app, the
  MCP server or the Host Shell.

## Not verified against a real Claude Code or a real box

The spike of 2026-11-19 (design 4: Claude Code 2.1.328, tmux 3.6, a private tmux server) was the
only run with a real Claude Code. Every test since starts a stand-in `claude` in a private tmux
server with a fixture home, under sh, bash and zsh, never the default tmux server. The end-to-end
spec runs the real server and the real starter the same way.

- **The trust key against a running Claude Code.** A Claude Code that is already running may save
  its cached `~/.claude.json` after our write and lose the key. Walk it with a second session
  open on the box.
- **`~/.claude.json` and `CLAUDE_CONFIG_DIR`**: whether the file moves with the variable.
- **The real `tmx hook-wait`** (not the stub) taking a message queued before the worker's
  `SessionStart`.
- **A worker under a default shell other than zsh or bash**, dash included, on a real box.
- **The skill's new section** and the wording of the new refusals and status lines were pinned by
  unit tests only; no real agent has read them.
- **`src/server/index.js`'s wiring** has no test, because nothing can test it without booting the
  server: `sessionsOf`, the construction of the store and the starter and its catch, the four
  options the hub gets (`sessionsOf`, `workers`, `workerStore`, `mailInstalled`), the late
  assignment of `mailForward`, `onRemoved` removing the worker settings with messaging off, and
  `agentWorkers` passed to `buildServer`. Only the live walk reaches them.
- **The messages tick with messaging off** is not reachable in the end-to-end spec (the tick is
  not shown then), and the layout of an Edit Box row was checked for overflow at 344 px only in
  the end-to-end spec, not on a phone.
- **The live walk** (plan Task 17) has to cover, with a real Claude Code on two real boxes in auto
  mode: a bare-name start, `--fresh`, a second project, the cap, the trust tick on and off, a stuck
  start, a failed start, and the operator's Start.
