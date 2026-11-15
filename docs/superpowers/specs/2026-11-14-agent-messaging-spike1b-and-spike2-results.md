# Agent messaging: spike 1b and spike 2 results

**Date:** 2026-11-14
**Status:** findings from two throwaway spikes, run after the operator confirmed build order B
(running sessions first, delivered by `asyncRewake`). No product code was written and everything
used was deleted afterwards.
**Earlier documents:** `2026-11-14-agent-messaging-high-level-plan.md`,
`2026-11-14-agent-messaging-spike1-results.md`.

- **Spike 1b** closes the three gaps spike 1 left in the `asyncRewake` delivery: how long a waiter
  can wait, what happens to a message that was picked up but not delivered, and a wake that
  arrives while background work is running.
- **Spike 2** is the socket part of the plan's spike 2: a held request against the SSH
  sessions-per-connection limit, and re-forwarding after the ControlMaster is replaced. The third
  item of spike 2 (headless Claude over a non-interactive SSH command) belongs to fresh workers
  and was not run.

## Summary

| Question | Result |
|---|---|
| How long can a waiter wait | With no `timeout` it is killed at exactly 600 s, silently. With `timeout` set to 1, 7 or 30 days it was still alive after 31 minutes idle and then delivered |
| Message picked up, Claude dies before delivering | **Lost.** A resume does not deliver it |
| Wake while a background shell runs | Delivered, but **the marker then reads finished while the shell is still running** |
| Wake while a background subagent runs | Delivered, marker correct |
| Wake while the agent's own question dialog is open | Held until answered, marker correct, but **the agent did not answer the message** |
| Wake while a background subagent's permission dialog is open | Delivered to the main agent anyway, and **the marker drops from `blocked` to `working` with the dialog still open** |
| Held requests against `MaxSessions` | **Not counted.** 40 held with all 10 session slots in use; 200 held at once |
| Forward after the master is replaced | Works as remove-then-forward. Re-issuing the forward is not a health check |

**This corrects spike 1.** That document says the markers stay correct with the installed agent
hook unchanged. That holds for the cases it tested. It does not hold when a background shell is
running or a subagent is waiting on a permission dialog, so build order B does need a small change
to the agent hook.

## Setup

- Claude Code `2.1.325`, Haiku 5.5, tmux 3.6, OpenSSH 10.2 (client and server), all on the
  Tmuxifier host. No box was touched.
- Claude sessions ran in a second private tmux server (`tmux -L spike1b`) from a scratch project,
  with `--setting-sources project` and the hooks passed per session through `--settings <file>`.
- The marker tests used the installed `~/.claude/tmuxifier-agent-hook.sh`, wired by copying its
  13 hook entries into the session's settings file, as in spike 1.
- The socket tests ran against a private `sshd` with the same shape as `test/helpers/localBox.js`
  (ephemeral port, temporary host key and `authorized_keys`, fixture home) plus `MaxSessions 10`,
  the fleet's value. The ControlMaster was opened with the arguments `buildProbeArgv` produces,
  including `ControlPersist=600`, the live setting. The backend was a 15-line HTTP server on a
  unix socket.

## Spike 1b: the `asyncRewake` gaps

### How long a waiter can wait

Four idle sessions, each with a waiter armed at `SessionStart` and nothing typed:

| `timeout` in the hook entry | Result |
|---|---|
| not set | Killed at 600 s to the second. Nothing shown on screen, nothing re-armed |
| `86400` (1 day) | Alive after 31 minutes idle; a message dropped then was delivered within a second |
| `604800` (7 days) | Alive after 31 minutes idle; a message dropped then was delivered within a second |
| `2592000` (30 days) | Alive after 31 minutes idle; a message dropped then was delivered within a second |

So the timeout must be set explicitly, and the largest value tried was accepted. A wait of hours
or days was not observed directly.

The waiter also survives `/clear`: the old process kept running, the `SessionStart` that `/clear`
fires found the lock held and stood down, and a message dropped afterwards was delivered.

### A message picked up but not delivered

The waiter removes a message from the mailbox and exits; Claude Code then delivers it. While a
permission dialog is open that second step waits. With a message held that way, the Claude process
was killed (`SIGKILL`):

