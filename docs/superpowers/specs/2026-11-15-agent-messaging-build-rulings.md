# Agent messaging: rulings made during the build

**Date:** 2026-11-15
**Status:** record. The build of `feat/agent-messaging` was run task by task with an independent
review after each task. Where the plan, the design or a reviewer left something open, the
controlling session decided and carried on. This file lists every such decision, in the order it
was made, with what it costs if it was the wrong call. The operator did not make these decisions;
they are here to be checked and overturned.

Companion files: `2026-11-14-agent-messaging-design.md` (the approved design),
`2026-11-15-agent-messaging-build-notes.md` (where the build departs from the design, and the known
limitations), `../plans/2026-11-14-agent-messaging.md` (the plan).

Box names (`orders`, `billing`) are placeholders.

## Decisions for the operator to confirm first

These four change something the operator decided or approved.

1. **The wake text was changed from the approved design, twice.** A real Claude Code (Haiku)
   declined to act on the designed wording. The first message of a thread now says the operator
   turned messaging on and allowed that sender, and asks for an answer every time, even to decline;
   this was re-checked on a fresh session with no hint from an operator. Later, a reply was given
   its own wording (it continues an allowed thread, it is not new instructions, answer only if
   asked, never just acknowledge), because "always answer" on a reply invites two agents to
   acknowledge each other in a loop. **The reply wording has not been tried on a real Claude Code.**
   Cost if wrong: an agent declines a request it should handle, or ignores a reply it should use.
2. **The 1000-thread storage bound now also removes idle open threads.** The operator ruled out a
   message budget and a thread-rate cap, and neither was added. But one box could create threads
   without bound and exhaust memory and disk, because the design's 1000-thread bound was applied to
   closed threads only. Now, past 1000, closed threads go first, then open threads idle for more
   than an hour are closed (`storage limit`); if every thread is that recent, the new send is
   refused (`store-full`). Cost if wrong: an idle open thread is closed when a thousand newer ones
   exist.
3. **With two box records for one machine, the earlier-created record wins.** When two enabled
   boxes resolve to the same ssh connection, only the first one in the box list may message; the
   other is refused (`shares a connection with <label>`). It does not matter which was enabled
   first. Cost if wrong: the operator has to disable the earlier record to use the later one.
4. **Mail-driven behaviour the design left to a call** (design section 10, already listed there)
   was built as designed: a busy or blocked session is not interrupted; same-box messaging needs
   both of that box's switches; setup adds a permission rule for `tmx`; a thread has a Stop
   control; the Host Shell is left out.

## Process

5. The worktree is at `.claude/worktrees/agent-messaging`, where this repository keeps its
   worktrees, not beside the checkout as the plan said. Cost: none.
6. Task 0 (worktree and committing the documents) was done by the controller.
7. Task 18, the live walk, was not started: it needs the operator, two real boxes and a restart of
   the live service.
8. Task 13 ran a real Claude Code under the spike rules (private tmux server, scratch project with
   its own settings, smallest model, cleanup verified by the controller). It used the operator's
   subscription: about 17 short Haiku turns, then 4 more for a re-check.
9. Commits by implementer agents carry the attribution of the model that wrote them.
10. For one re-review of the waiter lock, the reviewer was told to grade any further race by its
    consequence: important if a message could be lost or misdelivered or a pane left permanently
    without a waiter, minor if the worst case was no waiter until that session's next turn ends.
    Three rounds had each found a race of the minor kind. The whole-branch review read the same
    code without that instruction. Cost if wrong: a rare delayed delivery after a Claude Code
    crash.

## Behaviour

11. A refusal for an unreachable target names the target box (the first wording described the mail
    service). Cost: one string.
12. A dropped message is shown to its recipient as `[not delivered]`, never with its body; the
    sender still sees their own text. Cost: none known.
13. A caller with a malformed session name is refused without an entry in the refusal log, and
    `read` and `inbox` re-check the thread's permission. Cost: a malformed call leaves no trace.
14. Request parameters travel as form fields, not in the URL as the design's table sketched,
    because box names with spaces and message bodies need `curl --data-urlencode`. Cost: none.
15. `tmx send` and `tmx reply` are retried only when the request provably did not reach the server.
    After a dropped connection they stop with a "may or may not have been sent" warning. Cost: an
    agent resends by hand after a dropped connection.
16. A newer waiter on the same pane replaces the older one at the hub. Cost: none known.
17. Stray shell diagnostics cannot land in front of the wake text (the waiter writes the wake to a
    saved descriptor). Cost: none.
18. The prompt hook confirms at most 16 message ids per prompt. Cost: none in practice.
19. The forward's repair runs an extra `-O cancel` between removing the box-side socket file and
    `-O forward`: a plan defect, since re-issuing a forward a master already holds does nothing.
    Cost: one extra local ssh call per repair.
