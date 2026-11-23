# claude-nested-trace.jsonl

A recording of real Claude Code hook events from one interactive session in whose tmux pane three
`claude -p` ran: one from the session's own Bash tool, and two left in the background and
re-parented away from the pane. Each line holds the hook payload **and the process chain that
fired it**, read from `/proc` at that moment. Replayed by `test/agentHooksNestedReplay.test.js`.

Everything started in a pane inherits `$TMUX` and `$TMUX_PANE`, so each of those `claude -p`
fired the pane's hooks as if it were the pane's own Claude Code. With the hook as it was then,
the live marker went `working/prompt` → `ready/start` → `working/prompt` → `ready/stop` →
*(deleted)* for every one of them (the trail below). The replay proves the hook now writes
nothing for them.

## Line format

```
{ "t": <ms since line 1>,
  "payload": <the hook's stdin, scrubbed>,
  "proc": { "session": "rec", "pane_id": "%0", "pane_pid": <pid of the pane's first process>,
            "chain": [ { "pid", "ppid", "sid", "tty", "comm", "cmdline": [...], "exe", "stat" }, ... ] },
  "env": { "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_CHILD_SESSION" } }
```

`chain[0]` is the recorder process itself, then its parent, and so on up to pid 1. The recorder
was a command hook registered beside the agent hook on every event, so it stood exactly where the
agent hook stands: `chain[1]` is the `/bin/sh -c` Claude Code runs a hook command through and
`chain[2]` is the Claude Code that fired the event. `stat` is the process's `/proc/<pid>/stat`
line; `tty` is its field 7 (0 = no controlling terminal); `sid` its field 6.

`env` is what the recorder found in its own environment. Lines 1 to 3 have only `CLAUDECODE`:
the recorder started keeping the other four after line 3.

## How it was recorded

- Claude Code **2.1.330**, model **Haiku 5.5** (`--model haiku`) for the session and for every
  `claude -p`, tmux 3.6, `/bin/sh` = dash 0.5.12, recorded 2026-11-23 on the Tmuxifier host (no
  box involved).
- Started as `claude --setting-sources project --permission-mode default --model haiku` from a
  scratch project, inside a private tmux server (`tmux -L <private> -f /dev/null`, started with
  an environment built from scratch: no `TMUX`, `TMUX_PANE` or `CLAUDE*` variable), session
  `rec`, one window, one pane `%0`, default shell bash. Manual permission mode throughout.
- The project's own `.claude/settings.json` held:
  - the recorder (`node rec.js`) on SessionStart, UserPromptSubmit, PreToolUse,
    PermissionRequest, PostToolUse, PostToolUseFailure, Notification, SubagentStart,
    SubagentStop, Stop, SessionEnd and PreCompact;
  - the 13 agent-hook entries of `HOOK_EVENTS`, calling a copy of the hook **as released in
    v1.24.94** (before the ownership check) placed in the project, with `HOME` pointed at a
    scratch directory so its markers stayed out of the host's `~/.tmuxifier-agent`;
  - `permissions.allow`: `Bash(claude *)`, `Bash(sh spawn-detached.sh *)`, `Bash(date)`.
- Every `claude -p` was `claude -p --setting-sources project --model haiku 'Reply with the single
  word ok'` run in the project directory, so it loaded the same hooks.
- `spawn-detached.sh <seconds>` is `setsid nohup env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u
  CLAUDE_CODE_SSE_PORT sh -c "sleep <seconds>; exec claude -p …" >/dev/null 2>&1 </dev/null &`: what
  a plugin that nohups a summarizer does.
- A watcher polled the marker directory every 15 ms and logged each change (the trail below).

