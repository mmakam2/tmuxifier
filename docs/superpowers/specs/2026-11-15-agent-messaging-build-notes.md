# Agent messaging: build notes for the first version

**Date:** 2026-11-15
**Status:** record of the build on branch `feat/agent-messaging`, written when the documentation
was added. Point-in-time: it is not updated as the code moves on.
**Design:** `2026-11-14-agent-messaging-design.md`. Read this beside it: every item below is a
place where the design no longer describes the code. Section numbers in brackets are the
design's. The operator guide is `docs/agent-messaging.md`; the module map is in `CLAUDE.md`.

Box names (`orders`, `billing`) are placeholders.

## Where the build departs from the design

1. **Wake text [6.7].** A real Claude Code (Haiku 5.5) declined to act on the designed wording:
   told only that the request was "not from your operator", it said the operator had not asked
   it to message other agents (`test/fixtures/README-claude-mail-wake-trace.md`, lines 2-4 of
   the recording). The wake now says that the operator turned on agent messaging for this box and
   allowed that sender, so the agent handles it without waiting to be asked; that it comes from
   another coding agent and not from the operator; and to always answer with `tmx reply`, even
   only to decline or ask a question. `tmx inbox` items carry the same lines without the
   `[tmuxifier-mail m-…]` tag (the tag marks a wake, which the prompt hook confirms). The new
   wording was checked live on a fresh session: a question was answered, a harmless task was done
   and a destructive request was declined, each with `tmx reply`. All wording is in
   `src/server/agentMailText.js`.

2. **Wire format [6.5].** The design's table puts POST parameters in the query string. As built,
   GET parameters are in the query string and every POST parameter (`session`, `to`, `body`, `m`)
   is an `application/x-www-form-urlencoded` field; a query string on a POST is refused. Every
   request carries `session`. `GET /v1/replies` always answers 200; when no reply came it sets
   `X-Mail: none` and the body is the status lines. `POST /v1/ack` answers 404 for a message it
   could not confirm. The authoritative table is the header of `src/server/agentMailListener.js`.

3. **Policy mirror [6.11, 6.12].** The "also write the matching entry on that box" tick is
   recorded per list entry, at the moment the box is added to that list, and the `PUT
   /api/boxes/:id/mail` body carries it per list: `mirror: { sendTo: [...], receiveFrom: [...] }`.
   A box added with the tick off is never mirrored, even when the same box sits ticked in the
   other list. The design's "ids whose counterpart entry to write" was one set per box.

4. **Forward repair [6.4].** The ensure is: remote `mkdir` + `rm -f` of the box-side socket +
   print `$HOME`; then `-O cancel`; then `-O forward`; then the nonce call. The cancel the design
   does not name is needed because `-O forward` on a master that already holds the forward exits 0
   and does nothing, and after the `rm` under it the forward stays broken until a cancel (the
   state after a Tmuxifier restart over a surviving master, or a recheck that found it broken).
   The failure back-off is 30 s doubling to 30 min; the recheck is every 10 minutes when the
   listener has seen no request.

5. **Two box records on one SSH connection [not in the design].** Two box entries for one
   machine whose ssh names resolve to the same ControlPath share one master, and a second `-O
   forward` onto the same box path is accepted but never used. Boxes are therefore grouped by
   their ControlPath, resolved locally with `ssh -G`. The first enabled box of a group in the box
   list holds it; every other enabled box of the group is refused (`shares a connection with
   <label>`) and runs no ssh command for mail. A box whose ControlPath does not resolve runs
   nothing (`connection not resolved`), and while any enabled box is unresolved no box starts a
   new forward (`waiting for <label>'s connection to resolve`); a box with a verified forward
   keeps its checks. The rules are in the header of `src/server/agentMailForward.js`.

