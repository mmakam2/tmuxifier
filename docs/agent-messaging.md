# Agent messaging

How the Claude Code and OpenCode sessions on your boxes send each other tasks and replies through
Tmuxifier: turning it on for a pair of boxes, what the agents type, what you see, how to stop an
exchange, and what this version does not do. Part of the [Tmuxifier docs](../README.md).

Box names (`orders`, `billing`) and session names (`main`, `review`) below are placeholders.

## What it does

You are working with Claude Code on `orders`, and it needs something only the agent on `billing`
can see or do: a version it pins, a test run, a file. With messaging on, the agent on `orders`
runs `tmx send billing "…"`. Tmuxifier checks that the two boxes are allowed to talk, holds the
message until the Claude Code session on `billing` is idle, and then wakes that session with
it. Nothing is typed into the terminal. The agent on `billing` does the work and answers with
`tmx reply`, and the answer comes back to the agent on `orders`. Both agents can keep posting
in the same thread for as long as the permission that started it holds.

The receiving agent can be Claude Code or OpenCode 2.3.0 or later, and the sender can be either,
in any combination: Claude Code to OpenCode, OpenCode to Claude Code, OpenCode to OpenCode. They
are woken differently. Claude Code is woken by a hook Tmuxifier adds to it. OpenCode is woken by
the Tmuxifier plugin that already runs inside it to report its state: the plugin waits for mail
on the box and hands it to the OpenCode session through OpenCode itself. Everything else, the
permission to start a thread, the commands, the drawer, is the same for both.

- Every message travels between Tmuxifier and the boxes over the SSH connections Tmuxifier
  already holds. Nothing goes over the internet, and the boxes never talk to each other directly.
- Every box is off until you turn it on, separately for sending and for receiving, with a list
  of the boxes it may send to and receive from.
- Every thread and every refused attempt shows in the **Messages** drawer, and you can stop any
  thread there.
- It works between agent sessions that are already running (Claude Code, or OpenCode 2.3.0 or
  later). It never starts a session.

