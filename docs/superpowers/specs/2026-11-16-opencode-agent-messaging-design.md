# OpenCode agent messaging — design

Date: 2026-11-16. Status: approved by the operator 2026-11-16.
Builds on: `2026-11-14-agent-messaging-design.md` (the mail system), `2026-11-07-opencode-agent-state-design.md`
(the OpenCode state plugin), `docs/agent-messaging.md` (operator guide).

## 1. Intent

Agent messaging (v1.24.86) lets Claude Code sessions on different boxes hand each other tasks and
replies through `tmx`. It only works fully for Claude Code: an OpenCode session can send, but mail
addressed to it waits forever, because nothing wakes an idle OpenCode session when mail arrives.

The operator runs OpenCode on some boxes, possibly boxes with no Claude Code at all, and wants
**full parity**: OpenCode ↔ OpenCode, OpenCode → Claude Code and Claude Code → OpenCode, with the
same addressing, policy, delivery guarantees and operator surfaces Claude Code has today.

## 2. What was measured (2026-11-16, OpenCode 2.3.0 on a test box, Claude Code 2.1.325 on another)

| Test | Result |
|---|---|
| OpenCode runs `tmx who` | Works, no permission prompt (no operator `opencode.json` on that box). |
| OpenCode → Claude: `tmx send` then `tmx wait` | Works unchanged: Claude was woken by `tmx hook-wait`, replied, `tmx wait` printed the reply. |
| Claude → OpenCode: `tmx send` | `queued: <box>/web is not listening`; the idle OpenCode session never saw it. |
| Spike: `POST /api/session/<id>/synthetic` on OpenCode's own server with `{text, delivery: "queue", resume: true}` | Started a turn on the idle session. The text did not render in the TUI as a typed prompt. The agent ran `tmx inbox`, then `tmx reply`; Claude received the reply. Both messages ended `delivered`. |

So the hub, listener, forward, `tmx` user commands and the wake wording are already agent-neutral.
The gap is exactly Claude Code's three hook-driven pieces: the waiter (`tmx hook-wait` under
`asyncRewake`), the delivery confirmation (`tmx hook-ack` on `UserPromptSubmit`), and the setup that
installs instructions and a permission rule.

OpenCode 2.3.0 facts read from the published `@opencode/plugin@2.3.0` types (`dist/promise/plugin.d.ts`,
`session.d.ts`, `permission.d.ts`, `skill.d.ts`) and the server's `/openapi.json`:

- The V2 plugin `setup(ctx)` context has `ctx.session` with `synthetic`, `list`, `get`, `prompt`,
  `interrupt`, the `ExperimentalSessionApi` `wait`/`instructions`, and `ctx.session.hook` (prompt,
  context, `experimental.idle`, …). `synthetic(input)` takes `SessionSyntheticInput`: `{ id?: "msg_…",
  text, description?, metadata?, delivery?: "steer" | "queue", resume?: boolean }`, the same body as
  the HTTP route. The plugin can therefore wake a session **in-process**, without the server password.
- `ctx.skill` has `transform` (an editor with `add(Skill.Info)`; `Info = { id, name, description?,
  autoinvoke?, path, content }`) and `reload()`.
- `ctx.permission.hook` has `evaluate` (`{ sessionID, agent?, action, resources[], metadata?, source?,
  effect, message? }`; a hook may set `effect`).
- The 2.3.0 event vocabulary includes `session.inbox.enqueued`, `session.inbox.delivered`,
  `session.inbox.cancelled`, `session.synthetic`, `session.viewed`, `session.status`, `session.idle`,
  `session.step.*`, `session.shell.started/ended`. Several of these did not exist or never fired in
  the 2.2.6 recording the current state plugin was built from.

## 3. Goals, non-goals, anti-goals

**Goals**
- An idle OpenCode session that mail is addressed to is woken by it, as a Claude Code session is.
- Every Claude Code mail guarantee holds for OpenCode: delivery only while the session's marker is
  `ready`; never into a running turn; never typed into a terminal; `handed` is not `delivered` until
  OpenCode confirms it or the agent reads it; an unconfirmed hand-off is offered again; one waiter
  per pane; policy re-checked on every operation; Stop and permission withdrawal end the thread.
