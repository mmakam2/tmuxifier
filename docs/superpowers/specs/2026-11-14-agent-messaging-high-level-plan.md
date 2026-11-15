# Agent messaging: high-level plan

**Date:** 2026-11-14
**Status:** high-level plan from a brainstorm. Not the final design: two delivery mechanisms are
unproven, and the full design is written after the spikes in section 9.

Box names in this document (`orders`, `billing`) are placeholders.

## 1. Intent

Coding agents on different boxes should be able to hand each other work and talk to each other,
with Tmuxifier as the control plane that carries, gates and shows every message.

The operator's primary cases, in their order:

1. **Peer calls.** The operator is working with the agent on one microservice box, and that agent
   needs something from the agent on another box.
2. **A lead agent directing workers** on other boxes.
3. Dispatch by the operator from the dashboard. May exist later, on the same plumbing.

Why Tmuxifier: it already holds an SSH connection to every box, knows each session's agent state
within about a second, and is the one place a per-box permission can be enforced and seen.

## 2. What the operator decided

These are the operator's decisions, as they made them.

- **Self-hosted is primary.** Messages never travel over the internet.
- **A proper messaging protocol**, with a mailbox, and a skill that teaches each agent to use it.
- **The mailbox lives on Tmuxifier's backend**, not on the boxes. Agents read and write to it.
- **Only coding agents use it.** The software hosted on a box (for example a site served through a
  tunnel) must not be able to use the channel. The web dashboard and the phone app are the
  operator's window onto agents, and are fine.
- **A tagged message is pushed into a running session on the target box**, not only to fresh
  workers.
- **Per-box send and receive switches, each with a list of boxes**: "may send to" and "may receive
  from". Both are edited in the Edit Box modal and filled with box names. A box typically talks to
  3 to 10 others, so hand-adding is acceptable.
- **A bulk grid editor** in Settings is wanted later, writing the same lists.
- **Not built on the existing MCP tools.** This is a fresh design.

## 3. Goals, non-goals, anti-goals

**Goals**

- An agent on box A sends a task or question to an agent on box B and gets the reply back as text.
- The exchange stays open both ways: follow-ups from the caller, questions back from the worker.
- A lead can hand out several tasks and wait on any or all of them.
- The operator can see every thread, and can stop any box from sending or receiving.
- Works for Claude Code first. Codex, OpenCode, pi and agy follow.

**Non-goals (first versions)**

- Sending from the dashboard or phone as the operator.
- An endpoint for agents outside the fleet (A2A gateway).
- Claude's cloud cross-machine messaging. It bypasses the control plane, so it cannot be gated,
  budgeted or shown. The operator said they would like cloud support eventually; it is left out
  until the self-hosted path works, and would be a separate, ungated option.
- A service-to-service bus. Hosted applications never use this.

**Anti-goals: these would make it a failure even if it works**

- A box's hosted application, or anything on the internet, can put a message in front of an agent.
- One agent answers another agent's permission prompt.
- A message reaches every agent on a box, so several act on the same task.
- A compromised box can add itself to another box's lists.
- Two agents message each other without limit.

## 4. Facts found during the brainstorm

- **The live app listens on loopback behind a tunnel.** No box can call the HTTP API directly.
- **Tmuxifier reaches every box over SSH** through a ControlMaster, and already keeps one resident
  stream per reachable box (`agentWatch.js`).
- **The Claude hook payloads carry what a reply needs.** `Stop` has `last_assistant_message` and
  `prompt_id`; `UserPromptSubmit` has the same `prompt_id`. Recorded in
  `test/fixtures/claude-hook-trace.jsonl`. A turn's answer can be tied to the prompt that started
  it, with no screen reading.
- **No box has a startup command.** Agents are started by hand today, so a "fresh worker" has to
  be started by this feature.
- **Most boxes log in as root.** A socket owned by that user and mode `0600` is reachable only by
  processes running as that user.
- **Headless Claude is a documented path** (checked against the docs on 2026-11-14, Claude Code
  2.1.325): `claude -p "<task>" --session-id <uuid> --output-format json` returns the result;
  `--resume <uuid>` sends a follow-up; `claude --resume <uuid>` opens the same conversation
  interactively later. `--permission-mode` and `--permission-prompts none` decide what happens
  where an interactive session would prompt. Two processes on one conversation are not locked out
  and interleave.
- **Documented but untested here:** a `Stop` hook returning `decision: "block"` with a reason
  keeps the turn going with that reason as input; `asyncRewake` hooks can wake a session when a
  background hook exits with code 2.
- **Prior art.** herdr drives interactive agents by typing into panes, reads replies off the
  screen, does not track turns, reaches other machines over SSH from the machine holding the
  keys, has no reverse channel, and lets the calling agent answer the other agent's prompt.
  Other projects carry messages over a relay or Git sync. Wrappers that expose a coding agent
  over A2A run one HTTP server per agent and need mutual TLS off loopback. None of them has a
  per-machine permission model.

## 5. The shape

### 5.1 Mail store (backend)