6. **The waiter [6.7].** The design's waiter takes a per-pane lock and otherwise loops. As built
   it follows its Claude Code process, not `$PPID`: Claude Code runs a hook through `/bin/sh -c`,
   which under dash does not exec, so `$PPID` is a wrapper that outlives a Claude Code killed with
   `SIGKILL`. The lock records the waiter's pid and its Claude Code's pid. A waiter under a newer
   live Claude Code in the pane takes the lock over; one whose Claude Code runs under the owner's
   (a `claude -p` from the owner's Bash tool) stands down; a waiter that loses its new lock
   directory to a dying predecessor's cleanup claims it again. Every decision goes through one
   table, written above `lock_decide` in `src/server/assets/tmuxifier-mail.sh`. At the hub, a new
   waiter of a pane ends the older ones of that pane, and only the newest is ever handed mail.

7. **Dropped bodies.** The design does not say what a recipient sees of a message dropped before
   delivery. `tmx read` shows its body to the recipient as `[not delivered]`; the sender still
   sees its own words. The operator's drawer shows the body with the state `dropped`.

8. **`unreachable` [6.5].** A send to a box Tmuxifier cannot reach is refused and logged with
   `<target> is unreachable right now; try again shortly`, naming the target as typed. The
   script's own failure is a separate text, `tmx: mail service unreachable, try again shortly`.

9. **Messaging off [6.10].** The design said everything installed is inert until a switch is on,
   and that `TMUXIFIER_AGENT_MAIL=off` removes listeners, forwards and routes and hides the UI.
   As built, off also skips the `agent-mail` setup phase entirely (it is left unwired), so a box
   set up while messaging is off gets nothing installed.

10. **Storage [6.3].** As designed: one file per thread under `data/agent-mail/` plus
    `refusals.json`. Two details the design does not state: pruning (30 days idle, then the
    longest-idle closed threads above 1000) runs once a day, starting a day after boot, not at
    boot; and above 1000 threads only closed threads are deleted, never open ones.

11. **`send` and `reply` are never retried [6.6].** The design says `tmx` retries for a few
    seconds when the socket is unreachable. As built, every command retries up to 5 times, 1 s
    apart, only while the request provably never reached the hub (no connection, or a 503), and
    a read also on a connection closed without an answer. A send or reply that failed after connecting is not retried: `tmx` exits 3 with "the message
    may or may not have been sent; do not send it again without checking".

12. **`tmx wait` is capped [6.6].** The hub clamps a reply wait to between 1 and 540 seconds,
    whatever `-t` says.

13. **Targets [6.5].** Besides `<box>` and `<box>/<session>`, `.` and `./<session>` name the
    caller's own box. A label containing `/` is matched whole first.

14. **The permission rule [6.10, 11].** It is `Bash(tmx *)`. Checked on Claude Code 2.1.325 in
    manual permission mode: the quoted-argument form, a heredoc and a pipe (`printf … | tmx
    reply …`) of `tmx reply` all ran without a prompt (`test/fixtures/README-claude-mail-wake-trace.md`).

## Known limitations

- **Receivers must be Claude Code.** Mail for a session running another agent is queued and the
  sender is told the target is not listening (as designed, 10.15).
- **The Host Shell** neither sends nor receives (as designed).
- **A busy or blocked session is not interrupted;** mail waits (as designed).
- **One machine added as two boxes.** On one SSH connection, only the first enabled record can
  message (item 5). Reached by different addresses, the two records each remove the box-side
  socket file before forwarding their own, so they take the one socket from each other; turn
  messaging on for only one of them. This follows from the ensure command; it was not tested.
- **A session can be without a waiter** until its next turn ends. The notes kept at the end of
  the build name two cases, after a Claude Code crash and around a `claude -p` nested inside an
  agent's turn; the lock table in `tmuxifier-mail.sh` does not show the mechanism for either, so
  they are recorded here as reported, not reproduced. Mail is never lost: it stays queued, the
  sender reads "not listening", `tmx inbox` reads it, and the session's next `Stop` arms a new
  waiter.
- **A mail-started turn that ends while a subagent's permission dialog is open** reads as
  working, not blocked, until the dialog is answered (design 6.8; recorded as scenario (c) of
  `test/fixtures/claude-mail-wake-trace.jsonl`, line 50, which the replay leaves unpinned).
- **Mail-started turns notify** like any other turn (as designed).
- **The wake is cut at 4000 characters** with a line pointing to `tmx read`. Recorded wakes of
  about 4400 characters arrived byte for byte; nothing larger was tried, so Claude Code's own
  limit, if any, is unknown.
- **After a switch is turned on** the forward is attempted at once (`kick` after the policy
  save), but a sync already running skips it, so the socket can take until the next status sweep.
- **The Edit Box status line can say `Tools not installed`** when they are. Whether `tmx` is on
  the box is read only by the ensure command, so a switch turned on in the same Edit-dialog save
  whose setup run installs the tools is recorded as not installed, and stays so until the next
  ensure (a new master, a failed recheck, a restart). Found while writing the documentation; the
  operator guide tells the operator to set the boxes up before turning a switch on.
- **Not yet verified live:** a waiter left idle for hours (31 minutes is the longest observed),
  and a wake while a plan-approval dialog is open.
- **Message bodies are stored in plaintext** under `data/agent-mail/` (`0600`), as designed.
- **The permission rule allows whatever `tmx` resolves to on `PATH`;** the installer refuses only
  a `~/.local/bin/tmx` that is not its own symlink.
- **The Edit Box Claude Code hint is unchanged:** the setup form's text under the tools
  checklist still names only the statusline and the agent-state hooks, not messaging.

## Final review fix wave

Added 2026-11-15, after the whole-branch review of `feat/agent-messaging`. The review found no
critical defect; this section records what its fix wave changed. Where an item or a limitation
above no longer describes the code, it is named here and the text above is left as it was.

1. **A re-addressed box [6.4; item 5 above].** A box whose host, user, port or jump host changed
   kept its listener, so a request held through the old machine stayed registered as that box and
   was handed its mail; and the old master could keep a forward entry that led to the path the
   listener reopened at. Now the first thing a mail sync does for such a box, whether or not its
   new fields resolve, is close its listener (every connection made through the old machine is
   destroyed, every held request ends), and the local socket is named from the box id **and** its
   connection fields, so an entry left on an old master names a path nothing binds. `PATCH
   /api/boxes/:id` kicks a sync when a connection field changed. What it costs: an entry that
   survives under the old fields on a master the new fields also resolve to (a re-address between
   two ssh names of one connection whose single cancel failed, or one made while Tmuxifier was
   down over a surviving master) stays first on that master, and the box reads `not verified`
   until that master exits. It fails closed.
2. **A removed box.** Its teardown closes the listener and cancels the forward on the local
   master; the remote `rm`, which opened an ssh connection to the machine just removed, is no
   longer run for it. A box that is turned off but still listed is torn down as before, except
   that its listener is closed before the ssh calls rather than after.
3. **Wake text for a reply [6.7; supersedes part of item 1 above].** `wakeText` and `renderInbox`
   word a message by its kind. The first message of a thread reads as item 1 describes. Every
   later one reads `Reply from the agent in <box/session>, thread <id>.`, then that it continues
   a thread the operator's messaging settings allowed and comes from another coding agent, to be
   used for the work that thread is about and not treated as new instructions, then to answer
   only if it asks something or something is still needed, and not just to acknowledge. Two
   reasons: the first-message line "your operator … allowed that agent to message you" is not
   true toward a thread's starter (a reply rests on no setting of the starter's receive side),
   and "always answer" on a reply invites two agents to acknowledge each other without end. The
   `[tmuxifier-mail m-…]` tag is unchanged, so the hooks and the recorded trace are unaffected.
   The skill carries the same rule in its own words. **This reply wording has not been tried on
   a real Claude Code:** see D2 below.
