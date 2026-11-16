# opencode-2.3-event-trace.jsonl

A recording of real OpenCode plugin traffic on OpenCode **2.3.0** (native binary from the v2
installer), made for agent messaging (`docs/superpowers/specs/2026-11-16-opencode-agent-messaging-design.md`).
The recorder is `test/fixtures/tools/opencode-recorder.js`: every event each plugin instance
receives (`kind: "event"`, with `tag` = the instance's directory basename), the hooks
`tool.execute.before/after`, `shell.create.before`, `permission.evaluate`, `session.prompt`,
`session.experimental.idle` (`kind: "hook.<name>"`), its own `plugin.setup`/`plugin.cleanup`, the
results of its probes (`kind: "probe.*"`), and `kind: "scenario"` marker lines written between steps.

Used by (they read the recording, so a change to it must keep them green): `test/opencodeAgentReducer.test.js`
and `test/opencodeAgentReplay23.test.js` (the state reducer), `test/opencodeAgentMailTargets.test.js`
(which tmux session a pane's mail goes to), `test/opencodeAgentPaneTag.test.js` (`TMUXIFIER_MAIL_PANE`),
`test/opencodeAgentPermission.test.js` (the `tmx` permission handler and the operator's rules) and
`test/opencodeAgentRegistry.test.js` (hooks per directory). Operator guide:
`docs/agent-messaging.md`.

Setup: an isolated OpenCode (own `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`, own service port,
own tmux server) on a test box, so the operator's OpenCode server was never touched. The model was
OpenCode's free default ("Big Pickle"), so the turns' text is real and not deterministic. TUIs were
driven with `tmux send-keys`. `tmx` on `PATH` was a stub that prints its argv. Every probe's
`synthetic` carried `metadata: { tmuxifierMail: "m-aaaaaaaa" }` whatever its text said.

Scrubbed: home → `/home/user`, project dirs → `/home/user/proj` and `/home/user/proj2`, synced skill
directories → `.../skills/synced/<id>/`, the box's hostname → `box`, tmux socket uid → `1000`.
`shell.create.before`'s `env` is reduced to `TMUX`, `TMUX_PANE`, `PWD`, `SHELL` and `TMUXIFIER_*`
(the rest is `envKeys`, a count). Ids and timestamps are the real ones. From line 1240 a third
plugin instance (`root`) exists, so events from there on are recorded up to three times.

## Scenarios

| Lines | Scenario | What it shows |
|---|---|---|
| 1-14 | plugin load | `plugin.setup` for `proj`, the `*.updated` burst |
| 15-34 | (a) plain turn | `inbox.enqueued` (user) → `execution.started` → `inbox.delivered` → … → `execution.succeeded` → `session.viewed` (`data.idle`) |
| 35-67 | (h1) `tmx who` | `execute.before` (46) → `create.before` (47) → `permission.evaluate` (48, effect `allow`, no config) |
| 68-105 | (h2) `tmx reply t-aaaaaaaa "x"` | resources `["tmx reply t-aaaaaaaa \"x\""]` (87) |
| 106-151 | (h3) `tmx reply … "$(echo hi)"` | resources split: the whole command **and** `echo hi` (130) |
| 152-248 | (h4) `tmx who; id` | resources `["tmx who", "id"]` (206) |
| 255-365 | (b1, g3) permission ask → once, with a `queue` synthetic posted while the prompt was open | ask (275-276); synthetic return value (279), its `inbox.enqueued` with metadata (280); delivered (299) only after the reply and the tool, inside the same execution; one `execution.succeeded` (364) |
| 366-390 | (b2) permission reject | `permission.replied` reject → `execution.interrupted` (390) |
| 391-430 | (c) question form | `form.created` (414) / `form.replied` |
| 431-530 | (d, g2) background shell (ctrl+b) with a synthetic queued during it | OpenCode's own ctrl+b notice is a synthetic item (462); ours delivered (481) before the turn ends (507) while the shell still runs; the shell's completion re-enters as a synthetic with `metadata.source: "shell"` (510) and starts a new execution (511) |
| 531-809 | (g1) synthetic on an idle session | enqueued (534) → `execution.started` (535) → delivered (536); the agent invoked the `tmuxifier-mail` skill (651), ran `tmx who` and `tmx reply` (739-760) |
| 810-866 | (e) second TUI in `proj2` | second `plugin.setup` in the same process (812); events now reach both instances |
| 867-905 | (f) second TUI in `proj` | a new session in `proj` |
| 906-1050 | (i) two TUIs (`proj`, `proj2`) run `tmx inbox` at the same moment | each call's hooks fire only in the instance owning that directory (935-937 `proj`, 981-983 `proj2`); `create.before` carries `cwd` |
| 1051-1118 | F5 probe: `synthetic` through `proj`'s ctx for a `proj2` session | delivered (1058): `synthetic` is process-wide |
| 1119-1120 | open an existing session (`-s`), continue (`-c`) | **no events at all** |
| 1121-1150 | synthetic for a session with **no TUI** | the turn runs; **no** `session.viewed` after it |
| 1151-1277 | (j) skill added through `ctx.skill.transform` | transform result (1153); see F6 |
| 1278-1483 | F7: global `{"permission":{"bash":"ask"}}` | evaluate effect `ask` for `tmx who` (1371), prompt |
| 1484-1588 | F7: project `.opencode/opencode.jsonc` (comments, trailing commas), `shell: {"tmx *": "ask"}` | `ask` (1515) |
| 1589-1704 | F7: project `opencode.json` | `ask` (1623) |
| 1705-1841 | F7: global `agent.build.permission.shell` | `ask` (1757) |
| 1842-1983 | (k) synthetic queued during a busy turn, then the server killed | enqueued (1903); after the restart the new server's `plugin.setup` (1913) and **only** `inbox.delivered` for the old `inboxID` (1924), no `inbox.enqueued` replay, no `execution.started` |

## Facts for the mail design

| # | Question | Answer |
|---|---|---|
| F1 | `synthetic` return and inbox events | Returns `{ id: "msg_…", sessionID, type: "synthetic", payload: { text, metadata }, delivery }` (279). `session.inbox.enqueued` has `data.inboxID` = that id and `data.item.payload.metadata` = ours (280), and **no** `location`. `session.inbox.delivered` has `data.inboxID` (299) and `location.directory`. No `inbox.cancelled` was observed. |
| F2 | `session.viewed` | Fires after a turn ends (`data.idle` = the end time) **only while a TUI shows the session** (absent at 1149). Opening a session (`-s`) or continuing (`-c`) emits nothing. A `user` inbox item is the other operator evidence. |
| F3 | `permission.evaluate` for bash | `action: "shell"`, `resources`: one entry per command OpenCode's parser finds: `tmx who; id` → `["tmx who", "id"]`; `"$(echo hi)"` adds `"echo hi"`. `source: { type: "tool", messageID, id: <tool call id> }`. With no config every command's effect is `allow`; an `ask` rule shows as `effect: "ask"`. |
| F4 | `tool.execute.before` vs `shell.create.before` | Same millisecond, in that order, then `permission.evaluate` (46-48). The tool is `"shell"`, input `{ command }`. `create.before` has `command`, `cwd`, `timeout`, `shell`, `env`, and nothing naming the call or session. All three fire **only in the plugin instance whose directory owns the session** (935-937 vs 981-983), so concurrent calls from different directories never meet in one instance. |
| F5 | ctx scope | Hooks: per directory instance (above). Events: every instance gets every event. `synthetic`: process-wide (a `proj` ctx reached a `proj2` session, 1058). |
| F6 | skills | OpenCode reads `~/.claude/skills/**/SKILL.md` (the box's Claude `tmuxifier-mail` skill was listed and invoked, 651) and `<config dir>/opencode/skills/<name>/SKILL.md` (also `skill/`), picked up without a restart (checked through `GET /api/skill`). `ctx.skill.transform` with `editor.add` returned without error, but with the Claude copy present its own effect could not be told apart. A file is enough. |
| F7 | config honoured for permissions | Global `<config dir>/opencode/opencode.json`; project `opencode.json` and `.opencode/opencode.jsonc` (comments and trailing commas accepted). Keys `permission.shell` **and** the older `permission.bash`, also under `agent.<name>.permission`. A config change applies to the next command, no restart. |
| F8 | events the state reducer does not handle | `session.inbox.delivered`, `session.viewed`, `session.renamed`, `session.instructions.updated`, `session.step.*`, `session.text.*`, `session.reasoning.*`, `session.tool.*`. None changes the turn boundary or block rules (step/tool/text are the reducer's turn-activity events already); `session.status` and `session.idle` never fired. |
| F9 | server restart with our item queued | The new server delivers it (`inbox.delivered`, old `inboxID`, 1924) with **no** `inbox.enqueued` replay and no metadata in any event: a restarted plugin can only match it to a message id it saved itself. |
| F10 | `queue` while a permission prompt is open or a turn runs | Held until the current work finishes (the prompt answered and the tool done; or the shell moved to the background), then delivered inside the same execution before it ends (299, 481); on an idle session it starts a new execution (535). Never interrupts a tool or a prompt. |

Observed in passing: given a bare probe text, the model declined to act on it as "untrusted mail"
(after line 299); the real wake text with the operator's authorisation plus the skill (531-809) was
acted on.
