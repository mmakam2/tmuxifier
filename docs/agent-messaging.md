# Agent messaging

How the Claude Code sessions on your boxes send each other tasks and replies through Tmuxifier:
turning it on for a pair of boxes, what the agents type, what you see, how to stop an exchange,
and what this version does not do. Part of the [Tmuxifier docs](../README.md).

Box names (`orders`, `billing`) and session names (`main`, `review`) below are placeholders.

## What it does

You are working with Claude Code on `orders`, and it needs something only the agent on `billing`
can see or do: a version it pins, a test run, a file. With messaging on, the agent on `orders`
runs `tmx send billing "…"`. Tmuxifier checks that the two boxes are allowed to talk, holds the
message until the Claude Code session on `billing` is idle, and then wakes that session with
it. Nothing is typed into the terminal. The agent on `billing` does the work and answers with
`tmx reply`, and the answer comes back to the agent on `orders`. Both agents can keep posting
in the same thread for as long as the permission that started it holds.

- Every message travels between Tmuxifier and the boxes over the SSH connections Tmuxifier
  already holds. Nothing goes over the internet, and the boxes never talk to each other directly.
- Every box is off until you turn it on, separately for sending and for receiving, with a list
  of the boxes it may send to and receive from.
- Every thread and every refused attempt shows in the **Messages** drawer, and you can stop any
  thread there.
- It works between Claude Code sessions that are already running. It never starts a session.