4. **Storage [6.3; supersedes item 10 above].** The 1000-thread bound is enforced for real, since
   every thread is held in memory and read at boot. Above it, the longest-idle closed threads are
   deleted, then the longest-idle open ones, each closed with the new reason `storage limit`
   through the hub's one close path (a `tmx wait` on it ends with `closed: storage limit`) and
   deleted. An open thread with activity in the last hour is never removed. Pruning runs when
   the hub is created (boot), daily, and before every new thread that would pass the bound; a
   send that finds no room even so is refused with the new code `store-full` and logged. See D1.
5. **The tools line [supersedes the "Tools not installed" limitation above].** `installed` is no
   longer read only by the ensure: the forward keeper is told when this server's `agent-mail`
   setup phase reports `ok` (`markInstalled`), the verify command prints the tools line too, so
   a recheck sees tools installed or removed since, and the status never reports the tools
   missing while a session of the box is listening.
6. **`tmx wait`'s status lines [6.6].** A line is about the newest message the caller sent. When
   the thread's newest message is the other side's and the caller has it (delivered, or handed to
   its waiter), the line reads `nothing new since the last reply` instead of `delivered N s ago,
   no reply yet` about a message that was answered. The browser's thread list still describes the
   thread's newest message.
7. **Refusals.** `send` checks the caller's own send switch before it resolves the target, so a
   box with send off cannot tell an unknown box name from a refused one. The closed-thread
   refusal, and for an agent the `closed by the operator` line of `tmx wait`, tell the agent not
   to start a new thread for the same matter and to tell its operator; the phrase the drawer
   shows stays `closed by the operator`.
8. **`tmx` with no socket [supersedes part of item 8 above].** With no socket file at all, a user
   command says `tmx: agent messaging is not turned on for this box; tell your operator` at once
   (exit 3, no retry). A socket file that is there and does not answer keeps `tmx: mail service
   unreachable, try again shortly` and its retries. `hook-wait` is unchanged. The ensure removes
   the box-side file and forwards it again a moment later; a user command that connects in that
   moment gets the first message although messaging is on.
9. **Smaller ones.** The listener's 413 answer names the 65536-byte message limit, not the wire
   limit. On box removal the policy write and the closing of the box's threads each have their
   own `try`. The setup form's Claude Code hint names what it installs for messaging (the last
   limitation above no longer holds).
10. **A limitation not listed above.** Two Claude Code sessions in one tmux session share one
    address (`box/session`), so a message, or the reply to a thread one of them started, can wake
    either.

### Decisions for the operator to confirm

- **D1. The storage bound closes idle open threads.** The operator's decision was "no message
  budget and no cap on how many threads a pair may start". That stands: no rate limit was added,
  and a normal exchange meets no limit. What is new is that the design's own storage bound of
  1000 threads (6.3), which the build applied to closed threads only, now also removes open
  threads idle for more than an hour, after the closed ones, and that a flood past the bound
  (1000 threads all active within the hour) is refused as `store-full` until one has aged. A
  legitimate sender is refused during such a flood too. This is the operator's to confirm.
- **D2. The reply wording is untested on a real agent.** Item 3's wording for a reply delivered
  by wake was written from the review's finding and pinned by unit tests only. The live walk has
  to include: a sender that stopped waiting (its `tmx wait` timed out and it ended its turn) is
  woken by the reply. Does it use the reply for its task, and does either agent send a bare
  acknowledgement back?