Threads live in Tmuxifier's data directory, written through the existing JSON persistence. A thread
has an id, the two participants (`box/session` each), and an ordered list of messages. A message
has a kind (`task`, `reply`, `question`, `note`), a body, a sender stamped by the backend, and a
time. The vocabulary follows A2A's task model so a gateway could be added later without renaming
things. The format carries a version number.

The backend is the source of truth for threads, the audit trail and the per-thread message budget.

### 5.2 How a box reaches the backend

Tmuxifier forwards one unix socket onto each box through the SSH connection it already holds
(`ssh -O forward -R <box socket>:<backend socket>`). The backend listens on a separate local socket
per box, so the listener a request arrives on identifies the box. No credential is stored on any
box, no port is opened, and the mail interface is **not** mounted on the web API at all.

Proven on 2026-11-14 against the isolated test sshd (`test/helpers/localBox.js`):

- Forwarding onto a connection that is already open works, and a call from the box side reaches
  the backend listener.
- The socket on the box is created `srw-------`.
- A request held open for 3 seconds returns correctly.
- When the connection drops, the socket file stays behind dead and a new forward fails until the
  file is removed. Remove-then-forward recovers. Calls on the dead socket fail at once.

A read-only fleet check the same day: every box that could report allows socket forwarding, none
removes a dead socket by itself, all run OpenSSH 9.2 or newer, and `curl` and `python3` were
present on every reachable box (`node` on about half).

### 5.3 The agent's side

A small command on the box (working name `tmx`), installed by setup and taught by a skill (an
`AGENTS.md` snippet for agents without skills). It speaks HTTP over the forwarded socket with
`curl`.

```
tmx who billing                      list sessions on a box the caller may send to
tmx send billing "…"                 start a thread, prints its id
tmx send billing/review "…"          address one session
tmx wait <thread> [<thread> …]       block until a reply or question arrives
tmx inbox                            messages waiting for this session
tmx reply <thread> "…"               answer, or ask a question back
```

The sender names its own tmux session. The backend accepts a message only if its own state shows
an agent running in that session.

### 5.4 Addressing

The unit is the tmux session, which is already the unit of agent state: `box/session`. Split panes
in one session are one address. Replies go back to the exact session that sent the message.

A bare box name resolves to exactly one session. A message is never fanned out to every agent on
a box.

### 5.5 Policy

Stored on the box record, edited only by the operator's browser session.

- **Send switch + "may send to" list. Receive switch + "may receive from" list.** Both off by
  default.
- **Both sides must agree.** `orders → billing` needs `billing` in `orders`' send list and `orders`
  in `billing`'s receive list.
- **A switch that is on with an empty list means nobody.**
- **Replies and questions inside a thread are always allowed.** Starting a new thread the other
  way needs its own permission.
- **Checked at send time and again at delivery time.**
- **Stored by box id, shown by name.** Removing a box removes it from every list.
- **A "both directions" tick** when adding a name writes the matching entry on the other box in the
  same save.
- **Refusals are logged** and visible to the operator.

### 5.6 Delivery

The mailbox is passive, so each state of the target needs its own way of being woken.

| Target | Delivery | Status |
|---|---|---|
| No agent on the box | Start a headless worker with the message as its task; its final answer is posted as the reply | documented, untested here |
| Session working | Hand the message over when the current turn ends (Stop hook) | documented, untested here |
| Session idle | Wake it without the content passing through the terminal: `asyncRewake`, or a short typed nudge | unproven |
| Session blocked on a prompt | Hold. Nothing is typed into a permission dialog | — |
| Caller waiting on a reply | The held `wait` request returns | proven (held request) |

A message delivered into a running session inherits whatever that session has been allowed to do.
A sender can ask for a fresh worker explicitly, and a box can refuse delivery into existing
sessions.

### 5.7 What the operator sees

Threads, read-only, in the dashboard and the phone app. Refused attempts. Later: an Allow button
on a refusal, and the grid editor.

### 5.8 Guardrails

- A message from another agent is untrusted input. The skill frames it as a peer's request, never
  as the operator's instruction. Bodies are size-capped and control-stripped.
- A per-thread message budget, enforced by the backend, stops loops.
- Permission prompts are never answered by another agent.
- The hosted application is kept out by the socket's ownership and by the "agent running in that
  session" check. An application running as the same user as the agent cannot be told apart from
  it; that is what the send switch is for on internet-facing boxes.

## 6. Approaches considered

**How a message travels**

| Option | Verdict |
|---|---|
| Through Tmuxifier over its existing SSH connections | **Chosen.** Identity by connection, no secret on boxes, one place to gate and show |
| Box calls Tmuxifier over HTTP with a per-box token | Rejected. The app is on loopback behind a tunnel, so mail would leave the network; puts mail routes on the public listener and a secret on every box |
| Files on each box as the mailbox | Superseded by the operator's decision to keep the mailbox on the backend |
| Direct SSH between boxes | Rejected. A caller's key is a full shell on the target; nothing is visible centrally |
| A2A server on every box | Rejected. An HTTP server with mutual TLS per box; agents do not speak A2A natively |
| Claude's cloud messaging | Deferred. Goes through the vendor, Claude only, cannot be gated |

