# Agent workers: live walk on two real boxes

**Date:** 2026-11-21
**Status:** point-in-time record of plan Task 17. Candidate `feat/agent-workers` at 789215d,
deployed to the live app (build plus the changed server files) and the service restarted.
**Boxes:** two LXC containers that already had agent messaging paired with each other, called
`lead-box` and `target-box` here. Both: Debian or Ubuntu, `bash` as login shell and as tmux
`default-shell`, Claude Code 2.1.327 at the start (one worker session came up on 2.1.330 after
Claude Code updated itself), signed in interactively, auto mode. `CLAUDE_CONFIG_DIR` unset.
The operator's own Claude sessions on both boxes were left alone: every session used here was
started by the feature, in a new empty directory.

## How it was driven

- Setup was rerun on both boxes with the Claude tool ticked (new `tmx`, skill, auto-mode entry).
- Worker settings were written through `PUT /api/boxes/:id/workers` with a browser-session
  cookie, not through the Edit Box Save (Save also runs the box save and may start a setup job).
  The Edit Box section was opened and read in a headless browser, then cancelled.
- The lead was itself a worker: started on `lead-box` by the operator's route, then given
  one-line prompts that told it which `tmx` command to run.

## What was walked, and what happened

| Step | Result |
|---|---|
| Operator's Start (`POST …/workers/start`) on `lead-box`, trust tick on, directory never seen by Claude Code | Session `worker-walk-1` up in under a second, pane command `claude`, signed in, auto mode, **no trust question**, marker `ready/start`. The key was written to `~/.claude.json` |
| `tmx who` from the lead | Listed both boxes' running sessions and `target-box  can start an agent (projects: walk, walk2)` |
| `tmx send --fresh target-box "…"`, trust tick off | Ran in auto mode with no block. Answer: `Sent. Thread … queued: target-box/worker-walk-1 is starting`. The worker stopped at the trust question, no marker |
| Stuck start | After the lead's `tmx wait` ended: `queued: target-box/worker-walk-1 is waiting for its operator at a start-up prompt`. The operator's thread list showed the same |
| Trust question answered "Yes" by hand | The queued task was delivered about 7 s later by the real `tmx hook-wait` (the message had been queued before the session's `SessionStart`). The worker ran `tmx reply … "PONG-1"`. The lead, which had stopped waiting, was woken by the reply and reported it, without sending an acknowledgement back |
| `tmx send --fresh --project walk2 target-box "…"`, trust tick on | Session `worker-walk2-1`, no trust question, task delivered at once, reply received. The trust key was written while two other Claude Code sessions were running on the box; the file stayed valid and both keys were still present five minutes later |
| A third `--fresh` with the cap at 2 | `refused: target-box already runs as many started agents as its operator allows`, exit 1, logged for the operator, no session created |
| `/exit` in a worker with no pane on it | Session and marker gone |
| `--fresh --project walk4`, directory missing | `refused: the project directory is missing on target-box; tell your operator`, logged |
| `--fresh --project walk3`, trust question answered "No, exit" | Session ended. About 60 s after the start the thread closed: `closed: the new agent did not start; tell your operator`. The lead's `tmx wait` ended with that line; one entry in the refusal log |
| Edit Box → Agent workers (headless browser) | Four project rows, trust ticks, the messaging tick and the cap rendered with the saved values |
| Session picker on `target-box` | Session and window rows with ×, then one `Start Claude in <project>` row per project with no × |
| Picking `Start Claude in walk2` | Info toast, session `worker-walk2-2` created, the pane switched to it |
| Picking it again at the cap | Error toast: `this box already runs as many started agents as its limit allows` |
| `/exit` in a worker with the browser pane on it | The session was recreated under the same name as a plain `bash` shell, with no marker (design 5.8) |

No error was logged by the server during the walk.

## Not walked

- A bare box name starting a worker. Both boxes had the operator's own Claude in the configured
  session, so a bare send would have gone into that session.
- A Tmuxifier restart while a start is in flight.
- The kill × on a worker from the picker; the Edit Box Save path in a real browser (the
  end-to-end spec covers both against the fixture box).
- A default shell other than bash; an OpenCode lead using `--fresh`; a box where
  `CLAUDE_CONFIG_DIR` is set.
- The phone layout.

## Observations

- A worker's finished turns show as `done` on the box in the sidebar like any other session,
  and are subject to the same notifications.
- Claude Code updated itself between two starts on the same box (2.1.327, then 2.1.330). The
  trust key worked on both.

## Left on the boxes

The rerun setup's files (new `tmx`, skill, auto-mode entry); trust entries for the two test
directories in `~/.claude.json`; the test sessions' transcripts under `~/.claude/projects/`.
The test directories, the worker sessions, the worker settings and the session cookie were
removed; the two open test threads were stopped.
