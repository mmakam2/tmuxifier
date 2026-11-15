# Agent messaging: spike 1 results (delivery against a real Claude Code)

**Date:** 2026-11-14
**Status:** findings from a throwaway spike. No product code was written; the scratch project and
its hooks were deleted afterwards. The hooks used are reproduced in the appendix.
**Plan:** `2026-11-14-agent-messaging-high-level-plan.md`, sections 5.6, 8 and 9.
**Correction, same day:** the statement below that `asyncRewake` keeps the markers correct with
the agent hook unchanged holds only for the cases tested here. It fails when a background shell is
running or a subagent is waiting on a permission dialog; see
`2026-11-14-agent-messaging-spike1b-and-spike2-results.md`.

## Summary

| # | Question | Verdict |
|---|---|---|
| 1 | Headless round trip | **Works.** One caveat for callers and one for shared conversations |
| 2 | Turn-end handover (`Stop` hook, `decision: "block"`) | **Works with caveats.** It is the only delivery that leaves the agent state wrong |
| 3 | Waking an idle session | **Works** with `asyncRewake`, nothing typed. The typed nudge also works but is not needed and is unsafe |
| 4 | Agent state markers | Correct for `asyncRewake` and the nudge; **wrong for the `Stop` handover**; no marker at all for a headless worker |

The main result: one mechanism, an `asyncRewake` hook that waits for mail, delivered a message
into a session that was idle, in the middle of a turn, and sitting on a permission dialog. It typed
nothing, left an unsent draft alone, and kept the markers correct with the installed agent hook
unchanged.