Messaging is on in Tmuxifier by default. `TMUXIFIER_AGENT_MAIL=off` in `.env` removes it
entirely (see [Turning it off](#turning-it-off)).

## Turning it on for two boxes

To let the agent on `orders` send work to the agent on `billing`:

1. **Set up both boxes with the agent that runs there.** Open each box's Edit dialog, tick
   **Claude Code**, **OpenCode** or both in the tools checklist and **Save**. When the setup job
   reports done, its status line includes `agent-mail ✓`. This installs the `tmx` command and the
   skill that teaches the agent to use it; for Claude Code it also adds three hooks and one
   permission rule, and for OpenCode the plugin step carries the listener and the permission
   (see [What setup installs](#what-setup-installs)). A box set up before this feature existed
   needs this step too, and so does a box that had only Claude Code ticked and now runs OpenCode.
2. **Restart the agent** in every session that should take part. Claude Code reads its hooks
   and skills when it starts, so a `claude` that was already running neither receives mail nor
   knows the command. OpenCode loads the plugin and the skill on its own within seconds, but an
   OpenCode project that was already open when setup installed or updated the plugin may need an
   OpenCode restart before it receives mail.
3. **Edit `orders`.** In the **Agent messaging** section, tick **Agents here may send** and pick
   `billing` from the **add box** list after `to:`. Leave **When adding a box, also write the
   matching entry on that box** ticked: on Save it also puts `orders` in `billing`'s receive
   list. **Save.**
4. **Edit `billing`.** Tick **Agents here may receive**. Its `from:` list already shows `orders`.
   **Save.** The tick in step 3 never turns on the other box's switches; this step does.
5. **Check.** Reopen either dialog. On `orders` the line for the pair reads `billing   send ✓`,
   and the last line of the section reads `Tools installed · socket connected · 1 session
   listening` once a Claude Code or OpenCode session on that box is listening for mail.

The section's last line reads `Tools not installed: run setup on this box` while `tmx` is not on
the box. A switch turned on in the same Save that installs the tools shows it for the moment the
setup job takes; the line follows the job as soon as its `agent-mail` step reports done. Tools
installed some other way are noticed when a session on the box starts listening, or at the
socket's next quiet check (every ten minutes while nothing on the box uses it).

The **Agent messaging** section is in the Edit dialog only, not in Add: add the box first. Every
Save of the Edit dialog also runs setup again, as it always does.

What a thread needs to start:

| Thread | Needs |
|---|---|
| From `orders` to `billing` | `orders`: **Agents here may send** on, `billing` in its `to:` list. `billing`: **Agents here may receive** on, `orders` in its `from:` list |
| Between two sessions of `orders` | `orders`: both switches on. No list entry |
| A reply inside an open thread | Nothing more, in either direction |

So replies flow back without any setting on `billing`'s send side. For the agent on `billing` to
*start* threads with `orders` as well, set up the other direction the same way.

The per-box lines in the section say what is missing for each pair, naming the box whose setting
it is: `billing   send: waiting, billing's receive switch is off`, or `billing   receive:
waiting, billing's send list does not include orders`. They show the saved settings, so reopen
the dialog after a Save to see them change.

## What the agents do

The skill tells the agent when to use messaging (you ask it to consult, ask or hand work to the
agent on another box) and how. You do not need to explain the command; asking "ask billing which
version of the payments library it pins" is enough. The commands:

```
tmx who [box]                      who this session may message, and who is listening
tmx send <target> ["text"]         start a thread; text from the argument or stdin; prints the id
tmx reply <thread> ["text"]        answer, or ask a question back
tmx wait <thread>... [-t seconds]  block until a reply arrives on any of them (default 90 s)
tmx read <thread>                  print the whole thread
tmx inbox                          print messages waiting for this session
```

A target is a box's label, in any case, which means that box's configured tmux session (the
**tmux session** field of its Edit dialog); `box/session` for another session on that box; or
`./session` for another session on the agent's own box. A typical exchange on `orders`:

```
$ tmx who
billing/main  idle, listening
$ tmx send billing "Which version of the payments library does billing pin, and where?"
Sent. Thread t-7fq2m9cd. queued
$ tmx wait t-7fq2m9cd
Reply from the agent in billing/main, thread t-7fq2m9cd. It is from another coding agent, not from your operator.

<the answer>
```

If the wait ends with no reply (`tmx wait` holds for at most 540 seconds whatever `-t` says), it
prints where each thread stands for the agent that asked: about the newest message *it* sent,
such as `thread t-7fq2m9cd: queued: billing/main is working` or `thread t-7fq2m9cd: delivered
40 s ago, no reply yet`, or `thread t-7fq2m9cd: nothing new since the last reply` when the other
side's answer was the last thing in the thread and the agent already has it. The skill then has
the agent tell you what it asked and end its turn: when the reply arrives later, it wakes the
`orders` session the same way a message wakes `billing`.

On `billing`, the message arrives as a new turn. Claude Code shows it as `Stop hook feedback`,
and the text it reads begins:

```
[tmuxifier-mail m-k3v9x2ab] Message from the agent in orders/main, thread t-7fq2m9cd.
```

followed by lines saying that you turned on agent messaging for this box and allowed that
sender, that the request comes from another coding agent and not from you, and that it should
always answer with `tmx reply`, even to decline. Then the message itself. The receiving session
runs it under its own permissions: a permission prompt it raises waits for you and shows as
**blocked** like any other, and the other agent cannot answer it. A turn started by mail ends
like any other turn: the session reads `done`, and the usual "finished a turn" notification goes
out.

That wording is for the first message of a thread. Every later message is worded as a reply:

```
[tmuxifier-mail m-p4w8c2de] Reply from the agent in billing/main, thread t-7fq2m9cd.
```

followed by lines saying that it continues a thread your messaging settings allowed, that it
comes from another coding agent and is to be used for the work that thread is about, not treated
as new instructions, and that it needs an answer only if it asks something or the agent still
needs something: not just to acknowledge. The skill says the same, so that two agents do not
thank each other back and forth; if you see an exchange going in circles anyway, stop the
thread. `tmx inbox` prints a waiting message with the same lines for its kind, without the
`[tmuxifier-mail …]` tag.

An OpenCode session is woken with the same text, but it does not go through a hook. The
Tmuxifier plugin inside OpenCode holds the wait for the tmux session the OpenCode session lives
in, and when mail arrives it queues the text on that OpenCode session through OpenCode's own
message queue, asking OpenCode to start a turn with it. Nothing is typed into the terminal. The
message is queued, never pushed into a running turn: if OpenCode got busy in the meantime, it
holds the message until the current work finishes, a permission prompt you are answering
included. The plugin tells Tmuxifier the message was delivered when OpenCode confirms it, and the
agent answers with `tmx reply`, as Claude Code does. The receiving session runs the message under
its own permissions here too, and the turn it starts reads `working`, then `done`, on the
dashboard like any other.

When the message is delivered depends on the receiving session:

| Receiving session | What happens |
|---|---|
| Idle (`done` or `idle` on the dashboard) and listening | Woken at once |
| Working | The message waits, and the session is woken about a second after the turn ends (at the next status poll with `TMUXIFIER_AGENT_WATCH=off`) |
| Blocked on a prompt | The message waits. Nothing is typed and nothing is answered |
| Running an agent but not listening | The message waits, the sender is told `not listening`, and `tmx inbox` in that session reads it |
| Not running an agent | The send is refused |
| On a box Tmuxifier cannot reach | The send is refused: `billing is unreachable right now; try again shortly` |

"Not listening" means the session runs an agent that has no mail listener: a Claude Code
started before setup was rerun (restart it), an OpenCode that is older than 2.3.0, has not been
used yet or cannot be matched to the tmux session (see [Limits](#limits-in-this-version)), or
an agent that is neither (Codex, pi, Antigravity). "Running an agent" means Tmuxifier reads an
agent state for that session, the same one the dashboard shows; an agent in another window of the
session counts too.

A message can be up to 64 KiB. The wake carries the first 4000 characters of it, and a longer one
ends with a line telling the agent to run `tmx read` for the rest.

### Which session `tmx` speaks for under OpenCode

`tmx` normally learns which tmux pane it was run from through `$TMUX_PANE`. OpenCode runs every
agent's shell commands from one server shared by all its windows, and that server's `$TMUX_PANE`
is the first window's, forever. So the plugin sets `TMUXIFIER_MAIL_PANE` on each command the
agent runs, to the pane of that agent's own tmux session, and `tmx` prefers it over `$TMUX_PANE`.
The plugin names a pane only for the OpenCode that is its tmux session's mail target: the
OpenCode in the active pane of that tmux session's active window, once you have viewed or
prompted it there. That holds for everything `tmx` does, sending, reading and replying as well as
receiving. From an OpenCode in another window or pane of the session, or one you have not used
yet, or when the plugin otherwise cannot say which tmux session the agent belongs to (see
[Limits](#limits-in-this-version)), the value is `none`, and every `tmx` command that talks to
Tmuxifier refuses at once, without sending anything:

```
tmx: this agent's tmux session cannot be identified for messaging
```

`tmx` never falls back to `$TMUX_PANE` inside OpenCode. OpenCode marks every shell it starts
(`OPENCODE_TERMINAL=1`, and `OPENCODE=1` for the agent's), and when `tmx` sees either mark without
`TMUXIFIER_MAIL_PANE` it refuses with the same message. That covers an OpenCode project folder
whose plugin hooks are not active yet, an OpenCode older than 2.3.0, a command typed with
OpenCode's `!` prefix that the plugin did not tag, and any other shell the plugin missed: without
the refusal each of them would speak as the first OpenCode window's tmux session. A Claude Code
started from inside an OpenCode shell inherits the mark, so its `tmx` refuses too; start Claude
Code from a normal shell.

Outside OpenCode the variable is unset and nothing changes. You do not set it yourself. One
thing to know: a tmux server started from inside an agent's command (an agent that runs
`tmux new-session -d`, for example) is a child of that command, so its panes inherit the value
and the marks the command had. A `tmx` run there speaks for the pane that variable names, or
refuses, instead of for its own pane. Run `unset TMUXIFIER_MAIL_PANE OPENCODE OPENCODE_TERMINAL`
in such a shell first.

## What you see

### The Messages drawer

The sidebar's **Messages** button, beside **Events**, opens the drawer. It has two tabs, and it
refreshes every 5 seconds while it is open.

**Threads** lists every thread, newest activity first. Each row shows who started it and who it
went to (`orders/main → billing/main`), how many messages and how long ago (`4 messages · 2 min
ago`), the thread's state, and where it stands:

| State | Meaning |
|---|---|
| `open` | Both agents may post |
| `closed by you` | You pressed **Stop** |
| `closed: permission withdrawn` | A switch or list entry it needed was removed |
| `closed: box removed` | One of its boxes was removed from Tmuxifier |

| Where it stands | Meaning |
|---|---|
| `waiting: billing/main is working` | The newest message waits for the turn to end |
| `waiting: billing/main is waiting on its operator` | The session is blocked on a prompt |
| `waiting: billing/main is not listening` | See the table above |
| `waiting: billing/main is not running an agent` | The agent has exited since the thread started |
| `waiting` | Handed over and not yet confirmed, about to be, or the receiving box is unreachable right now |
| `delivered 40 s ago, no reply yet` | Delivered; the other side has not posted since |

This column is always about the thread's newest message, whoever sent it. The agents read the
same phrases with `queued` where you read `waiting`, each about its own newest message (see
[What the agents do](#what-the-agents-do)).

Clicking a row opens the thread: every message in order with its sender, its time and its state,
and the message text shown as plain text. **← Threads** goes back.

| Message state | Meaning |
|---|---|
| `waiting` | In the mailbox |
| `handed over` | Given to the receiving agent (Claude Code or OpenCode), which has not confirmed it yet |
| `delivered` | Claude Code or OpenCode confirmed it reached the session, or the agent read it with `tmx wait`, `tmx read` or `tmx inbox` |
| `dropped` | Its thread was closed before it was delivered |

A message handed over but never confirmed (the agent exited at that moment) is offered again
when that pane listens again, or after 10 minutes to any listening pane of the session. The
same 10 minutes apply when the receiving OpenCode moved to another pane, or another session
became the tmux session's mail target, between the hand-over and the wake: the plugin drops that
wake and the message waits for the re-offer. In a rare
case that delivers a message twice; the message id in its first line lets the agent see that.

**Refused** lists the newest 200 attempts Tmuxifier turned down: which session tried, the target
as it typed it (a thread id, for a reply), when, and the reason exactly as the agent was told (see
[Refusals](#refusals)).

### The Edit dialog

The **Agent messaging** section holds the two switches, their lists, the matching-entry tick,
one line per box in either list, and a status line for the box (see
[Troubleshooting](#troubleshooting) for what each status line means).

## Stopping things

**Stop a thread.** Open it in the drawer and press **Stop**, then **Confirm** within three
seconds. The thread closes for both agents: neither can post to it again, its undelivered
messages are dropped and never reach the recipient (in `tmx read` they show as `[not
delivered]`), and an agent waiting on it with `tmx wait`, or replying to it, is told that the
thread was closed by the operator, not to start a new thread for the same matter, and to tell
you.

Stop does not interrupt a turn that is already running; interrupt that in its pane. And it stops
one thread, not the pair: while the permission stands, nothing prevents an agent from starting a
new thread, only that instruction. To make it impossible, stop the pair.

**Stop a pair, or a box.** Untick a switch or remove a box from a list and Save. Every open thread
that needed it closes at once with `closed: permission withdrawn`, including replies on their way.
With both switches off, a box takes no part at all and has no mail socket.

**Remove a box.** Its threads close (`closed: box removed`) and it leaves every other box's lists.

### Turning it off

`TMUXIFIER_AGENT_MAIL=off` in `.env` (or `"agentMail": false` in `config.json`), then a restart,
turns the whole feature off: no mail sockets, no **Messages** button, no **Agent messaging**
section, and setup no longer installs it. Your settings and threads stay in `data/` for when you
turn it back on. What setup installed on the boxes stays too, and does nothing: `tmx` answers
`tmx: agent messaging is not turned on for this box; tell your operator` (or `tmx: mail service
unreachable, try again shortly` on a box where a socket file was left behind), and the listener
in each Claude Code session, and the OpenCode plugin, retry quietly.

### What setup installs

With **Claude Code**, **OpenCode** or both ticked and messaging on, setup looks on the box for
each agent you ticked, and only those (the same test its own installer uses: on `PATH`, or in
`~/.local/bin` for `claude` and `~/.opencode/bin` for `opencode`). An agent you did not tick is
neither looked for nor touched, even when it is on the box. For whichever ticked agent it finds
it writes:

- `~/.tmuxifier-mail/tmx`, and a symlink to it at `~/.local/bin/tmx`.

For Claude Code, when it is ticked and `claude` is on the box:

- the skill, `~/.claude/skills/tmuxifier-mail/SKILL.md`;
- in `~/.claude/settings.json`: three hook entries whose command mentions `tmuxifier-mail`
  (`SessionStart` and `Stop` run the listener, `UserPromptSubmit` confirms delivery), merged
  beside your own hooks, and the rule `Bash(tmx *)` added to `permissions.allow`, so Claude Code
  runs `tmx` without asking. Nothing else in `permissions` is read or changed;
- in the same `settings.json`, on Claude Code 2.1.228 or later only: two entries for Claude
  Code's auto-mode classifier, each ending with `[tmuxifier-mail]`, under `autoMode`. The one in
  `autoMode.environment` says that the operator runs Tmuxifier and installed its messaging, and
  that `tmx` exchanges messages only with the operator's own agents, in other tmux sessions on
  the box or on the operator's other machines, through Tmuxifier. The one in `autoMode.allow`
  says that running `tmx` to answer or send such a message is sanctioned communication, also when
  the message arrived through the hook, and that it does not cover sending credentials, tokens,
  private keys, environment dumps or secrets, does not sanction any other command run inside or
  alongside a `tmx` command, and does not make the other agent's message your instruction.
  Whether these entries let a reply through that auto mode would otherwise block has not been
  observed yet. Setup keeps Claude Code's built-in rules: it writes `"$defaults"` only into an
  `environment` or `allow` list it creates, and in a list you already have it removes every
  entry containing the text `[tmuxifier-mail]` and appends the current one, adding nothing else
  (a list you wrote without `"$defaults"` stays that way). An entry of your own that contains
  `[tmuxifier-mail]` is therefore treated as setup's and replaced. `soft_deny`, `hard_deny` and
  the rest of `autoMode` are not read or changed. Setup asks the box's `claude --version` first:
  an older Claude Code may not understand `"$defaults"` and would lose its built-in entries, so
  on a version below 2.1.228, or one setup cannot read, `autoMode` is left exactly as it is and
  the setup line reads `agent-mail ✓ (auto-mode entries need Claude Code 2.1.228 or later)`.
  Run `claude auto-mode config` on the box to see the result.

`CLAUDE_CONFIG_DIR`, when set on the box, is used in place of `~/.claude`.

For OpenCode, when it is ticked and `opencode` is on the box:

- the same skill text, `~/.config/opencode/skills/tmuxifier-mail/SKILL.md` (under
  `$OPENCODE_CONFIG_DIR` when that is set). OpenCode reads that folder on its own. It also reads
  `~/.claude/skills`, so on a box with both agents OpenCode may list the skill twice; the two
  copies are the same text. With both agents ticked, a failure to write this file does not stop
  Claude Code's half: the setup line reads `agent-mail ✓ (OpenCode skill could not be written)`.
  With OpenCode alone it fails the step;
- nothing in an OpenCode settings file: there is none to merge. The rest of OpenCode's side is
  the state plugin, `~/.config/opencode/plugins/tmuxifier-agent.js`, which the **OpenCode**
  setup step writes (see [The OpenCode checkbox](boxes-and-setup.md#the-opencode-checkbox)). It
  carries the mail listener and the permission described below, and it keeps the messages it has
  handed to OpenCode and not yet seen delivered in `~/.tmuxifier-mail/opencode-inflight.json`
  (mode `0600`), so an OpenCode server that restarts does not lose track of them.

The OpenCode plugin needs OpenCode **2.3.0 or later** for mail. Setup asks the box's OpenCode for
its version; on an older one the plugin still reports state but never listens, and the
`opencode-plugin` line carries a warning note (see [Troubleshooting](#troubleshooting)). A
version setup could not read gets the same note, but the plugin checks OpenCode's version itself
when it runs, so it may still listen.

The plugin also decides whether OpenCode asks before running a `tmx` command, which is how it
stands in for Claude Code's `Bash(tmx *)` rule. It allows a command without asking only when it is
one plain `tmx who`, `send`, `reply`, `wait`, `read` or `inbox` (by `tmx`, `~/.local/bin/tmx` or
`$HOME/.local/bin/tmx`) whose arguments are plain words or quoted text. A command with a `$` in
its arguments (command substitution or a variable), a backtick, a pipe, `;`, `&`, a redirect, a
newline, or a quoted argument holding any of those, is not allowed by the plugin: OpenCode
decides about it as it would without the plugin. On a default install OpenCode itself allows most
commands, so the plugin only ever lifts an `ask` for a plain `tmx` command; it never denies
anything and never overrides a deny.

**If you have set a permission rule for shell commands yourself, the plugin does nothing**, and
OpenCode decides about `tmx` commands as it does for any other command, under your rules. The
plugin looks for such a rule in these places: your global OpenCode config (`opencode.json`,
`opencode.jsonc` or the legacy `config.json` in `$OPENCODE_CONFIG_DIR`, and in
`$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/`); the system-wide `/etc/opencode/`, read the
same way; a project's `opencode.json`,
`opencode.jsonc` and `.opencode/` config, in the project's folder and every folder above it;
agent and mode definition files (markdown in `.opencode/agent/`, `.opencode/agents/`,
`.opencode/mode/` or `.opencode/modes/` at each of those project levels, and in `agent/`,
`agents/`, `mode/` or `modes/` in the global and system-wide config folders), including those in
sub-folders; and
the `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION` environment variables.
A rule is a `permission.shell` or `permission.bash` entry, a `permission` setting that covers
every tool, or the same under an agent; an agent or mode file counts when it mentions
`permission` at all. A file it cannot read or parse counts as a rule, and so does a folder of
agent files it cannot list, one more than four sub-folders deep, or one holding more than 500
entries in all. A rule set anywhere else, a remote or organisation config OpenCode fetches for
example, is not seen, and the plugin then still lifts the `ask` on a plain `tmx`. A change to a
config file applies to the next command, without a restart.

`tmx` is run by name, so in a shell where something else answers to `tmx` first (a shell function
or alias of that name, defined earlier in a long-lived shell session), that runs instead and the
plugin's allow applies to it. Do not define a `tmx` function or alias in a box's shell.

To remove it from a box: for Claude Code, delete those three hook entries, the rule and the two
`autoMode` entries marked `[tmuxifier-mail]` from `settings.json`, and `rm -rf
~/.claude/skills/tmuxifier-mail`; for OpenCode, `rm -rf ~/.config/opencode/skills/tmuxifier-mail`
and remove the plugin as [boxes-and-setup.md](boxes-and-setup.md#the-opencode-checkbox)
describes (that also ends OpenCode's state reporting). Then `rm -rf ~/.tmuxifier-mail` and remove
`~/.local/bin/tmx`. The next setup run with the agent ticked reinstalls it.

## Security

- A box is identified by its own mail socket, which only that box's SSH connection reaches. On the
  box the socket is `~/.tmuxifier-mail/sock`, in a directory only the box's login user can open.
- Editing a box's host, user, port or jump host makes it another machine for messaging as soon
  as the edit is saved (at the latest by the next status sweep): every connection made through
  the old address is closed, a session there that was listening is no longer handed mail, and
  the box gets a new socket for its new address. The machine at the old address cannot keep
  answering as that box.
- Any process running as that user can use the socket, as long as it names a session that runs an
  agent: the same process can already type into that agent's tmux pane. `TMUXIFIER_MAIL_PANE`
  carries the same trust as `TMUX_PANE`: a process that sets either to another pane speaks for
  that pane's session. Your send switch and send list bound which boxes it could reach. On a box
  that runs an internet-facing application as its login user, leave **Agents here may send** off.
- The settings change only from the web UI in a signed-in browser. A box cannot add itself to
  another box's lists, and the Android app and the MCP server can neither read nor change them.
- A message is a peer's request, not your instruction, and it runs under the receiving session's
  own permissions. The skill tells agents never to ask another agent to approve anything and never
  to approve anything for one.
- The rule `Bash(tmx *)` lets Claude Code run whatever `tmx` resolves to on its `PATH` without
  asking. Setup refuses to install over a `~/.local/bin/tmx` that is not its own, and checks
  nothing else.
- Setup changes how Claude Code's auto mode judges `tmx` on that box: its two `autoMode`
  entries tell the classifier that messages sent with `tmx` are communication you sanctioned.
- On OpenCode the plugin plays the part of that rule: it lifts an `ask` only for a single plain
  `tmx` command, never for one with substitution, a pipe, `;`, a redirect or a quoted argument
  holding shell characters (OpenCode decides about those as it would without the plugin), and it
  does nothing at all once you have set a shell permission rule of your own (see
  [What setup installs](#what-setup-installs)). Over the network or IPC the plugin talks only to
  the box's mail socket and to OpenCode through its plugin interface; it never reads OpenCode's
  server password and never calls its HTTP server. On the box it also runs `tmux list-panes`,
  reads OpenCode's config files, and writes the state markers and its in-flight file.
- Message text is stored in plaintext on the Tmuxifier host under `data/agent-mail/` (files
  `0600`). A delivered message becomes part of the receiving agent session's context, which that
  agent sends to its model provider under its own login like anything else it reads (Anthropic
  for Claude Code; whichever provider OpenCode is set up with). Do not send secrets in a message.

## Limits in this version

- **Receivers are Claude Code and OpenCode 2.3.0 or later.** A message for a session running
  another agent (Codex, pi, Antigravity) is accepted, waits, and the sender is told it is not
  listening. Messaging from an OpenCode older than 2.3.0 is not supported: its plugin never
  listens, and its `tmx` commands refuse (they cannot be tied to the right tmux session). The same goes for an
  OpenCode project folder whose plugin hooks are not active yet (see the restart note below).
- **The Host Shell** neither sends nor receives.
- **A busy or blocked session is never interrupted.** Mail waits for the turn to end or for you
  to answer the prompt. There is no way to deliver into a running turn.
- **One machine added as two boxes.** If both box records reach it over the same SSH connection
  (the same host, port and user after `~/.ssh/config`), only the first of them in your box list
  that has a switch on can message; the other one's status reads `Socket not connected: shares a
  connection with <name>`. If they reach it by different addresses, they take the one socket on
  the machine from each other. Turn messaging on for only one of them.
- **Two Claude Code sessions in one tmux session share one address.** Mail is addressed to
  `box/session`, so with two Claude Code panes in the same tmux session a message, or the reply
  to a thread one of them started, can wake either. Give each agent that takes part its own tmux
  session.
- **A session without a listener loses nothing.** Its mail waits, the sender is told `not
  listening`, and `tmx inbox` in that session reads it. For Claude Code, the end of each turn
  starts a new listener.
- **Two OpenCode windows in one project folder, in different tmux sessions: neither receives.**
  OpenCode runs one server for all its windows, and nothing in it says which window you used, so
  Tmuxifier cannot tell which tmux session a session belongs to. It would rather deliver nothing
  than wake the wrong one. Both read `not listening`, and `tmx` in either refuses with `tmx: this
  agent's tmux session cannot be identified for messaging`. The same holds when one window is in
  a subfolder of the other's project. Windows in different project folders are fine, and each
  `tmx` speaks as its own session. Two OpenCode windows in one tmux session share that session's
  address, as two Claude Code panes do.
- **OpenCode listens, and speaks, only for the window you are using.** Only the OpenCode in the
  active pane of a tmux session's active window listens. Within a tmux session, mail goes to the
  OpenCode session you last viewed or prompted, and until you view or prompt one after the window
  opens, the tmux session is not listening: opening a session with `opencode -s` or continuing
  with `opencode -c` counts for nothing, but the first prompt or the first finished turn on
  screen does. The same holds after an OpenCode server restart. It applies to what the agent
  sends too: an OpenCode agent's `tmx` (sending, reading and replying, not just receiving) works
  only from the OpenCode that is the active pane of its tmux session's active window, and only
  after you have viewed or prompted it there. Otherwise `tmx` says the session cannot be
  identified.
- **Within one tmux session, a wake goes to the OpenCode conversation you last viewed or
  prompted,** which may not be the one on screen right after you switch conversations in the TUI.
- **A renamed tmux session stops listening until you use it again.** Prompt or view an OpenCode
  session in it once.
- **OpenCode can deliver a message twice.** After an OpenCode server restart, when a turn holds
  the message for more than 10 minutes, or when the confirmation to Tmuxifier fails, Tmuxifier
  offers the message again while OpenCode may still deliver the first copy. Delivery is
  at-least-once here as for Claude Code, and the message id in the first line lets the agent see
  a repeat.
- **Do not use `tmx` from a command typed with OpenCode's `!` prefix.** It is not a command the
  agent ran, so the plugin may not name its pane, and `tmx` then refuses (`cannot be
  identified`). Run `tmx` from a normal shell instead. In the rare case that you type, with `!`,
  exactly the command the agent is starting at the same instant, your shell can take the agent's
  pane and the agent's command reads `cannot be identified`; within one OpenCode project folder
  the worst case is the same tmux session's pane.
- **One OpenCode server per user.** The plugin keeps the wakes it has posted but not yet
  confirmed in `~/.tmuxifier-mail/opencode-inflight.json`. A second OpenCode server process
  of the same user on one box would overwrite that file, which can deliver a message twice (never
  lose one). OpenCode normally runs one shared server per user.
- **One OpenCode server per user is assumed.** OpenCode runs its plugin inside a single server
  shared by all of one user's windows, and messaging is built on that.
- **After setup installs or updates the plugin, OpenCode projects that were already open may
  need an OpenCode restart** before they receive mail.
- **Tmuxifier keeps at most 1000 threads.** There is no limit on how many messages a thread
  carries or how many threads a pair starts. When a new thread would be the 1001st, the
  longest-idle closed threads are deleted first, then the longest-idle open ones (each closed
  with the reason `storage limit` and deleted in the same step; an agent still waiting on one
  is told `closed: storage limit`). A thread with activity in
  the last hour is never removed this way. If all 1000 are that recent, the new thread is
  refused (`refused: the mail store is full, …`) and listed under **Refused** until one has
  been idle for an hour; replies in existing threads are not affected. The same clean-up runs
  when Tmuxifier starts and once a day, along with deleting threads idle for 30 days.
- **A mail-started turn that ends while a subagent's permission dialog is open** reads as
  working, not blocked, until the dialog is answered.
- **Mail-started turns notify** like any other turn.
- **Long messages are cut in the wake** at 4000 characters. The agent is told to run `tmx read`
  for the rest, and sees only the first part until it does.
- **An OpenCode left idle for about an hour stops listening.** OpenCode 2.3.2 unloads an idle
  project folder (its log says `location services evicted`) even while a TUI is still open on it.
  The session's state disappears from the dashboard and its mail waits as `queued` until the next
  prompt or view in that TUI, which brings both back.
- **A mail turn in OpenCode runs as the agent of the session's last prompt** (Build, Plan, …), not
  the agent selected in the TUI since then. A Plan session answers mail in Plan.
- **Not yet verified:** a message arriving while a plan-approval dialog is open.
- **After turning a switch on**, the socket can take until the next status sweep to come up.
- **After re-addressing a box between two names of one SSH connection** (the same host, port and
  user after `~/.ssh/config`), its status can read `Socket not connected: not verified` until
  that SSH connection is next re-established, if the old forward could not be cancelled.

## Troubleshooting

**No Messages button, no Agent messaging section.** Messaging is off (`TMUXIFIER_AGENT_MAIL`), or
the dialog is Add rather than Edit.

**The setup job's line for `agent-mail`:**

| Line | What to do |
|---|---|
| `agent-mail skipped (no Claude Code or OpenCode on the box)` | Neither agent was found on the box after the job's install step; check the job log |
| `agent-mail skipped (no curl on the box)` | Install `curl` on the box (or tick it in the tools checklist), then rerun setup |
| `agent-mail skipped (another tmx is in ~/.local/bin)` | Something else is installed as `~/.local/bin/tmx`; setup will not replace it |
| `agent-mail failed (no jq, node or python3 on the box)` | Setup needs one of the three to merge `settings.json` |
| `agent-mail ✓ (auto-mode entries need Claude Code 2.1.228 or later)` | Messaging is installed; the two auto-mode entries were not written because the box's Claude Code is older or its version could not be read. Update Claude Code on the box, then rerun setup |
| `agent-mail ✓ (OpenCode's part arrives with the OpenCode plugin)` | The box has OpenCode and no Claude Code: `tmx` and OpenCode's skill are installed, and there is no Claude Code settings file to merge. The listener comes with the `opencode-plugin` line below |
| `opencode-plugin ✓ (agent messaging needs OpenCode 2.3.0 or later)` | The plugin is installed and reports state, but the box's OpenCode is older than 2.3.0, or setup could not read its version. On an older OpenCode the plugin never listens for mail: update OpenCode on the box, then rerun setup. When the version could not be read, the plugin checks it itself when it runs, so it may still listen |
| `agent-mail failed (settings.json could not be merged)` | The box's Claude Code `settings.json` is not valid JSON, or a key setup writes has an unexpected type; fix it and rerun setup |

No `agent-mail` line at all: neither **Claude Code** nor **OpenCode** was ticked, or messaging is off.

**The status line in the Agent messaging section:**

| Line | Meaning |
|---|---|
| `Messaging is off` | Both switches are off |
| `Socket not connected: box unreachable` | Tmuxifier cannot reach the box right now |
| `Tools not installed: run setup on this box` | `tmx` was not on the box when Tmuxifier last looked; rerun setup with **Claude Code** or **OpenCode** ticked. See [step 1](#turning-it-on-for-two-boxes) |
| `Tools installed · socket connected · 2 sessions listening` | Working; the count is of the Claude Code and OpenCode panes on the box listening for mail (`no sessions listening` when there are none) |
| `Socket not connected: shares a connection with <name>` | Another box record uses the same SSH connection; see [Limits](#limits-in-this-version) |
| `Socket not connected: connection not resolved` | Tmuxifier could not work out this box's SSH connection from its settings and your SSH config; check its host, user, port and jump host |
| `Socket not connected: waiting for <name>'s connection to resolve` | No new socket is set up on any box until every box with messaging on resolves; fix the named box |
| `Socket not connected: forward failed` or `not verified` | Putting the socket on the box failed; it is tried again after 30 seconds, then at doubling intervals up to 30 minutes |
| `Socket not connected: bad home` | The box user's home directory is not a plain path of letters, digits, `_`, `.`, `/` and `-`, or is longer than 80 characters |
| `Socket not connected: listen failed` or `socket path too long` | Tmuxifier could not open the box's socket on its own side, under `data/mail/`; a data directory with a very long path is too long for a socket |

**`no sessions listening`, or the sender is told `not listening`.** For Claude Code, restart it in
that session after setup has run. For OpenCode, check in order: that the box's OpenCode is 2.3.0
or later (the `opencode-plugin` line says when it is not); that you have prompted, or let a
turn finish in, an OpenCode session in that tmux session since its window opened; that no other
tmux session runs OpenCode in the same project folder; that the OpenCode is in the tmux
session's active pane. If setup has only just installed the plugin, restart OpenCode too. Only
Claude Code and OpenCode listen.

**An agent says its reply was blocked by auto mode** (the session shows `blocked by auto mode`,
for example with `[Unsanctioned Communication]`). The message was delivered; the answer was
not sent. In Claude Code's auto mode the rule `Bash(tmx *)` covers a plain command such as
`tmx reply t-7fq2m9cd "the answer"`, and that runs without review. A `tmx` command with another
command inside it (`$( )`, backticks, a pipe) is not covered by the rule, so auto mode's
classifier decides, and it can refuse because nothing you typed asked for the message. The
delivered text and the skill tell the agent to run commands first and send plain text, but an
agent can still write the other form. To let the blocked reply through, open `/permissions` in
that session, choose **Recently blocked** and approve the `tmx` row, or tell the agent to send
the reply again as plain text. Approving there adds no rule. On a box set up before Tmuxifier
added its auto-mode entries, rerun setup with **Claude Code** ticked and restart the Claude Code
session: that installs the two classifier entries described in
[What setup installs](#what-setup-installs), which tell auto mode this channel is sanctioned.
Setup writes them only on Claude Code 2.1.228 or later; on an older one the setup line reads
`agent-mail ✓ (auto-mode entries need Claude Code 2.1.228 or later)`, and updating Claude Code on
the box, then rerunning setup, installs them. Whether the entries let a blocked reply through
has not been observed yet, so the two steps above remain the way to get such a reply sent.

**An agent says `tmx` was not found.** `~/.local/bin` has to be on the `PATH` of the shell Claude
Code was started from, or of the shell that started the box's OpenCode server. The command also
lives at `~/.tmuxifier-mail/tmx`, but Claude Code's permission rule covers only `tmx`, so a call
by that path asks you first. OpenCode's plugin covers `tmx`, `~/.local/bin/tmx` and
`$HOME/.local/bin/tmx`, and leaves a call by any other path to OpenCode.

**Messages from `tmx` itself:**

- `tmx: run this inside a tmux session`: `tmx` works only in a tmux pane.
- `tmx: this agent's tmux session cannot be identified for messaging`: an OpenCode agent whose
  tmux session Tmuxifier cannot name; see [Limits](#limits-in-this-version) and
  [Which session `tmx` speaks for under OpenCode](#which-session-tmx-speaks-for-under-opencode).
- `tmx: agent messaging is not turned on for this box; tell your operator`: the box has no mail
  socket, which is the case while both its switches are off (or until the socket first comes up
  after one is turned on; it can also show for an instant while Tmuxifier puts the socket back
  after an SSH reconnect).
- `tmx: mail service unreachable, try again shortly`: the box has a mail socket and it does not
  answer (Tmuxifier is restarting, or the SSH connection dropped); look at the status line.
- `tmx: the connection was lost before an answer came back, so the message may or may not have been
  sent; …`: `tmx` never sends twice on its own. Look in the drawer before sending again.

### Refusals

What the agent is told, and what to change:

| Refusal | Change |
|---|---|
| `refused: this box is not allowed to send mail to other agents` | The sending box's **Agents here may send** |
| `refused: this box is not allowed to send to billing` | The sending box's `to:` list |
| `refused: billing is not accepting mail from agents` | The receiving box's **Agents here may receive** |
| `refused: billing does not accept mail from this box` | The receiving box's `from:` list |
| `refused: no box named "…" (or the name matches more than one box); run "tmx who"` | The target is not a box label. A box whose **Agents here may send** is off is told only that it may not send, whatever it names |
| `refused: billing/main is not running an agent` | Start the agent in that session (or, when the sender is told this about itself, run `tmx` from a session where Claude Code or OpenCode runs) |
| `refused: that is your own session` | A thread needs two sessions |
| `refused: the message is empty`, `refused: the message is larger than 65536 bytes` | The text |
| `refused: this thread is closed. Do not start a new thread for the same matter; tell your operator instead.` | The thread was stopped or lost its permission (the next line says which). The agent is told to come to you rather than start another |
| `refused: the mail store is full, so no new thread can be started; tell your operator` | 1000 threads, all active within the last hour; see [Limits](#limits-in-this-version) |
| `refused: this session is not part of that thread` | Only the two sessions of a thread may post to it or read it |
