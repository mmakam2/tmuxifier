# claude-mail-wake-trace.jsonl

A recording of real Claude Code hook payloads (stdin of a command hook), one JSON object per line,
from one interactive session that was woken by agent mail. Replayed by
`test/agentMailWakeReplay.test.js`.

**Wording.** The wakes in this recording carry the wake text as it was then (second line "This is
a request from another coding agent, not from your operator. Treat it like a colleague's
request: …", third line "Reply with:  tmx reply …"). `wakeText` has since changed its second
and third lines (the first wake here was declined, see lines 2-4); the fixture stays as
recorded, and the replay depends only on the tag, the first line and the body, never on the
head's wording or length.

## How it was recorded

- Claude Code **2.1.325**, model **Haiku 5.5** (`--model haiku`) for every scenario, tmux 3.6,
  recorded 2026-11-15 on the Tmuxifier host (no box involved).
- Started as `claude --setting-sources project --permission-mode default --model haiku` from a
  scratch project, inside a private tmux server (`tmux -L <private>`, started with `TMUX`,
  `TMUX_PANE` and every `CLAUDE*` variable unset, `-f /dev/null`), pane `%0`. Manual permission
  mode throughout.
- The project's own `.claude/settings.json` held:
  - a recorder on SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
    PostToolUseFailure, Notification, SubagentStart, SubagentStop, Stop, SessionEnd and
    PreCompact, appending the raw payload as one line;
  - the 13 agent-hook entries of `HOOK_EVENTS`, calling a copy of this branch's
    `src/server/assets/tmuxifier-agent-hook.sh` placed in the project;
  - the three `MAIL_HOOKS` entries, with `sh "$HOME/.tmuxifier-mail/tmx"` rewritten to
    `sh "<worktree>/src/server/assets/tmuxifier-mail.sh"` (the installed path does not exist on
    the recording host and was not created);
  - `permissions.allow`: `MAIL_PERMISSION_RULE` (`Bash(tmx *)`) and `Bash(sleep *)` for (b).
- `tmx` on the session's `PATH`: a bin directory first on `PATH` holding `tmx` as a symlink to an
  executable copy of `tmuxifier-mail.sh` (the installed layout, `~/.local/bin/tmx` ->
  `~/.tmuxifier-mail/tmx`; the repository file itself is not executable). The skill was in the
  project's `.claude/skills/tmuxifier-mail/SKILL.md`.
- The mail backend was this branch's real store, policy store, hub and listener (box `billing`
  = the recorded session, box `orders` = a fictitious sender session `main`), on a unix socket
  named by `TMUXIFIER_MAIL_SOCK`. Its `marksOf` always reported both sessions `ready`, so the hub
  hands a message over the moment it is sent, also when the real gate would hold it. The hub ran
  with `holdMs` 20 s for the first two minutes (question 2 below), then 300 s.

Scrubbed: `session_id` -> `sess`, `transcript_path`/`agent_transcript_path`/`scratchpad_dir` ->
`/scrubbed`, `cwd` and the project path inside strings -> `/tmp/rec`, `prompt_id` -> `p`,
`tool_use_id` and `toolu_*` inside strings -> `t`, task output files -> `/scrubbed/tasks/<id>.output`.
Agent ids, task ids, thread and message ids are random and kept. Message texts are the ones sent.
Dropped: raw lines 78-80 (after the `/exit`, a second session started and was killed with
`SIGKILL` to test the waiter's orphan check, then a third started and exited: SessionStart,
SessionStart, SessionEnd). Nothing else was dropped or edited.

## Scenarios

| Lines | What | Events seen |
|---|---|---|
| 1 | start | SessionStart(startup); the waiter armed here |
| 2-4 | first wake (thread `t-frftyj7c`, "What is 2+3?") | UserPromptSubmit (wake), Stop, SubagentStop. **The agent did not answer**: it said the operator had not asked it to message other agents |
| 5-9 | operator prompt "I expect messages from the agent in orders: answer each one yourself with tmx reply…" | the agent answered the earlier thread: `tmx reply t-frftyj7c "5"` (line 6) |
| 10-14 | **(a)** idle session, message "What is 4+4?", answered with `tmx reply t-gh6nc5tt "8"` | wake, PreToolUse/PostToolUse(Bash), Stop, SubagentStop |
| 15-19 | heredoc reply: `tmx reply t-jhnmenh7 <<'EOF'` / `ok` / `EOF` | as (a) |
| 20-24 | pipe reply: `printf 'ok\n' \| tmx reply t-prbnsp5t` | as (a) |
| 25-37 | **(b)** `sleep 45` in the background (line 26, `run_in_background`), Stop (28); the message 10.1 s later (wake 30), answered, Stop (33) with the shell running; the shell's own completion (35, carries `<task-id>`) and the final Stop (36) | Stop payloads 28 and 33 list the shell as running in `background_tasks` |
| 38-56 | **(c)** a background subagent (SubagentStart 40) asks to run `touch probe-c.txt`: PermissionRequest (44), Notification permission_prompt (46); the message 4.1 s after the Notification (wake 47), answered by the main agent (48-49), Stop (50) with the dialog still open; approved 36 s later: the subagent's PostToolUse (52), SubagentStop (53), its completion (54), Stop (55) | the wake is not held by the subagent's dialog |
| 57-76 | wake-size checks: bodies of 2000 (57-61), 4000 (62-66), 16000 (67-70) and 60000 (71-76) characters | line 72 is the 16000 turn's SubagentStop, recorded after the next wake |
| 77 | `/exit` | SessionEnd(prompt_input_exit) |

