# claude-hook-trace.jsonl

A recording of real Claude Code hook payloads (stdin of a command hook), one JSON object per line,
captured on Claude Code **2.1.319** with a recorder registered on SessionStart, UserPromptSubmit,
PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Notification, SubagentStart,
SubagentStop, Stop and SessionEnd. Session was driven in manual (default) permission mode through tmux.

Scrubbed: `session_id` -> `sess` (also inside paths), `transcript_path`/`agent_transcript_path`/
`scratchpad_dir` -> `/scrubbed`, `cwd` -> `/tmp/rec`, `prompt_id` -> `p`, `tool_use_id`/`toolu_*` -> `t`.

| Scenario | Lines | Events seen |
|---|---|---|
| warm-up (not in plan): `date` via Bash | 1-6 | SessionStart(source=startup), UserPromptSubmit, PreToolUse(Bash), PostToolUse(Bash), Stop, SubagentStop. `date` is auto-allowed, so NO PermissionRequest/Notification. |
| (a) Bash permission, granted (`touch`) | 7-13 | UserPromptSubmit, PreToolUse(Bash), PermissionRequest(Bash), Notification(permission_prompt), PostToolUse(Bash), Stop, SubagentStop |
| (b) Bash permission, denied with "No" | 14-17 | UserPromptSubmit, PreToolUse(Bash), PermissionRequest(Bash), Notification(permission_prompt). Nothing after: the turn is interrupted, no Stop, no PostToolUseFailure. |
| (c) denied with typed message | 18-23 | UserPromptSubmit, PreToolUse(Bash), PermissionRequest(Bash), Notification(permission_prompt), Stop, SubagentStop. No PostToolUseFailure. (Line 18 is the next prompt after (b)'s interrupt; it is the typed-denial scenario's own prompt.) |
| (d) AskUserQuestion, answered "No" | 24-30 | UserPromptSubmit, PreToolUse(AskUserQuestion), PermissionRequest(AskUserQuestion), Notification(permission_prompt), PostToolUse(AskUserQuestion), Stop, SubagentStop |
| (e) background subagent | 31-43 | UserPromptSubmit, PreToolUse(Agent), PostToolUse(Agent), SubagentStart, Stop (turn ends while the subagent runs), PreToolUse/PostToolUse(Bash) from the subagent, SubagentStop x2, UserPromptSubmit (line 40: a synthetic `<task-notification>` prompt resuming the turn), Stop, SubagentStop x2 |
| (f) `/compact` | 44 | SessionStart(source=compact) only; no UserPromptSubmit/Stop |
| (g) plain turn "say ok" | 45-46 | UserPromptSubmit, Stop (no SubagentStop this time) |
| (h) `/exit` | 47 | SessionEnd(reason=prompt_input_exit) |

Notes
- The first Notification of each prompt has `notification_type: permission_prompt`; Notification payloads
  carry no `permission_mode`. No `idle_prompt` Notification occurred within the recording window.
- The recorder did not register PreCompact, so the compact trigger is not recorded.
- A `SubagentStop` with empty `agent_type` and no `SubagentStart` follows nearly every `Stop` (e.g. lines 6, 13,
  23, 30, 42); its `last_assistant_message` repeats the turn's final text, or on line 43 is the `/compact` summary (so `/compact` fires `SubagentStop` before its `SessionStart(compact)`)
  . It is not a real subagent. Real subagent events carry `agent_type: general-purpose` and an `agent_id`.
- The user's global tmuxifier hook ran alongside; it does not affect the recording.