- OpenCode gets the same instructions (the skill) and the same narrow permission (`tmx`, plain
  invocations only) Claude Code gets.
- Setup installs it all on a box with OpenCode, with or without Claude Code; a setup rerun upgrades a
  running OpenCode live (no restart), as the state plugin does today.
- `tmx who`, the Messages drawer, Edit Box and `docs/agent-messaging.md` read the same for both agents.

**Non-goals**
- Codex, pi, agy: still not receivers (their state comes from the OSC reporter, which has no way in).
- The Host Shell: neither sends nor receives, as for Claude Code.
- OpenCode versions older than the first version verified (2.3.0): mail stays inert there.
- Changing the wire format, the hub's delivery rules, the store, or the policy model.

**Anti-goals** (would make this a failure even if it technically works)
- Mail for tmux session A waking an OpenCode session that belongs to tmux session B.
- A mail wake that interrupts a running OpenCode turn, or lands while a permission/question form is open.
- Anything of ours throwing into OpenCode's event loop or breaking an operator's turn.
- A permission rule that lets `tmx … "$(cmd)"` or `tmx …; cmd` run unprompted.
- Our plugin reading OpenCode's server password, or speaking HTTP to OpenCode's server.

## 4. Constraints (load-bearing rules that apply)

- **Agent mail is never typed into a terminal.** The wake goes through OpenCode's own `synthetic` API.
- **The socket a request arrives on is the box; the session is a claim** checked against markers. The
  plugin's waits name the tmux session it writes markers for, so the hub's existing check applies.
- **Box output is untrusted.** Wake text is from the hub (trusted), but everything the plugin reads
  from tmux stays behind `parsePanes`' allowlist; the plugin never evaluates a response.
- **Nothing may throw out of the plugin** (existing state-plugin rule) — the mail part included.
- **Live upgrade** through the existing `Symbol.for` singleton hand-over; held waits must be aborted
  by the old core so two cores never both hold a wait for one pane.
- **Test against a real recording**, not a fake transport (two prior green-but-broken incidents).

## 5. Approaches

**A. The OpenCode state plugin listens (chosen by the operator).** The plugin already runs inside
`opencode serve`, already tracks every OpenCode session's turns, blocks and directory, and already
maps OpenCode sessions to tmux sessions to write markers. It gains a mail part: one held
`GET /v1/wait` per mapped tmux pane on `~/.tmuxifier-mail/sock`, a `ctx.session.synthetic` call when
the hub hands it mail, and a `POST /v1/ack` when OpenCode confirms delivery. Costs: our code inside the
operator's agent process becomes a network client and must keep the never-throw discipline.

**B. A separate resident listener on the box** (e.g. a `tmx` loop kept alive by the OSC reporter)
calling OpenCode's HTTP API with the password from `~/.local/state/opencode/service.json`. Nothing of
ours in OpenCode's process, but a second resident process that must re-derive the plugin's session
mapping from outside and read OpenCode's secret. Rejected.

**C. The Tmuxifier host pushes over ssh** on each delivery. An ssh run per message, the server would
need OpenCode's password and session ids, and it inverts the pull model every box uses. Rejected.

## 6. Design

### 6.1 Parity map