**Recommendation: build order B** (running sessions first), delivered by `asyncRewake` rather
than by a `Stop` hook. Reasons are in [Build order](#build-order).

## Setup

- Claude Code `2.1.325`, tmux 3.6, all on the Tmuxifier host. No box was touched.
- Model: Haiku 5.5 (`--model haiku`) for every run. About 45 turns, each a one-line prompt.
- Scratch project in the session scratchpad (`<scratch>/proj` below), hooks in its own
  `.claude/settings.json`. Every run used `--setting-sources project`.
- Interactive sessions ran in a private tmux server (`tmux -L spike1`, started with a clean
  environment), session `zz-spike1`, pane `%41`. The operator's server had only pane `%0`.
- Every hook appended its stdin payload to a log, which is where the payloads below come from.
- Hook behaviour was checked against the hooks and headless documentation on the same day:
  `Stop` decision control, `asyncRewake`, `UserPromptSubmit` `additionalContext`.

## 1. Headless round trip

**Verdict: works.**

### Task in, result out

```
claude -p "The codeword is PLUM-41. Reply with exactly: stored" \
  --session-id $U --output-format json --model haiku --setting-sources project
```

Exit 0 in 2.1 s. The answer is in `.result` (`"stored"`). The rest of the object:
`session_id`, `is_error`, `subtype` (`success`), `terminal_reason` (`completed`), `stop_reason`,
`num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage`,
`permission_denials`, `subagent_stats`, `uuid`, and timing fields.

### Follow-up

`claude -p "What was the codeword? Reply with only the codeword." --resume $U --output-format json`
returned `"result": "PLUM-41"` under the same `session_id`. Context is kept.

### Opening it interactively

`claude --resume $U` in the private tmux pane showed both earlier exchanges as normal history.
A new directory raises the folder-trust dialog first, and its default choice is "No, exit".

### Two processes on one conversation

While that interactive session was open, a third headless `--resume $U` turn ran and succeeded.
The interactive session never saw it: asked about the new turn's content, it answered `NONE`.
The transcript file shows why. Both new user messages have the same parent, so the conversation
forked. After exiting and resuming again, only the interactive branch was shown; the headless turn
was no longer part of the visible conversation.

### A Bash command it may not run

Task: run `python3 -c 'print(6*7)'` with the Bash tool. Three runs, each a new session:

| Flags | Hang | Exit | `is_error` | `permission_denials` | What Claude was told |
|---|---|---|---|---|---|
| (default) | no, 4.5 s | 0 | false | the Bash call | `This command requires approval` |
| `--permission-mode acceptEdits` | no, 3.9 s | 0 | false | the Bash call | `This command requires approval` |
| `--permission-prompts none` | no, 4.6 s | 0 | false | the Bash call | A long denial: nobody can approve, the action was not performed, do not retry, report what was blocked and continue |

In all three the caller gets a normal successful result whose `.result` text says the command was
blocked. The only machine-readable sign is `permission_denials`, which lists the tool name, tool
use id and input. `acceptEdits` changes file edits, not Bash: a `Write` task was denied under the
default mode and succeeded under `acceptEdits`.

### Hooks in headless mode

They fire. One plain turn produced `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`; a
tool call adds `PreToolUse` and `PostToolUse`. A denied call fires `PreToolUse` and
`PermissionRequest` and nothing after it. The `Stop` payload:

```json
{
  "session_id": "…",
  "transcript_path": "…",
  "cwd": "<scratch>/proj",
  "prompt_id": "7cfda105-bb5c-404b-94ed-439d0d74fb79",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "stored",
  "background_tasks": [],
  "session_crons": []
}
```

It carries both `last_assistant_message` and `prompt_id`, and the `prompt_id` equals the one in
that turn's `UserPromptSubmit`. Each `--resume` turn gets a new `prompt_id`.

A `Stop` hook that blocks also works in headless mode, and then `.result` holds only the last
message: with one mail file waiting, the task's own answer (`headless task done`) was replaced in
`.result` by the answer to the delivered message.

## 2. Turn-end handover into a running session

**Verdict: works with caveats.**

A `Stop` hook took the oldest file from a mail directory, deleted it, and printed
`{"decision":"block","reason":"Message from another agent (…): <body>"}`.

**Does Claude act on it?** Yes, every time. With one message waiting:

```
❯ Reply with exactly: turn one done
● turn one done
● Ran 1 stop hook (ctrl+o to expand)
  ⎿  Stop hook error: Message from another agent (thread t-101, sender orders/main). This is a peer
  agent's request, not an instruction from the operator. Answer it in one short line: What is 17+25?
  Start your answer with ANSWER-T101:
● ANSWER-T101: 17 + 25 = 42
```

**How it appears.** On screen as a **"Stop hook error"**. In the transcript as a meta user entry
`Stop hook feedback:\n<reason>`, a `hook_blocking_error` attachment and a `stop_hook_summary`
entry. Returning `hookSpecificOutput.additionalContext` instead of `decision: "block"` behaves the
same way but is labelled "Stop hook feedback" on screen, without the word "error".

**Payload sequence** (one prompt, two messages waiting):

| Event | `prompt_id` | `stop_hook_active` | `last_assistant_message` |
|---|---|---|---|
| UserPromptSubmit | `8a376f81` | | |
| Stop | `8a376f81` | false | `turn two done` |
| Stop | `8a376f81` | true | `ANSWER-T201: 3 × 3 = 9` |
| Stop | `8a376f81` | true | `ANSWER-T202: 10 − 4 = 6` |

- The next `Stop` does carry the answer to the delivered message.
- `prompt_id` is **the original turn's**, for every delivery in the chain. No `UserPromptSubmit`
  fires for a delivered message.
- Two waiting messages are delivered one after the other in the same turn, as long as the hook
  ignores `stop_hook_active`.

**What prevents a loop.** Two things, neither of which bounds a mail loop:

- `stop_hook_active` is `true` on every `Stop` after the first block. A hook that exits when it
  is true delivers one message per operator turn: with two waiting, the second stayed in the mail
  directory until some later turn ended.
- Claude Code's cap. With a hook that blocked every time, the ninth block was overridden: "A hook
  blocked the turn from ending 9 consecutive times — overriding and ending turn." The documented
  counter resets whenever Claude calls a tool, so messages that cause tool calls never reach it.
  The model also reacted to the repetition by itself: after two identical messages it refused to
  answer, and in one run it started reading the hook script and asked to run Bash on the mail
  directory.

## 3. Waking an idle session

**Verdict: `asyncRewake` works. The typed nudge works with caveats and is not needed.**

### `asyncRewake`

A waiter script, registered on `SessionStart` and `Stop`:

```json
{ "type": "command", "command": "<scratch>/proj/.claude/hooks/wait-mail.sh Stop",
  "asyncRewake": true, "timeout": 3600 }
```

It holds a lock so only one waiter runs, polls the mail directory, and on a message prints it to
stderr and exits 2.

| Session state when mail arrived | What happened |
|---|---|
| Idle, never prompted | Woke within a second and answered. Nothing typed |
| Idle, unsent draft in the input box | Woke and answered. **The draft was still in the input box afterwards** |
| Idle, two messages dropped together | Two separate turns, one per message |
| Mid-turn (a 20 s Bash command running) | Delivered inside the running turn, right after the tool finished |
| Permission dialog open | Dialog untouched. Delivered after the operator approved, in the same turn |
| Permission dialog open, operator pressed Esc | Delivered as a new turn straight after the interrupt |

On screen a wake shows only `● Stop hook feedback` followed by the answer. The message body is
not displayed. Claude receives it as a prompt, and `UserPromptSubmit` fires with it:

```json
{
  "prompt_id": "b0e5bc34-639e-4e65-80b2-ba5474174902",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"SessionStart:startup\": Message from another agent (thread w-101, …): What is 6*7? Start your answer with ANSWER-W101:\n\n</system-reminder>"
}
```

- A wake of an **idle** session gets a **new `prompt_id`**, and the following `Stop` has a clean
  `last_assistant_message` (`ANSWER-W101: 42`) with `stop_hook_active: true`.
- A wake **mid-turn** fires `UserPromptSubmit` with the **running turn's `prompt_id`**, and the
  single `Stop` has both answers fused: `"slept\n\nANSWER-W103: 100"`.
- The waiter is one-shot. The `Stop` at the end of the woken turn arms the next one, which is how
  the second of two messages was delivered 5 ms after the first turn ended.
- The `timeout` is enforced. With `timeout: 15` the waiter was killed at 15.0 s with no message
  on screen, nothing re-armed it, and mail dropped afterwards was not delivered. The waiter is
  also killed when the session exits.
- The waiter deletes the mail file before Claude Code delivers it. During a permission dialog the
  message sat inside Claude Code for as long as the dialog stayed open.

### Typed nudge with `additionalContext`

`tmux send-keys -l '<nudge>'` then `Enter`, with a `UserPromptSubmit` hook that returns the mail
as `hookSpecificOutput.additionalContext` when the prompt contains the nudge token.

- **The agent sees the content** and answers it.
- **The nudge wording matters.** With the bare token `tmx-mail` as the whole prompt, the model
  answered the message and then went looking for what `tmx-mail` meant, asking to grep the project
  and `~/.claude/projects`. With a self-explanatory line ("A message from another agent is
  attached to this prompt. Answer only that message.") it only answered.
- **Unsent draft:** the nudge is appended to it and the whole line is submitted. The operator's
  half-typed text was sent as a prompt and the input box was empty afterwards:
  `half-typed operator draft about deleting the old[tmx-mail] A message from another agent …`
- **Mid-turn:** the line is queued. `UserPromptSubmit` fired at once, so the hook consumed the
  mail 11 s before Claude read it, and the turn's final message was only the answer to the mail.
  The operator's own task result (`slept`) never appeared.
- **Permission dialog open:** keystrokes go to the dialog and `Enter` confirms the highlighted
  choice, which is "1. Yes". This happened by accident during the spike; see
  [Deviations](#deviations-and-leftovers).

## 4. Agent state markers

**Verdict: correct for `asyncRewake` and the nudge, wrong for the `Stop` handover, absent for
headless.**

The isolation rule was met. The marker was `~/.tmuxifier-agent/zz-spike1%41`; the live server
builds agent state only for sessions its own tmux listing returns, so the session never appeared.
`data/health-events.json` gained no event during the run and never mentions the session. The hook's
own `SessionEnd` removed the marker; nothing was left to delete, and `local%0` was not touched.

How the hook was activated: the 13 hook entries that call `~/.claude/tmuxifier-agent-hook.sh` were
copied unchanged from the user settings into the scratch project's settings, next to the spike
hooks, and the session still ran with `--setting-sources project`. The script and its wiring are
the installed ones; plugins, the status line and the voice hook stayed out.

| Delivery | Marker sequence | Correct |
|---|---|---|
| Plain turn (baseline) | `ready/start` → `working/prompt` → `ready/stop` | yes |
| `Stop` handover | `working/prompt` → `ready/stop` → *(11 s of work on the delivered message)* → `ready/stop` with a new timestamp | **no** |
| `asyncRewake`, idle | `ready/stop` → `working/resume` → `ready/stop` | yes |
| `asyncRewake`, mid-turn | `working/prompt` → `working/resume` → `ready/stop` | yes |
| `asyncRewake`, dialog open | `working/prompt` → `blocked/permission` (unchanged when the mail arrived) → `working/resume` after approval → `ready/stop` | yes |
| Typed nudge, idle | `ready/stop` → `working/prompt` → `ready/stop` | yes |
| Headless (`-p`, no `$TMUX`) | no marker written | n/a |

The `Stop` handover timeline:

```
…893.431 working:prompt        operator's prompt
…894.804 ready:stop            first Stop; the hook hands over the message
…896.8   PreToolUse Bash       Claude is working on the delivered message
…904.9   PostToolUse Bash
…906.181 ready:stop            second Stop, new timestamp
```

For those 11 seconds the session read as finished while it was working, and it then finished a
second time with a newer timestamp. The cause is structural: the agent hook's `stop` branch and
the delivery hook run side by side, and no `UserPromptSubmit` fires for the handover, so nothing
writes `working`. `asyncRewake` avoids it because the wake arrives as a `UserPromptSubmit` whose
prompt contains `<task-notification>`, which the installed hook already maps to `working/resume`.

Read from the hook's code, not observed: the nudge is an ordinary prompt, so it takes the hook's
operator branch and clears every background-work token (`rm -rf` of the busy directory), where a
`<task-notification>` clears only `bg.` tokens. A nudge during background subagents would let the
next `Stop` read as finished.

## Build order

**B, running sessions first, delivered by `asyncRewake`.**

- It is the operator's stated case, and the spike removed the reason the plan gave for putting it
  off. Option B was listed as "changes the agent hook, which every state feature depends on".
  With `asyncRewake` the delivery is a separate hook entry beside the agent hook, the agent hook
  script is not edited, and the markers stayed correct in every state tested.
- One mechanism covers three rows of the delivery table in 5.6: idle, working and blocked. The
  `Stop` handover and the typed nudge are not needed.
- Fresh workers (A) work as documented, but still have open items that this spike did not close:
  starting headless Claude over a non-interactive SSH command with a seeded token (spike 2), and
  the fact that a headless worker has no tmux session and writes no marker (see below).
- C would validate the hook work and the worker lifecycle together for no gain; the plumbing
  (store, socket, command, policy) is exercised just as well by B alone.

What B has to get right, from the results above:

1. **Replies go through `tmx reply`, not `last_assistant_message`.** A wake of an idle session
   gives a clean message and its own `prompt_id`; a wake mid-turn gives neither.
2. **The waiter's lifecycle.** One per session, re-armed on `SessionStart` and `Stop`, and a
   decision about `timeout`: it is enforced and nothing re-arms a waiter that timed out. The
   largest accepted value and behaviour over hours were not tested.
3. **Acknowledge on delivery, not on pickup.** The waiter hands the message to Claude Code and
   exits; delivery can be much later (an open dialog). The `UserPromptSubmit` that carries the
   message is the point where it is known to have reached the agent.
4. **Pin the format with a recorded trace.** That a wake arrives as a `<task-notification>` prompt
   is observed behaviour of 2.1.325, not a documented contract, and the correct marker state
   depends on it.
5. **A per-thread budget in the backend** remains necessary. Claude Code's own cap does not bound
   an exchange whose messages cause tool calls.

## Where the results contradict the plan

1. **Section 4, "Two processes on one conversation are not locked out and interleave."** They are
   not locked out, but they do not interleave. The conversation forks, the open session never sees
   the other process's turn, and a later resume shows only one branch.
2. **Section 4, "A turn's answer can be tied to the prompt that started it."** True for headless
   turns and for wakes of an idle session. Not true for a `Stop` handover (every delivered message
   reports the operator's original `prompt_id`) or a mid-turn wake (same `prompt_id`, answers
   fused into one `last_assistant_message`).
3. **Section 5.6, delivery table.** "Session idle: unproven" is now proven with `asyncRewake`.
   "Session working: hand over at `Stop`" works but is the worse choice: it breaks the marker
   state and shows as a "Stop hook error". "Session blocked: hold" needs no logic of its own with
   `asyncRewake`, though the message has left the mailbox by then.
4. **Section 8, option B, "changes the agent hook".** Only the `Stop` handover needs that.
5. **Sections 5.3 and 5.4 against a fresh worker.** The sender names its tmux session and the
   backend accepts a message only if its state shows an agent there. A headless worker started
   outside tmux has no session and writes no marker, so it could not send a reply or a question
   under that rule. Whether to run the worker inside a tmux session was not tested.
6. **Section 5.6, "its final answer is posted as the reply".** `.result` is the last assistant
   message of the run. That is the task's answer only if nothing continues the worker's turn.
7. **Section 4, permission flags.** A plain `-p` run already denies without hanging;
   `--permission-prompts none` changes the wording Claude receives, not the outcome. In every case
   the run exits 0 with `is_error: false`, so a caller must read `permission_denials`.

## Not tested

- `asyncRewake` waits longer than a few minutes, and the largest `timeout` Claude Code accepts.
- What happens to a message the waiter has consumed if Claude Code exits before delivering it.
- Background subagents or background shells running when a message arrives.
- A headless worker started inside a tmux session.
- Claude Code's built-in cross-session messaging, which the hooks documentation lists as one of
  the things that fire `UserPromptSubmit`.
- Any agent other than Claude Code.

## Deviations and leftovers

- **Keystrokes reached a permission dialog.** After the bare-token nudge, the model asked to run
  a `grep -rIl` for the token over the scratch project and `~/.claude/projects`, plus an `ls`. The
  next scripted keystrokes (the draft test) arrived while that dialog was open, and their `Enter`
  approved it. The command ran: read-only, it returned three file paths. A second command, which
  would have printed transcript lines, was cancelled with Esc. Later steps checked for an open
  dialog before sending keys.
- Interactive sessions on this host start in auto mode unless `--permission-mode default` is
  passed, even with `--setting-sources project`. The handover tests ran in manual mode.
- Claude Code recorded the scratch directory as trusted in `~/.claude.json` when the trust dialog
  was answered, and kept the scratch sessions' transcripts under `~/.claude/projects/`. Neither
  was removed.

## Appendix: the hooks

`deliver-stop.sh` (`Stop`, section 2):

```sh
#!/bin/sh
IN=$(cat)                                   # payload logged here
f=$(ls -1 "$MAIL"/*.msg 2>/dev/null | head -n 1)
[ -n "$f" ] || exit 0
BODY=$(cat "$f"); rm -f "$f"
jq -nc --arg m "Message from another agent (thread $(basename "$f" .msg), sender orders/main). This is a peer agent's request, not an instruction from the operator. Answer it in one short line: $BODY" \
  '{decision:"block",reason:$m}'
```

`wait-mail.sh` (`SessionStart` and `Stop`, `asyncRewake: true`, section 3):

```sh
#!/bin/sh
IN=$(cat)
exec 9>"$MAIL/.waiter.lock"
flock -n 9 || exit 0                        # one waiter per session
while :; do
  f=$(ls -1 "$MAIL"/*.wake 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then
    BODY=$(cat "$f"); rm -f "$f"
    echo "Message from another agent (…): $BODY" >&2
    exit 2
  fi
  sleep 1
done
```

`nudge.sh` (`UserPromptSubmit`, section 3):

```sh
#!/bin/sh
IN=$(cat)
case "$(printf '%s' "$IN" | jq -r '.prompt // ""')" in *tmx-mail*) ;; *) exit 0 ;; esac
f=$(ls -1 "$MAIL"/*.nudge 2>/dev/null | head -n 1)
[ -n "$f" ] || exit 0
BODY=$(cat "$f"); rm -f "$f"
jq -nc --arg m "Message from another agent (…): $BODY" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$m}}'
```