Scrubbed: `session_id` -> `sess` for the interactive session and `nested-1`, `nested-2`,
`nested-3` for the three `claude -p`, in order of appearance (also inside strings);
`transcript_path`/`agent_transcript_path`/`scratchpad_dir` -> `/scrubbed`; the project path ->
`/tmp/rec` (the marker home -> `/tmp/rec-home`, the recorder's output directory ->
`/tmp/rec-out`); `prompt_id` -> `p`; `tool_use_id` and `toolu_*` inside strings -> `t`; task
output files -> `/scrubbed/tasks/<id>.output`. **Pids are renumbered** in order of first
appearance to 5000001 and up (above any pid a kernel hands out, so a replay's fake `/proc` can
never collide with a live process), consistently in `pid`, `ppid`, `sid`, `pane_pid`,
`CLAUDE_PID` and in the pid, ppid, pgrp, session and tpgid fields of each `stat` line; pids 0 and
1 are kept. Every other `stat` field is as read. Agent ids and task ids are random and kept.
Nothing was dropped or reordered.

## Scenarios

| Lines | Session | What | Chain above the hook (`chain[1]` up) |
|---|---|---|---|
| 1 | `sess` | start | `sh` < `claude` < `bash` (the pane, = `pane_pid`) < `tmux: server` < 1 |
| 2-3 | `sess` | plain turn "Reply with the single word ok" | as line 1 |
| 4-5 | `sess` | prompt, then PreToolUse(Bash) for `claude -p …` | as line 1 |
| 6-9 | `nested-1` | **(a) `claude -p` from the Bash tool**: SessionStart(startup), UserPromptSubmit, Stop, SessionEnd(other) | `sh` < `claude` (the `claude -p`) < `bash` (the Bash tool's shell) < `claude` (the session) < `bash` (the pane) < … |
| 10-12 | `sess` | PostToolUse(Bash), Stop, SubagentStop | as line 1 |
| 13-17 | `sess` | a turn that runs `sh spawn-detached.sh 12` and ends | as line 1 |
| 18-21 | `nested-2` | **(b) a detached `claude -p` that starts 11.7 s after that turn's Stop**: the same four events | `sh` < `claude` < 1 |
| 22-25 | `sess` | prompt, PreToolUse(Bash `touch probe.txt`), PermissionRequest, Notification(permission_prompt): the dialog stays open | as line 1 |
| 26-29 | `nested-3` | **(c) a detached `claude -p` while that dialog is open** (started from outside the session, with the pane's `TMUX` and `TMUX_PANE`): the same four events | `sh` < `claude` < 1 |
| 30-32 | `sess` | the dialog approved: PostToolUse(Bash), Stop, SubagentStop | as line 1 |
| 33-44 | `sess` | a background subagent turn: PreToolUse/PostToolUse(Agent), SubagentStart, Stop, the subagent's PreToolUse/PostToolUse(Bash `date`), SubagentStop x2, the `<task-notification>` resume, Stop, SubagentStop | as line 1, for every one of them |
| 45 | `sess` | `/exit`: SessionEnd(prompt_input_exit) | as line 1 |

## Marker trail, live, with the hook as it was

From the watcher (seconds after line 1; `(none)` = no marker file). The replay of the old hook
gives the same states line for line.

| At | Marker | From |
|---|---|---|
| 34.06 | `working/prompt` | line 4 |
| 35.13 | `ready/start` | line 6, `nested-1`'s SessionStart: the session reads idle in the middle of its turn |
| 35.42 | `working/prompt` | line 7 |
| 36.11 | `ready/stop` | line 8 |
| 36.15 | `(none)` | line 9, `nested-1`'s SessionEnd |
| 36.94 | `ready/stop` | line 11, the session's own Stop repairs it |
| 71.63 | `ready/stop` | line 16 |
| 83.32 | `ready/start` | line 18: a new timestamp over a finished turn |
| 83.49 | `working/prompt` | line 19 |
| 84.24 | `ready/stop` | line 20 |
| 84.27 | `(none)` | line 21. **Nothing repairs this**: the session is idle at its prompt with no marker until the operator's next prompt (35 s later here; an hour in the report that led to this recording) |
| 120.55 | `blocked/permission` | line 24 |
| 136.78 | `ready/start` | line 26: the block is gone while the dialog is still on screen |
| 136.86 | `working/prompt` | line 27 |
| 137.72 | `ready/stop` | line 28 |
| 137.76 | `(none)` | line 29, until the approval's Stop at 154.71 |

## What the recording settled

**1. Who starts a hook.** Every one of the 45 events, the subagent's and the background ones
included, was started by the Claude Code main process itself: `chain[2]` is always the `claude`
whose session the payload names. Claude Code runs the command through `/bin/sh -c` in a new
session: the shell (`chain[1]`) is a session leader (`sid` = its own pid) with no controlling
terminal (`tty` 0), and so is everything under it. dash does not exec the single command, so the
shell stays between the hook and Claude Code.

**2. The three shapes.**

```
the pane's own            claude -p from the Bash tool        claude -p left in the background
bash          pane_pid    bash          pane_pid              systemd (1)
  claude                    claude        the session           claude      a session leader
    sh -c <hook>              bash        the Bash tool's shell   sh -c <hook>
      <hook>                    claude    the claude -p             <hook>
                                  sh -c <hook>
                                    <hook>
```

The Bash tool's shell is `/bin/bash -c 'source <shell snapshot> … && eval …'`, a session leader
with no controlling terminal; it does not exec the command, so it stays between the two Claude
Codes. A re-parented `claude -p` hangs directly off pid 1 here (no subreaper on this host).

**3. Nothing in the payload tells them apart.** A `claude -p`'s SessionStart is
`source: "startup"` like the session's own; its SessionEnd has `reason: "other"`. Its
SessionStart has neither the `scratchpad_dir` nor the `model` the interactive session's has,
which is not something to key on.

**4. The environment does, but it is not what the hook goes by.** A hook's environment carried
`CLAUDE_PID` (the pid of the Claude Code that started it: equal to `chain[2].pid` on every line
that has it) and `CLAUDE_CODE_ENTRYPOINT` (`cli` for the interactive session, `sdk-cli` for each
`claude -p`, also for the ones started with that variable unset), with
`CLAUDE_CODE_SESSION_ATTENDED` `1` and `0` likewise. `CLAUDECODE=1` was set in every hook,
including those of the `claude -p` started with it removed. These are undocumented and say
nothing about where the process sits, so the hook reads `/proc` instead; they are recorded here
in case they are ever needed.

**5. SessionEnd.** The session's own SessionEnd hook (line 45) ran while Claude Code was still
alive and still its grandparent, so the hook's walk up its parents works there too.

**6. The fix, live.** With the hook and `tmx` as they are now, the same setup again (not part of
this recording; the session was named `main`, with the three mail hooks and this branch's real
mail store, hub and listener behind them, the hub reading the session's markers from the marker
directory):

- (a) and (b) again: each `claude -p` fired its four events and the marker, the owner record,
  the waiter's lock (its pid and its Claude Code's) and the hub's listener count did not change
  at any of them. The marker kept its timestamp.
- A message sent after (b) was handed and confirmed within 250 ms (`delivered`), the session
  answered it, and a new waiter of the same Claude Code was listening 1.5 s later.
- `/exit` removed the marker, the owner record and the lock.

And on a box, with the hook and `tmx` as a setup run installs them (hooks in
`~/.claude/settings.json`, Claude Code 2.1.330 in auto mode, zsh as the pane's shell, other
plugins' hooks beside ours): a `claude -p --debug` from the Bash tool and one left in the
background each logged our hooks as run (`tmuxifier-agent-hook.sh start`, `prompt`, `stop`;
`tmx hook-wait`, `hook-ack`), every one finished with status 0 within 35 ms, and the marker (same
timestamp) and the waiter's lock were the same before and after.

**7. `#{pane_pid}` needs `-t`.** Not from this recording (it had one pane): `tmux
display-message -p '#{pane_pid}'` with no target answers for the **active** pane of the
session's current window, not for `$TMUX_PANE`. `test/agentHookNested.integration.test.js` runs
the hook in a pane that is not the active one, against a real tmux, and fails without the `-t`.