| Claude Code today | OpenCode (this design) |
|---|---|
| `tmx hook-wait` held by a `SessionStart`/`Stop` hook with `asyncRewake` | The plugin's mail part holds `GET /v1/wait?session=&pane=` for each eligible pane (6.3) |
| Wake = Claude Code feeds the hook's stderr back as a new turn | Wake = `ctx.session.synthetic({ text, delivery: 'queue', resume: true, metadata })` on the mapped OpenCode session |
| `tmx hook-ack` on `UserPromptSubmit` confirms a handed message | The plugin posts `POST /v1/ack` when it observes OpenCode deliver that synthetic item (6.4) |
| Per-pane lock in `tmx hook-wait`; newest Claude in a pane wins | One core per process (singleton); the core holds at most one wait per pane; the hub's "a new waiter of a pane ends the older ones" covers a hand-over |
| Agent-state hook: a mail wake clears no background tokens, never writes over `blocked`, else `working/resume` | The reducer recognises our synthetic (by metadata) and applies the same rule (6.5) |
| Skill `~/.claude/skills/tmuxifier-mail/SKILL.md` | The same skill text reaches OpenCode (6.6) |
| `Bash(tmx *)` in `permissions.allow` (does not match a command with `$( )`) | A `permission.evaluate` hook allows exactly a plain `tmx` invocation (6.7) |
| `autoMode` classifier entries (Claude ≥ 2.1.228) | No OpenCode equivalent known; nothing to do unless 2.3.0 measurement shows a classifier |
| Setup `agent-mail` phase, gated on the `claude` tools selection, skips with no `claude` | `agent-mail` installs `tmx` + socket dir when Claude Code **or** OpenCode is selected; the Claude settings merge only with `claude`; the OpenCode mail part ships inside the plugin (`opencode-plugin` phase) (6.8) |

### 6.2 Where the mail part lives

Inside `src/server/assets/tmuxifier-opencode-agent.js`, as a second component of the existing core
(beside the reducer and the marker sweep), so it shares the core's lifecycle, the hand-over, the pane
listing and the reducer's knowledge of each session's turn state. It talks to the box socket with
`node:http` over a unix socket (`socketPath`), node builtins only, as the rest of the file. It never
reads OpenCode's password and never calls OpenCode's HTTP server; the only OpenCode calls are `ctx.*`.

**Messaging is on for this box** exactly when `~/.tmuxifier-mail/sock` exists and answers. The forward
creates it only while a switch is on and messaging is enabled server-side, so `TMUXIFIER_AGENT_MAIL=off`
and a box with both switches off cost nothing beyond a periodic `stat`. Connection refused or an absent
file → back off (30 s doubling to 30 min, the forward's own schedule) and re-check; no error surfaces.

### 6.3 Which pane waits, for which OpenCode session

A tmux pane is **eligible** when all hold:
1. it is the active pane of the active window of its tmux session and runs `opencode` (the condition
   under which the core writes that session's marker today);
2. it has a *target*: the root OpenCode session in the pane's directory tier (today's `dirExact` /
   `dirUnder` rule) with the newest **operator evidence** since the pane started hosting (`since`): a
   `session.viewed`, or a `user` inbox item (an operator prompt). Old sessions that merely persist in
   the directory never count. No evidence yet → **not listening** until the operator views or prompts
   a session there (a fresh core, `opencode -c` and a server restart all start here; the first prompt
   or view makes the pane eligible). This deliberately differs from the marker fold, which may still
   show a state without a target. *(builder-check ruling)*
3. no other tmux session **hosting** `opencode` in any window or pane (not only the active one) has a
   pane in the same directory tier. Two TUIs that share a directory are ambiguous because nothing in
   OpenCode names which TUI viewed or prompted a session: **neither listens**, `tmx who` shows them not
   listening, and the limit is documented (anti-goal 1 beats availability);
4. the target's derived state is `ready` (the hub re-checks the marker anyway; this just avoids
   holding a request the hub would not answer).

The wait names `session=<tmux session>` and `pane=<#{pane_id}>` (add `#{pane_id}` to `PANE_FORMAT`,
still allowlisted). When a pane stops being eligible, its held request is aborted (connection closed),
which the listener turns into an idle end; a mail already handed and not yet acked is re-offered by the
hub's existing rules.

### 6.4 Wake and confirmation

On `200` the response body is the wake text (`agentMailText.wakeText`, first line
`[tmuxifier-mail m-…]`). The core:
1. re-checks that the pane is still eligible and the target still `ready`; if not, it drops the text
   (the message is `handed`; the hub re-offers it — no ack is sent);
2. calls `ctx.session.synthetic({ sessionID: target, text, delivery: 'queue', resume: true,
   metadata: { tmuxifierMail: '<m-id>' } })`. `queue`, never `steer`: if a turn started in between,
   OpenCode holds the item until it ends;
