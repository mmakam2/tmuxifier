# opencode-event-trace.jsonl

A recording of real OpenCode plugin traffic, one JSON object per line, captured on OpenCode
**2.2.6** (npm `@opencode/cli`, which installs a native binary) with a throwaway V2 plugin that
logged every `ctx.event.subscribe()` event (`kind: "event"`) plus the `tool.execute.before/after`,
`permission.evaluate`, `session.prompt`, `session.experimental.idle` and `shell.create.before`
hooks (`kind: "hook.<name>"`), and its own `setup`/`cleanup` calls (`kind: "plugin.*"`). The model
was a scripted OpenAI-compatible mock, so every turn is deterministic; `permissions` made `shell`
ask for everything except `date`. The TUI ran inside tmux (`opencode`, `#{pane_current_command}`
= `opencode`) and was driven with `send-keys`.

Scrubbed: home directory -> `/home/user`, project dirs -> `/home/user/proj` and `/home/user/proj2`,
config dir -> `/home/user/.config/opencode`, the binary -> `/home/user/.opencode/bin/opencode`,
tmux socket uid -> `1000`, marker files -> `/tmp/marker-<n>`. Session/message/permission/form/shell
ids, project id hashes and timestamps are the real ones.

| Scenario | Lines | Events seen |
|---|---|---|
| plugin load | 1-14 | `plugin.setup` (pid is the **`opencode serve --service` child** of the TUI; `env.TMUX`/`TMUX_PANE` inherited from that first TUI), `plugin.hooks`, the `*.updated` burst, `models-dev.refreshed` |
| (a) warm-up `run date`, auto-allowed | 15-47 | `session.created`, hook `session.prompt` (delivery `steer`), `session.inbox.enqueued` (item.type `user`), `session.execution.started`, step/tool.input/`session.tool.called`, hook `tool.execute.before`, `shell.create.before`, `permission.evaluate` (effect `allow`), `shell.created`/`shell.exited`, hook `tool.execute.after`, `session.tool.success`, hook `session.experimental.idle` (`background: []`), text step, `session.execution.succeeded`, `session.viewed`. No `permission.asked`, no `session.status`, no `session.idle`. |
| (b) `touch`, **Allow once** | 48-79 | as (a) plus `permission.evaluate` (effect `ask`), `permission.asked` (line 60: `action: shell`, `resources`, `save: ["touch *"]`, `source.{messageID,id}`), `permission.replied` (`reply: once`, line 61), then the shell runs |
| (c) `touch`, rejected with **Escape** | 80-97 | `permission.asked` (92), `permission.replied` (`reject`, 93), `session.tool.failed` (`aborted`, "The user declined this tool call"), `session.step.failed`, `session.execution.interrupted` (`reason: shutdown`, 97). **No** idle hook, no `session.viewed`. |
| (d) `touch`, rejected via the **Reject** button | 98-115 | identical shape to (c). 2.2.6 has no "type a message" stage after Reject. |
| (e) `question` tool, answered (Enter on the first option) | 116-143 | hook `tool.execute.before` (tool `question`), `permission.evaluate` (`action: question`, `allow`), `form.created` (line 127: `form.metadata.kind = "question"`, `form.sessionID` real, `metadata.tool.{messageID,id}`), `tool.execute.after`, `form.replied` (`answer: {q0: "Alpha"}`, 129), `session.tool.success`, idle hook, `session.execution.succeeded` |
| (f) `question` tool, dismissed with Escape | 144-160 | `form.created` (155), `form.cancelled` (156), `session.tool.failed` ("The user dismissed this question"), `session.execution.interrupted` (160) |
| (g) plain text turn `say ok please` | 161-174 | prompt hook, `execution.started`, idle hook (before the text step), text step, `execution.succeeded`, `viewed` |
| (h) `touch`, **Always allow** | 175-205 | `permission.replied` (`reply: always`, 188); otherwise as (b). The saved rule did not change later `sleep` prompts. |
| (i) background shell, messy first attempt | 206-267 | `sleep 25` granted once (220), `shell.created` (221), **ctrl+b**: hook `tool.execute.after` with "Command moved to the background" (223), **synthetic** `session.inbox.enqueued` (224: `item.type: "synthetic"`, "User requested that active blocking work be moved to the background…", `delivery: steer`), `session.tool.success` (225). The mock then asked for another `sleep`; rejected (238) -> `execution.interrupted` (242) -> an empty `execution.started`/`succeeded` pair (243-244, inbox drain). The background shell finished: synthetic `inbox.enqueued` `<shell … state="completed">` (246) + `shell.exited` (247) -> `execution.started` (248) **without a `session.prompt` hook**; the mock asked for `sleep` again, rejected (262), interrupted (266). |
| (j) background shell, clean | 268-315 | granted once (281), ctrl+b (284-286), hook `session.experimental.idle` with **`background: [{kind: "shell", sessionID, shellID, command}]`** (290), `execution.succeeded` (298) **while the shell still runs**, `viewed`; 22 s later synthetic `inbox.enqueued` (300) + `shell.exited` (301), `execution.started` (303, no prompt hook), idle hook `background: []` (305), `execution.succeeded` (313) |
| (k) third TUI, different directory (`proj2`), same tmux server | 316-335 | **second `plugin.setup` in the same process** (same pid, `location.directory` = `/home/user/proj2`), `plugin.hooks`, `*.updated` burst for that directory. The second TUI had connected to the existing `serve --service` process: no new server, no setup. From here every `event` line is **recorded twice** (two subscribers, one per plugin instance; same `event.id`); hooks fire once, in the instance whose directory owns the session. |
| (l) second TUI (same directory `proj`) prompts `say ok` | 336-371 | `session.created` for a new session in `/home/user/proj` (doubled), prompt hook, execution — a second OpenCode session in the same directory, served by the same process |
| (m) `/exit` typed too fast lands as a prompt `/exit/exit` | 372-397 | an ordinary text turn (doubled). Kept: it is real. |
| TUI exits (`/exit` + Enter twice, all three TUIs) | — | **nothing is recorded.** The `serve --service` process is reparented to pid 1 and keeps running after the last TUI exits (still alive 10 min later). |
| (o) server killed (SIGTERM) | 398-402 | `plugin.cleanup` x2 (one per instance), `location.shutdown` per directory |
| (p) fresh TUI, plugin discovered from the **default** `~/.config/opencode/plugins/` (no `OPENCODE_CONFIG_DIR`) | 403-413 | `plugin.setup` (new server pid), hooks, `*.updated` |
| (q) `opencode -c` resumes the first session and prompts `say ok` | 414-427 | **no `session.created`**; `session.inbox.enqueued` (415) carries `event.location.directory`; prompt hook; idle hook; `execution.succeeded` |