20. Two box records that reach one machine by different addresses overwrite each other's socket.
    Not fixed in this version; the guide says to turn messaging on for only one. Cost: misapplied
    policy for a machine deliberately added twice.
21. A policy save that lands while a forward sync is running waits for the next status sweep.
    Cost: up to about 30 seconds before the socket comes up.
22. With `TMUXIFIER_AGENT_MAIL=off` the setup phase installs nothing on boxes (the design called
    the install inert). Cost: turning messaging on later needs a setup rerun.
23. The waiter follows its Claude Code process, not `$PPID`: Claude Code runs hooks through a
    wrapper shell that lives as long as the hook. A waiter of a newer Claude Code in the pane takes
    the lock over. Cost: none known.
24. Where `/bin/sh` is bash there is no wrapper shell, so the waiter treats `$PPID` itself as
    Claude Code in that case. Cost: none known.
25. A woken turn's `Stop` can still write over a subagent's block (design 6.8, call 16). Left as
    designed.
26. A waiter removes a lock only when it owns it; a Claude Code nested under the lock owner's
    stands down; a waiter whose lock directory is deleted by a dying predecessor reclaims it; an
    orphaned waiter never reclaims. `tmx inbox` items carry the same framing as the wake. The
    published fixture's README points at nothing outside the repository.
27. The "is messaging enabled" flag is read after every sign-in path, not only at page load: a
    plan defect that would have hidden the section and the Messages button until a reload.
28. The "also write the matching entry" tick is sent and applied per list, not per box. Cost: one
    more shape to keep in step between the web client, the route and the store.
29. The operator sees `waiting` where agents see `queued`. Cost: wording only.
30. The drawer's markup exists in the page while messaging is off; it is never opened and its
    button is absent.
31. Two box records on one ssh connection: first a pid-keyed claim, then "the holder keeps its
    claim through failures", were tried and each leaked under a master replacement or a retry
    hold-off. Replaced by ruling 3 (a stateless rule).
32. A box whose ssh connection cannot be resolved (`ssh -G`) does nothing for mail in that sync,
    and no box starts a new forward until every enabled box is resolved. This reversed an earlier
    call that such a box stands alone. Cost: one sweep's delay when the local lookup hiccups; one
    box whose lookup keeps failing blocks new forwards fleet-wide, and each waiting box names it.
33. A box re-addressed to a connection that cannot be resolved stops answering at once.
34. After any re-address the listener is closed, the local socket path is derived from the box id
    and its connection fields, and the box edit triggers a sync. Cost: a re-address briefly drops
    that box's waiters, which re-arm.
35. The tools line follows the setup phase and the periodic recheck, and never reads "not
    installed" while a session is listening.
36. `tmx wait` describes the caller's own newest message, and says `nothing new since the last
    reply` when the caller already has the reply.
37. A box with send off is refused before the target is looked up, so it cannot learn which box
    names exist. A removed box gets no remote command. `tmx` says when messaging is not turned on
    for the box. A closed thread tells the agent not to start a new one and to tell its operator.

## Left open on purpose

Each of these was found in review, judged not to block the live walk, and recorded.

38. After a re-address whose one cancel fails on a live ssh connection, the moved box (or the
    sibling that then holds the old shared connection) reads `not verified` until Tmuxifier
    restarts or that connection drops. It fails closed. Cost: a restart to recover.
39. A `tmx` command that lands in the few tens of milliseconds while the socket is being replaced
    is told messaging is not turned on, with no retry.
40. The forward keeper's header says a box edit takes effect "at once"; a kick during a running
    sync waits for the next sweep. Wording only.
41. A peer that never replied and runs `tmx wait` reads `nothing new since the last reply`.
42. A thread removed by the storage bound answers later posts with "not part of that thread".
43. Socket files at old paths can accumulate under `data/mail/` after a crash.
44. A stale tools reading can show "not installed" until the next recheck, under unusual timing.
45. The waiter lock has three narrow races whose worst case is a pane without a waiter until that
    session's next turn ends (build notes, known limitations).
46. The messaging switch is saved through the Edit Box modal, which also saves the box and reruns
    setup; a failure in those earlier steps blocks turning a switch off. Stop on a thread is the
    fast brake.

## Found outside this feature, not changed

47. Saving the Edit Box modal writes `user: root` onto a box that had no user set
    (`src/web/main.ts`, the user field's displayed default and the save). It predates this branch;
    a save that only changes messaging settings triggers it too.
48. `docs/privacy.md` is also the Android app's privacy policy; its "Last updated" date was changed
    for the new section.
49. End-to-end runs leave their fixture ssh masters running after the test server is stopped.
50. `src/web/api.ts` and `src/web/setupStatus.ts` do not know the `osc-reporter` setup phase, and
    `docs/boxes-and-setup.md` still says "five" agent-hook entries.