3. records `<inbox item id> → <m-id>` and, on the event that OpenCode delivered that item to the model
   (`session.inbox.delivered` for that id in 2.3.0 — to be confirmed by the recording, 7.1), posts
   `POST /v1/ack session=<tmux session> m=<m-id>`. `session.inbox.cancelled` for it sends no ack.
4. re-arms the pane's wait **only after** that item is settled: delivered and acked, cancelled, the
   `synthetic` call failed, or a fallback timer (`REOFFER_MS`, the hub's own 600 s) ran out. Re-arming
   earlier would be wrong: `hub.waitMail` puts every message handed on that pane back to `queued` the
   moment a new wait for the pane connects, so the later ack would 404 and the message would be handed
   twice. (Claude Code avoids this only because its `Stop` waiter starts after `hook-ack`.) The hub's
   delivery rules stay unchanged. *(builder-check ruling)*

A failed `synthetic` call sends no ack and backs off that pane briefly; the hub re-offers the message
after `REOFFER_MS` or to the next waiter of the pane.

**At-least-once, as for Claude Code.** OpenCode's inbox is durable, and `ctx.session` exposes no inbox
cancel. After an OpenCode server restart, an item of ours still queued there can be delivered by
OpenCode while the hub also re-offers the unacked message, so the agent may see it twice. The plugin
narrows this without promising exactly-once: every item carries `metadata.tmuxifierMail = <m-id>`, so
when the core sees `inbox.enqueued`/`inbox.delivered` for an item it did not post in this process
(a restarted server replaying its inbox), it adopts the item into its map and acks on delivery. It also
never posts a second synthetic for an `m-id` it already has in flight. A duplicate is accepted; the
wake wording already tells the agent to `tmx read` the thread before answering. *(builder-check
ruling)*

### 6.5 Agent state while mail is delivered

The reducer currently treats any synthetic inbox item as a `resume`. Our item must behave like
Claude Code's mail wake: it clears no background-shell bookkeeping, it never turns a `blocked` session
into `working`, and otherwise the turn reads `working/resume`. The reducer identifies our item by its
`metadata.tmuxifierMail` (or by the inbox id recorded in 6.4), never by matching text.

### 6.6 Instructions (the skill)

The agent needs the same text Claude Code gets (`src/server/assets/tmuxifier-mail-skill.md`, already
agent-neutral apart from its install path). The builder picks, after measuring on 2.3.0, between:
(a) the plugin adding it with `ctx.skill.transform(editor => editor.add({...}))` from text embedded in
the asset (no file on disk, upgrades with the plugin), or (b) a skills directory OpenCode reads, written
by setup like Claude's. Prefer (a) if it makes the skill visible to the agent and auto-invokable; a
`description` identical to Claude's. The skill's existing guidance (plain commands only, never ask
another agent to approve anything) applies unchanged.

### 6.7 Permission

A `ctx.permission.hook.evaluate` handler sets `effect` to allow **only** when the request is the bash
tool running exactly one command whose program is `tmx` (bare, or `~/.local/bin/tmx` /
`$HOME/.local/bin/tmx`) with a known subcommand and no substitution, pipe, redirection, `;`, `&&`,
`||`, backtick or `$(`. Anything else is left to OpenCode's own decision (never set to deny, never
changed when OpenCode already denies). This mirrors `Bash(tmx *)`, which Claude Code does not apply to
a command with `$( )`.