Messaging is on in Tmuxifier by default. `TMUXIFIER_AGENT_MAIL=off` in `.env` removes it
entirely (see [Turning it off](#turning-it-off)).

## Turning it on for two boxes

To let the agent on `orders` send work to the agent on `billing`:

1. **Set up both boxes with Claude Code.** Open each box's Edit dialog, tick **Claude Code** in
   the tools checklist and **Save**. When the setup job reports done, its status line includes
   `agent-mail ✓`. This installs the `tmx` command, the skill that teaches Claude Code to use
   it, three Claude Code hooks and one permission rule (see
   [What setup installs](#what-setup-installs)). A box set up before this feature existed needs
   this step too.
2. **Restart Claude Code** in every session that should take part. Claude Code reads its hooks
   and skills when it starts, so a `claude` that was already running neither receives mail nor
   knows the command.
3. **Edit `orders`.** In the **Agent messaging** section, tick **Agents here may send** and pick
   `billing` from the **add box** list after `to:`. Leave **When adding a box, also write the
   matching entry on that box** ticked: on Save it also puts `orders` in `billing`'s receive
   list. **Save.**
4. **Edit `billing`.** Tick **Agents here may receive**. Its `from:` list already shows `orders`.
   **Save.** The tick in step 3 never turns on the other box's switches; this step does.
5. **Check.** Reopen either dialog. On `orders` the line for the pair reads `billing   send ✓`,
   and the last line of the section reads `Tools installed · socket connected · 1 session
   listening` once a Claude Code session on that box is listening for mail.

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

The skill tells Claude Code when to use messaging (you ask it to consult, ask or hand work to the
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
started before setup was rerun (restart it), or an agent that is not Claude Code. "Running an
agent" means Tmuxifier reads an agent state for that session, the same one the dashboard shows;
an agent in another window of the session counts too.

A message can be up to 64 KiB. The wake carries the first 4000 characters of it, and a longer one
ends with a line telling the agent to run `tmx read` for the rest.

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
| `handed over` | Given to the receiving Claude Code, which has not confirmed it yet |
| `delivered` | Claude Code confirmed it reached the session, or the agent read it with `tmx wait`, `tmx read` or `tmx inbox` |
| `dropped` | Its thread was closed before it was delivered |

A message handed over but never confirmed (Claude Code exited at that moment) is offered again
when that pane listens again, or after 10 minutes to any listening pane of the session. In a rare
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
in each Claude Code session retries quietly.

### What setup installs

With **Claude Code** ticked and messaging on, setup writes, on the box:

- `~/.tmuxifier-mail/tmx`, and a symlink to it at `~/.local/bin/tmx`;
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

`CLAUDE_CONFIG_DIR`, when set on the box, is used in place of `~/.claude`. To remove it from a
box: delete those three hook entries, the rule and the two `autoMode` entries marked
`[tmuxifier-mail]` from `settings.json`, then `rm -rf
~/.tmuxifier-mail ~/.claude/skills/tmuxifier-mail` and remove `~/.local/bin/tmx`. The next setup
run with Claude Code ticked reinstalls it.

## Security

- A box is identified by its own mail socket, which only that box's SSH connection reaches. On the
  box the socket is `~/.tmuxifier-mail/sock`, in a directory only the box's login user can open.
- Editing a box's host, user, port or jump host makes it another machine for messaging as soon
  as the edit is saved (at the latest by the next status sweep): every connection made through
  the old address is closed, a session there that was listening is no longer handed mail, and
  the box gets a new socket for its new address. The machine at the old address cannot keep
  answering as that box.
- Any process running as that user can use the socket, as long as it names a session that runs an
  agent: the same process can already type into that agent's tmux pane. Your send switch and send
  list bound which boxes it could reach. On a box that runs an internet-facing application as its
  login user, leave **Agents here may send** off.
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
- Message text is stored in plaintext on the Tmuxifier host under `data/agent-mail/` (files
  `0600`). A delivered message becomes part of the receiving Claude Code session's context, which
  that box's Claude Code sends to Anthropic under its own login like anything else the agent
  reads. Do not send secrets in a message.

## Limits in this version

- **Receivers must be Claude Code.** A message for a session running another agent (OpenCode,
  Codex, pi, Antigravity) is accepted, waits, and the sender is told it is not listening.
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
  listening`, and `tmx inbox` in that session reads it. The end of each turn starts a new
  listener.
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
- **Not yet verified:** a listener left idle for hours (31 minutes was the longest observed), and a
  message arriving while a plan-approval dialog is open.
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
| `agent-mail skipped (no Claude on the box)` | Claude Code was not found on the box after the job's install step; check the job log |
| `agent-mail skipped (no curl on the box)` | Install `curl` on the box (or tick it in the tools checklist), then rerun setup |
| `agent-mail skipped (another tmx is in ~/.local/bin)` | Something else is installed as `~/.local/bin/tmx`; setup will not replace it |
| `agent-mail failed (no jq, node or python3 on the box)` | Setup needs one of the three to merge `settings.json` |
| `agent-mail ✓ (auto-mode entries need Claude Code 2.1.228 or later)` | Messaging is installed; the two auto-mode entries were not written because the box's Claude Code is older or its version could not be read. Update Claude Code on the box, then rerun setup |
| `agent-mail failed (settings.json could not be merged)` | The box's Claude Code `settings.json` is not valid JSON, or a key setup writes has an unexpected type; fix it and rerun setup |

No `agent-mail` line at all: **Claude Code** was not ticked, or messaging is off.

**The status line in the Agent messaging section:**

| Line | Meaning |
|---|---|
| `Messaging is off` | Both switches are off |
| `Socket not connected: box unreachable` | Tmuxifier cannot reach the box right now |
| `Tools not installed: run setup on this box` | `tmx` was not on the box when Tmuxifier last looked; rerun setup with **Claude Code** ticked. See [step 1](#turning-it-on-for-two-boxes) |
| `Tools installed · socket connected · 2 sessions listening` | Working; the count is of the Claude Code panes on the box listening for mail (`no sessions listening` when there are none) |
| `Socket not connected: shares a connection with <name>` | Another box record uses the same SSH connection; see [Limits](#limits-in-this-version) |
| `Socket not connected: connection not resolved` | Tmuxifier could not work out this box's SSH connection from its settings and your SSH config; check its host, user, port and jump host |
| `Socket not connected: waiting for <name>'s connection to resolve` | No new socket is set up on any box until every box with messaging on resolves; fix the named box |
| `Socket not connected: forward failed` or `not verified` | Putting the socket on the box failed; it is tried again after 30 seconds, then at doubling intervals up to 30 minutes |
| `Socket not connected: bad home` | The box user's home directory is not a plain path of letters, digits, `_`, `.`, `/` and `-`, or is longer than 80 characters |
| `Socket not connected: listen failed` or `socket path too long` | Tmuxifier could not open the box's socket on its own side, under `data/mail/`; a data directory with a very long path is too long for a socket |

**`no sessions listening`, or the sender is told `not listening`.** Restart Claude Code in that
session after setup has run. Only Claude Code listens.

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
Code was started from. The command also lives at `~/.tmuxifier-mail/tmx`, but the permission rule
covers only `tmx`, so a call by that path asks you first.

**Messages from `tmx` itself:**

- `tmx: run this inside a tmux session`: `tmx` works only in a tmux pane.
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
| `refused: billing/main is not running an agent` | Start the agent in that session (or, when the sender is told this about itself, run `tmx` from a session where Claude Code runs) |
| `refused: that is your own session` | A thread needs two sessions |
| `refused: the message is empty`, `refused: the message is larger than 65536 bytes` | The text |
| `refused: this thread is closed. Do not start a new thread for the same matter; tell your operator instead.` | The thread was stopped or lost its permission (the next line says which). The agent is told to come to you rather than start another |
| `refused: the mail store is full, so no new thread can be started; tell your operator` | 1000 threads, all active within the last hour; see [Limits](#limits-in-this-version) |
| `refused: this session is not part of that thread` | Only the two sessions of a thread may post to it or read it |