- The mailbox was already empty.
- The transcript holds one trace of the message, a `queue-operation` `enqueue` entry.
- `claude --resume` showed the interrupted tool call and an empty prompt. No `UserPromptSubmit`
  fired and the message was never delivered.

The message is lost unless the backend treats "handed to the waiter" and "delivered" as two
states. Spike 1 showed that a delivered message always arrives through a `UserPromptSubmit` whose
prompt contains it, which is where delivery can be confirmed.

### A wake while a background shell runs

The agent started `sleep 45` in the background and ended its turn. Ten seconds later a message
arrived.

```
…212.494 working:prompt   busy=[]      operator's prompt
…214.077 working:prompt   busy=[bg]    background shell launched
…215.136 working:prompt   busy=[bg]    Stop; the token keeps it working (correct)
…223.129 working:resume   busy=[]      the wake; the token is gone
…225.137 ready:stop       busy=[]      Stop after the woken turn: reads finished
…259.119 working:resume                the shell really finishes, 34 s later
…260.802 ready:stop
```

The message was delivered and answered. The marker is wrong from 225 to 259: it reads finished
while the shell runs, then finishes a second time. The cause is in the hook's `prompt` branch. A
wake arrives as a prompt containing `<task-notification>`, and the hook takes every such prompt to
mean "a background shell finished", so it deletes the `bg.` tokens. The two prompts can be told
apart: a real completion carries a `<task-id>` element, a wake carries only
`<summary>…</summary>`.

Also seen: the `Stop` payload's `background_tasks` listed the shell as `shell:running` at both
early `Stop` events and was empty at the last one.

### A wake while a background subagent runs

With a subagent in the middle of a 40 s command, the wake was delivered, the following `Stop`
found the `sub.` token and wrote `working`, and the marker reached `ready` only when the subagent
finished. Correct.

### A wake while a subagent's permission dialog is open

The same subagent first asked for permission, so its dialog was on screen and the marker read
`blocked/permission`. A message arrived at that point.

```
…388.581 blocked:permission   busy=[sub]   the subagent's dialog opens
…399.114 working:resume       busy=[sub]   the wake reaches the main agent
…400.810 working:prompt       busy=[sub]   Stop after the woken turn
                                           (dialog still open, for another 63 s)
```

Two things differ from spike 1, where the dialog belonged to the main agent:

- **The wake is not held.** The main agent was idle, so it was woken and answered while the
  subagent's dialog stayed on screen.
- **The marker lost the block.** The wake's `UserPromptSubmit` wrote `working` over `blocked`, and
  the session read as working although it was waiting for the operator.

### A wake while the agent's own question dialog is open

The agent asked a question with `AskUserQuestion` and a message arrived while the dialog was up.
The wake was held until the operator answered, as with a permission dialog, and the marker stayed
`blocked/question` throughout, then `working`, then `ready`. Correct.

The message was delivered inside the same turn, after the answer, and **the agent did not answer
it**. The operator's prompt had said to reply with exactly `chosen <colour>`; the turn ended with
`chosen red` and nothing else. A message delivered into a running turn competes with that turn's
instructions and can lose.

### Wake labels

The settings schema inside the binary lists two more fields on an `asyncRewake` hook,
`rewakeSummary` and `rewakeMessage`, both described as internal. They work from a settings file:
with `"rewakeSummary": "Agent mail"` the screen showed `● Agent mail` in place of
`● Stop hook feedback`, and `rewakeMessage` replaced the
`Stop hook blocking error from command "…":` prefix in what Claude receives. They are not in the
documentation.

## Spike 2: the socket under real conditions

### Held requests and the session limit

`ssh -O forward -R <box socket>:<backend socket>` onto the live master, then:

| Situation | Result |
|---|---|
| 10 of 10 session slots in use (one watch-like stream, nine others) | An 11th session is refused: `Session open refused by peer`, and ssh falls back to its own connection |
| Same, plus 40 requests held for 20 s through the forwarded socket | All 40 answered; the backend saw 40 open at once |
| 8 slots in use, 40 requests held | New sessions open over the master as usual |
| 200 requests held at once | All 200 answered |

A request on the forwarded socket is not a session and does not use a slot, in either direction.
The `tmx wait` call itself runs on the box as a local process, so it uses no slot either.

### The forward's lifecycle