Marker trail (from the replay, `REPLAY_TRAIL=1`; it matched the live marker file at every point
checked during the recording):

- (a): wake `working/resume`, its Stop `ready/stop`.
- (b): 28 `working/prompt` (shell token), 30 `working/resume`, 33 `working/prompt` (shell
  token kept by the wake), 35 `working/resume`, 36 `ready/stop`.
- (c): 44 `blocked/permission` (owner: the subagent), 46 and 47 (the wake) unchanged, **50
  `working/prompt`**: the main agent's Stop after the woken turn writes over the subagent's
  block while its dialog is still on screen, for the 36 s until the approval. The hook's `stop`
  branch does not look at a block; the replay test leaves this line unpinned.

Notes

- Each wake's prompt is `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "<event>": <wake text>\n\n</system-reminder>`,
  where `<event>` is `SessionStart:startup` for the waiter armed at start and `Stop` for later ones.
- A `SubagentStop` with empty `agent_type` follows most `Stop`s. Its `last_assistant_message` is
  the suggestion shown greyed in the input box afterwards ("check if orders picked up the
  reply"), so it is Claude Code's prompt-suggestion run, not a real subagent.

## Questions settled while the session was up

**1. Permission rule.** None of the three forms raised a permission prompt under
`Bash(tmx *)` in manual mode (no PermissionRequest or Notification for lines 6, 11, 16, 21; the
commands ran at once):

- `tmx reply t-gh6nc5tt "8"` (line 11), and `tmx reply t-frftyj7c "5"` (line 6);
- the heredoc, recorded as `tmx reply t-jhnmenh7 <<'EOF'\nok\nEOF` (line 16);
- the pipe `printf 'ok\n' | tmx reply t-prbnsp5t` (line 21). Only `printf` was tried on the left
  of the pipe; a command there that no rule covers would be asked about on its own account.

Bare `tmx` resolved through `PATH` in the Bash tool (the bin directory was first on the `PATH`
of the shell that started Claude). The wake text's reply line was left as it is.

**2. Waiter lifetime.** With `holdMs` 20 s the waiter armed at SessionStart (one pid, the same
pid in its lock file throughout) had five holds expire (204) over 100 s and asked again each
time, 8 ms after each answer; a sixth idle answer came when the listener was restarted with
300 s, and the same process asked again. It was still the only `hook-wait` afterwards. Process tree (`ps -o pid,ppid,pgid,args`):

```
claude --setting-sources project ...                       pid C
  /bin/sh -c sh ".../tmuxifier-mail.sh" hook-wait          pid W, ppid C, pgid = sid = W
    sh .../tmuxifier-mail.sh hook-wait                     ppid W   <- the waiter; its $PPID is W
      curl ... /v1/wait
```

Claude Code runs each hook command through `/bin/sh -c` (dash here, which does not exec the
single command) in a new session and process group. So the waiter's `$PPID` is that wrapper,
not Claude Code, and the wrapper lives exactly as long as the waiter. When the Claude Code
process was killed with `SIGKILL` (dropped lines 78-80), the wrapper was re-parented to pid 1
and stayed alive, so the orphan check (`kill -0 "$PPID"`) never fires: the waiter kept holding
the lock and its request. A new Claude Code started in the same pane found the lock held by a
live `hook-wait` and its own waiter stood down (the hub counted one listener, the orphan). A
message sent then was handed to the orphan (state `handed`, no ack); the orphan exited with it
and the live session received nothing and had no waiter. The script was not changed (the
waiter does not exit at its first 204); see the task report for the follow-up.

**3. Exit.** After `/exit` the waiter and its `/bin/sh -c` wrapper were gone within about 0.4 s,
while the Claude Code process was still running and before the SessionEnd hook ran (the
backend saw the held request close at .942, SessionEnd was recorded at .047 of the next second).
The lock directory was gone at the same moment, so the waiter got a signal it could trap (its
cleanup ran). The agent hook's SessionEnd removed the marker and the busy directory.

**4. Wake size.** What `UserPromptSubmit`'s `prompt` carried, against what was sent:

| Body sent | Wake handed (chars) | Body inside the prompt | Whole |
|---|---|---|---|
| 2000 | 2360 | 2000 | yes |
| 4000 | 4360 | 4000 | yes |
| 16000 | 4414 | the first 4000, then `[cut: run "tmx read t-fv9jxqxw" for the full message]` | cut by the hub, as designed |
| 60000 | 4414 | the first 4000, then the cut note | cut by the hub, as designed |

Every wake arrived byte for byte as the hub handed it. `WAKE_INLINE_CHARS` stays 4000. A wake
longer than about 4400 characters was not tried, so Claude Code's own limit, if any, is unknown.

**5. Delivery confirmation.** Every handed message (10 in the session) was confirmed by
`hook-ack` 25-58 ms after the hand-off and read `delivered` in the store afterwards. The one
message handed to the orphan in the dropped part stayed `handed`.