**The operator's own rules win (operator ruling, 2026-11-16).** In Claude Code an `ask` rule beats
`allow`, so `Bash(tmx *)` never overrides an operator's explicit `ask`. The hook cannot tell OpenCode's
default `ask` from an operator's rule (`source` only says `{type: "tool"}`), so the plugin reads the
operator's OpenCode configuration itself: the global config (`$OPENCODE_CONFIG_DIR` or
`~/.config/opencode/`, `opencode.json` and `opencode.jsonc`) and the project config for the session's
directory (the same file names, plus `.opencode/`). Whichever files OpenCode 2.3.0 actually merges
are confirmed during the recording. If **any** of them sets a permission rule for bash (the key
`permission.bash`, either as a string or as an object of patterns, or a top-level `permission` string,
for any agent), the hook does nothing and OpenCode decides. Otherwise it allows plain `tmx`. A file that
cannot be read or parsed counts as "the operator has rules" (fail closed: the hook does nothing).
`.jsonc` is read with a small comment- and trailing-comma-tolerant reader, using node builtins only.
The answer is cached per file by mtime, so a config change takes effect on the next command without a
restart. How OpenCode 2.3.0 presents a bash command in `action`/`resources` (it bundles
`tree-sitter-bash`, so resources may already be split per command) must be measured first; the handler
then matches on that measured shape. The handler is wrapped like every other plugin entry point.

### 6.8 Setup

- `agent-mail` phase (`claudeAgentMail.js` + `setupManager.js`): run when the job's tools include
  `claude` **or** `opencode`. The install script installs `tmx` and the socket directory whenever curl
  is present and the existing `~/.local/bin/tmx` check passes; the Claude parts (skill file,
  `settings.json` hooks, permission rule, `autoMode`) run only when `claude` is present, as today. New
  skip reason: neither agent on the box. The result keeps one `agent-mail` row; when only OpenCode is
  present it reads ok with a note that OpenCode's half arrives with the OpenCode plugin.
- `opencode-plugin` phase: unchanged mechanics; the asset now includes the mail part. Since the mail
  part needs `tmx` (for the agent's own commands), the phase order (`agent-mail` before
  `opencode-plugin`) already suits.
- The forward's `installed` flag (`__MAILTOOLS__`, `~/.tmuxifier-mail/tmx` executable) stays as is.
- OpenCode version: setup reads `opencode --version`; below the first verified version the plugin's mail
  part stays inert (the plugin checks `typeof ctx.session?.synthetic === 'function'` too) and the
  `opencode-plugin` row carries a note, as `agent-mail` does for old Claude Code.

### 6.9 The agent's own `tmx` commands: which session is calling

`tmx` learns its caller from `$TMUX_PANE` (`in_tmux` / `session_now`). Under OpenCode that is wrong: the
bash tool runs inside the one shared `opencode serve`, whose environment is the **first** TUI's forever
(measured on the test box: the server has `TMUX_PANE=%0`). With two TUIs, an agent woken for tmux
session B would read A's inbox, reply as A, or be refused. The hub cannot catch it, since A has a marker.

Fix: the plugin sets the caller's identity per shell command.
- `ctx.tool.hook` `execute.before` (it names `sessionID`, `tool` and the call `id`, with `input`)
  records, for a bash call, `{ command → the pane mapped to that OpenCode session's target (6.3) }`.
- `ctx.shell.hook` `create.before` (it carries `command` and a mutable `env`, but no session) consumes
  the matching record and sets `env.TMUXIFIER_MAIL_PANE` to that pane id, or to `none` when the session
  has no eligible pane, when no record matches, or when two pending records with the same command text
  map to different panes (fail closed).
- `tmx` prefers `TMUXIFIER_MAIL_PANE` over `TMUX_PANE` when it is set: a pane id is used exactly as
  `TMUX_PANE` is now; `none` makes every user command exit 2, saying the session is not reachable for
  messaging. Outside OpenCode the variable is unset and nothing changes. No wire-format change.
- The operator's own `TMUX`/`TMUX_PANE` in the shell are left alone.

This env var carries the same trust as `TMUX_PANE`: any process on the box can already claim any
session that runs an agent (documented in the operator guide). The correlation rule (command text,
FIFO, ambiguity → `none`) is checked against the 2.3.0 recording; if OpenCode turns out to call
`create.before` with something that names the tool call, use that instead.

### 6.10 One `ctx` per directory