Notes
- Which event types carry `event.location.directory` (whole trace): every `session.*` step/text/tool/
  inbox event, `session.created`, `permission.asked`/`permission.replied`, `form.*`, `shell.*`,
  `location.shutdown`. **Not** carried by `session.execution.started/succeeded/interrupted`,
  `session.usage.updated`, `session.viewed`, `models-dev.refreshed`, and the two synthetic
  `inbox.enqueued` lines 224 and 285. A session's directory is therefore known from its first
  `inbox.enqueued` (every prompt, user or synthetic-resume) or `session.created`, before its
  `execution.started`.
- `session.status` / `session.idle` never appeared: the turn boundary is `session.execution.started`
  -> `session.execution.succeeded | interrupted`. The `session.experimental.idle` hook fires once per
  turn **before the final text step** (not at the very end) and is the only exact source of
  background work; on the interrupted path it does not fire at all.
- A reject (`permission.replied reject`, `form.cancelled`) is followed within the same millisecond by
  `session.tool.failed` and `session.execution.interrupted`. Nothing in 2.2.6 lets a turn continue
  after a rejection.
- `hook.session.prompt` fires for operator prompts only (`delivery: steer`), never for the
  synthetic resumes at 246/300; those show up as `session.inbox.enqueued` with
  `item.type: "synthetic"` and `item.payload.metadata.source: "shell"`.
- Hook payload shapes: `tool.execute.before` `{tool, sessionID, agent, messageID, id, input}`;
  `tool.execute.after` adds `{status, result}`; `permission.evaluate` `{sessionID, agent, action,
  resources, source, effect}`; `session.prompt` `{sessionID, messageID, delivery}`;
  `session.experimental.idle` `{sessionID, background[]}`; `shell.create.before` `{command, cwd}`.