| Event | What happens |
|---|---|
| The watch-like stream ends | The forward stays; it belongs to the connection, not to a session |
| Backend stops, master alive | Calls from the box fail at once (curl exit 56) |
| Backend starts again on the same path | Calls work again with no re-forward |
| Master killed with a request held | The held call fails at that moment (curl exit 52, empty reply) |
| Any end of the master (`SIGKILL`, `-O exit`) or `-O cancel` | The socket file on the box stays behind; calls on it fail at once (exit 7) |
| `-O forward` with that file present | Fails, exit 255: `remote port forwarding failed for listen path …` |
| Remove the file over ssh, then `-O forward` | Works, 13 ms for both steps |
| `-O forward` repeated on a master that already holds it | Exit 0, nothing done |
| Socket file deleted on the box under a live master, then `-O forward` | **Exit 0 and still broken.** `-O cancel` then `-O forward` repairs it |
| Forward present, no session, no traffic | **The master exits at `ControlPersist`.** A forward alone does not keep it alive |
| A request held across the `ControlPersist` deadline | The master stays until the request ends, then the timer starts |
| A session open (the watch stream's role) | The master stays |

Related observations:

- After the master was killed, the next probe-shaped command ran without the "disabling
  multiplexing" warning and a new master was running afterwards. The new master has no forward.
- The live service's masters run inside its cgroup, and the unit has `KillMode=control-group`
  (read-only check). Every service restart therefore ends every master, and with it every forward.
- A unix socket path is limited to 108 bytes. The first attempt at this spike failed on it
  (`ControlPath too long`), because the scratch directory's path was long. The limit applies to
  the backend's per-box listener and to the socket path on the box as well.
- A symlink on the box pointing at the forwarded socket works as the address
  (`curl --unix-socket <symlink>`), which allows a fresh socket name per master with a stable
  path for the agent.

## What this changes for the design

1. **The agent hook changes after all, in one place.** Its `prompt` branch has to recognise a
   mail wake, and for a wake it must not clear `bg.` tokens and must not write `working` over
   `blocked`. The wake format is observed behaviour of 2.1.325, so it needs a recorded trace
   beside `test/fixtures/claude-hook-trace.jsonl`.
2. **Set the waiter's `timeout` explicitly.** The default ends it after ten minutes with nothing
   to re-arm it until the session's next `Stop`.
3. **Two delivery states.** "Handed to the waiter" is not "delivered". Delivery is confirmed by
   the `UserPromptSubmit` that carries the message; anything handed over and never confirmed has
   to be offered again, for example when the session's next waiter connects.
4. **Delivered does not mean answered.** A message that lands in a running turn can be fused with
   that turn's answer (spike 1) or ignored (above). The sender's `wait` needs a way to end without
   a reply, and the thread view should be able to show "delivered, no reply".
5. **The waiter must outlive the socket.** Every Tmuxifier restart drops every forward, and a
   held request then fails at once. A waiter that exits on that error is not re-armed, so it has
   to retry until the socket is back.
6. **The backend can see who is listening.** A waiter is a held request on a per-box listener, so
   the backend knows which sessions currently have one. That is the natural source for "can
   receive now", and for showing a session whose waiter has died.
7. **Forward upkeep.** After every new master: remove the old socket file, then forward. Re-issuing
   `-O forward` proves nothing, so the check has to be a call that travels through the socket.
   The repair for a live master is cancel, remove, forward.
8. **The master's lifetime is already covered** while the watch stream or the 30 s sweep keeps a
   session coming. A box whose stream is held back and whose sweep stops would lose the master,
   and the forward, after `ControlPersist`.
9. **Keep socket paths short**, and check the length when the listener is created.
10. **Session slots are not a concern** for messaging. The plan's question in spike 2 is answered:
   a held `wait` does not count.

## Not tested

- A waiter idle for hours or days.
- A wake while the main agent shows a plan-approval dialog.
- A wake after a plain "No" to a permission prompt, where the marker deliberately stays
  `blocked`.
- A real box, a master behind a jump host, a box reboot, and OpenSSH older than 10.2 (the fleet
  reported 9.2 or newer).
- Headless Claude over a non-interactive SSH command on a seeded box.

## Leftovers

- Claude Code recorded the second scratch directory as trusted in `~/.claude.json` and kept its
  transcripts under `~/.claude/projects/`. Neither was removed.
- Socket files went into one short directory under `/tmp` because of the 108-byte limit. It was
  removed.