**How the agent asks**

| Option | Verdict |
|---|---|
| A command taught by a skill | **Chosen.** Works for every agent kind, testable by hand |
| An MCP server on each box | Rejected for now. Per-agent configuration; long waits collide with tool timeouts. Could wrap the command later |
| A2A client | Not possible as the agent-facing surface |

**How the receiving agent runs**

| Option | Verdict |
|---|---|
| Headless Claude per turn | In. Exact reply, permissions by flag, cannot join an open session |
| Delivery into a running interactive session | In. The operator's stated case; the session has the context |
| Typing the whole task into the terminal | Rejected. Content stays in the mailbox; at most a short nudge is typed |
| An Agent SDK daemon per box | Rejected. A service on every box, and unclear subscription terms |
| Channels | Watch. Research preview, needs a launch flag |

## 7. Calls made by Claude, not yet confirmed by the operator

Each of these was stated during the brainstorm without objection. Treat them as proposals.

- **Permission prompts** follow a per-box mode set in advance by the operator.
- **A bare box name** goes to the box's configured session if an agent is running there, otherwise
  to a fresh worker.
- **Two agents on the same box** may message each other when both of that box's switches are on.
- **The Host Shell** may send but receives only replies, never new threads. The agent there holds
  SSH to the whole fleet.
- **The phone app** shows threads read-only, like the dashboard.
- **The "both directions" tick** and logged refusals are in the first version; the Allow button
  comes with the grid.

## 8. Build order

Needed in every version: the mail store, the forwarded socket, the command and skill, the switches
and lists in the Edit Box modal, and a read-only thread list.

**Not yet chosen by the operator:** which delivery ships first.

- **A. Fresh workers first.** Does not touch the agent hook or anyone's terminal, so the risky
  parts wait until the plumbing is proven. Until the next version, a running agent that has the
  context never sees the message.
- **B. Running sessions first.** The operator's stated case. Changes the agent hook, which every
  state feature depends on.
- **C. Both at once.** Nothing missing on day one; everything validated live together.

Spike 1 tests both deliveries. Choose the order with its results.

After the first two versions: other agent kinds, the grid editor, the Allow button, the phone view.

## 9. Spikes

Spikes are throwaway. Their code is not kept; their findings are written up as a new dated
document beside this one.

**Done**

- **Socket over an existing SSH connection.** Works; see 5.2.
- **Fleet check.** Socket forwarding allowed and `curl` present wherever it could be read.

**Spike 1: delivery against a real Claude Code** (next)

1. *Headless round trip.* Task in, `.result` out; follow-up with `--resume`; open the same
   conversation interactively afterwards. What a turn returns when it needed a permission it did
   not have. Whether hooks fire in headless mode and what the `Stop` payload holds.
2. *Turn-end handover.* A `Stop` hook that returns `decision: "block"` with a waiting message:
   does Claude act on it, how does it appear, what stops a loop (`stop_hook_active`), and does the
   next `Stop` carry the answer to the delivered message.
3. *Waking an idle session.* Does an `asyncRewake` hook wake an idle Claude with the message and
   no typing. If not: a short typed nudge whose content arrives through `UserPromptSubmit`
   `additionalContext`. What the nudge does to an unsent draft in the input box.
4. *State markers.* Whether each delivery leaves the existing agent state (`working`, `blocked`,
   `done`) correct.

**Spike 2: the socket under real conditions**

- A held `wait` on a real ControlMaster: does it count against the SSH server's sessions-per-
  connection limit (10 on the fleet), alongside the watch stream.
- Re-forwarding after the master is reaped and replaced.
- Headless Claude started over a non-interactive SSH command on a seeded box: the token is
  exported from an rc file, which a non-interactive shell may not read.

## 10. Open questions for the operator

1. Build order: A, B or C (after spike 1).
2. Confirm or change each call in section 7.
3. Should a box be able to refuse delivery into existing sessions separately from the receive
   switch, or is `--fresh` on the sender's side enough.
4. What the per-thread message budget should be, and what happens when it is hit.

## 11. Where this touches the code

Indicative, for the design that follows.

- `store.js`: four new box fields; `boxRemoval.js` cleans other boxes' lists.
- `sshCommand.js` / `agentWatch.js`: the forward is added and repaired where the resident stream
  is managed, from the same `sync()`.
- A new backend module for the per-box listeners and the mail store; wired into
  `shutdown.js`'s flush.
- `setupManager.js`: a phase that installs the command and the skill, before the session is
  created.
- `claudeAgentHooks.js` and its asset: only if delivery into running sessions is built. The hook
  is load-bearing; `test/agentHooksReplay.test.js` is its acceptance test.
- `server.js`: read-only thread routes for the browser session; the box PATCH accepts the lists
  from a browser session only.
- `main.ts` (Edit Box modal) and a dashboard thread list.

Rules from `CLAUDE.md` that apply directly: box output is untrusted input; validate, never rewrite,
explicit names; real-time paths are triggers, never data; rc files before sessions; a running setup
job gates the box.