OpenCode runs `setup` once per project directory in one process, and the core is a process-wide
singleton. Whether `ctx.session.synthetic` and the `ctx.permission` / `ctx.tool` / `ctx.shell` /
`ctx.skill` registrations reach only that setup's directory is unknown. The core therefore keeps **every**
live setup's `ctx` keyed by `ctx.location.directory`. It calls `synthetic` through the `ctx` whose
directory matches the target session's (falling back to any), and registers each hook once per
`ctx`. A handler deduplicates by call or request id, so a process-wide hook registered N times acts
once. The hand-over disposes the old core's registrations (each returns a `Registration`) and
re-registers under the new core. The recording (7.1) settles which case holds; the structure is right
for either. *(builder-check ruling)*

### 6.11 Prerequisite: the state plugin on 2.3.0

The state plugin was built from a 2.2.6 recording; 2.3.0's event vocabulary differs (2). Before the
mail part, record a 2.3.0 trace and replay it through the current reducer; fix whatever reads wrong.
This is part of this work because the mail part relies on the reducer's `ready` state and session
mapping.

## 7. Testing

1. **A real OpenCode 2.3.0 recording** (`test/fixtures/opencode-2.3-event-trace.jsonl` + README), made
   on the test box with a recording plugin, covering: plain turns, a permission ask/reply/reject, a
   question form, a ctrl+b background shell, a second TUI in another directory, a second TUI in the
   same directory, `session.viewed` on switching sessions, **a synthetic `queue`+`resume` on an idle
   session and on a busy one**, its `inbox.enqueued`/`inbox.delivered` events, `permission.evaluate`
   payloads for `tmx who`, `tmx reply t "x"`, `tmx reply t "$(env)"`, `tmx who; id`, a skill
   added through `ctx.skill`, the `tool.execute.before` and `shell.create.before` payloads for one bash
   call (and for two concurrent ones from two sessions), and whether each `ctx` registration and
   `synthetic` call reaches other directories' sessions (6.10). Replayed by the existing reducer tests and new mail tests.
2. **The plugin's mail part against the real listener and hub** (`createMailHarness`, real unix
   socket), with a fake `ctx.session.synthetic` that records calls and emits the recorded events back:
   wake → synthetic → delivered → ack; cancelled → no ack, re-offer; pane loses eligibility mid-hold;
   ambiguity → no wait; no operator evidence → no wait; re-arm only after the item settles (no
   duplicate hand-off, ack does not 404); a replayed item adopted by `metadata.tmuxifierMail`;
   hand-over aborts the old core's waits and registrations; socket absent/refused → backoff; listener
   close (Tmuxifier restart) → re-arm; `TMUXIFIER_MAIL_PANE` set per shell, `none` on ambiguity, and
   the real `tmx` script honouring it.
3. **Setup script tests** for the new gating (OpenCode-only box, Claude-only, both, neither).
4. **Live walk on real boxes** (Claude box + OpenCode box, and a second OpenCode session for
   OpenCode ↔ OpenCode): every direction; a send to idle, working and blocked OpenCode sessions; Stop;
   a switch turned off mid-thread; Tmuxifier restart with a wait armed; OpenCode server restart; setup
   rerun over a running OpenCode with a wait armed; two TUIs in one directory read not listening;
   two TUIs in different directories on one box, each woken and each replying **as its own session**;
   `tmx reply t "$(env)"` prompts in OpenCode.

## 8. Limits to document

- Two OpenCode TUIs in one directory in different tmux sessions: neither receives mail.
- Within one tmux session, mail goes to the OpenCode session the operator last viewed or prompted;
  until the operator does either after the TUI starts, the session is not listening.
- A message can arrive twice after an OpenCode server restart (at-least-once, as for Claude Code).
- OpenCode older than the verified version: can send and read its inbox, never woken.

## 9. Left to the builder

Skill delivery mechanism (6.6) after measurement; exact permission-matching code (6.7) once the
`resources` shape is recorded; the reducer fix-ups 6.11 turns up; backoff constants for the plugin;
how the inbox id is correlated if `synthetic`'s return value and the events name it differently;
test file layout; doc wording in `docs/agent-messaging.md`, `CLAUDE.md`/`AGENTS.md`.
