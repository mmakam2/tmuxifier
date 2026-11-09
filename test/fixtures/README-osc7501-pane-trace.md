# osc7501-pane-trace.jsonl

A recording of the **raw output stream of tmux panes** running coding agents, as `tmux pipe-pane`
delivers it to a box-side listener, captured on 2026-11-08 on a Debian 13 LXC with **tmux 3.5a**.
One JSON object per line: `{"ts", "pane", "b64"}` is one `read()` chunk of pane output (base64 of
the exact bytes, `ts` = wall clock seconds), `{"ts", "mark"}` is a scenario marker appended by the
driving script between `send-keys` steps. The recorder was
`tmux pipe-pane -t %N 'python3 recorder.py <file> <pane>'` (one `os.read(0, 65536)` per line);
agents were driven with `send-keys`. Sequences of interest are `ESC ] 7501 ; <body> ST` (OSC 7501
"Program Status", spec revision 0.4). No sequence was split across two chunks in this recording,
but a listener must still buffer across reads.

Agents: **OpenCode 2.2.6** (free "Big Pickle" model, so turns are real but non-deterministic),
**pi 1.5.0** (`@earendil-works/pi-coding-agent`, no model configured), **Claude Code 2.1.319**
(seeded login, one real turn). Codex 0.167.0 is **not** in the trace: it sat at its sign-in screen
on the box and emitted nothing there; its binary does contain `]7501;state=`, `:app=codex` and
`]7501;state=clear`, so record it once the box is re-seeded.

Lines 1491-2321 were appended on 2026-11-09 from the same box: **Antigravity CLI 1.5.3** (`agy`,
signed in, model "Gemini 4 Argon", so turns are real), recorded the same way in a private tmux
server (`tmux -L`), three panes: `agy` (the walk), `agyauth` (an empty `HOME`, so not signed in)
and `agyplain` (no `AGY_CLI_OSC7501`). The last two overlap in time, so their chunks interleave
from line 2272 on.

Scrubbed: the box hostname in the zsh prompt -> `box01`; in the agy lines also the account email
in agy's banner -> `you@example.com` and the conversation id in its exit hint -> a zero UUID.
Session ids, titles (`msg`/`title` are base64 UTF-8 per the spec) and timestamps are the real ones.

| Scenario | Lines | OSC 7501 seen (body after `ESC ] 7501 ;`, all `ST`-terminated unless noted) |
|---|---|---|
| (a) OpenCode TUI starts in a directory whose `opencode.json` has `permission.bash = "ask"`. The **shared `opencode serve` of the user still held a pending permission from an earlier, killed TUI** | 1-106 | probe `?` (33); `state=idle:app=opencode` (41); then the *other* session's records: `state=working:app=opencode:title=…` + `state=working:id=ses_e4313d…:app=opencode:title=…` (43-44), `state=blocked:kind=permission:app=opencode:title=…:msg=…` + the same with `id=ses_e4313d…` (64, msg "Permission needs input") |
| (b) plain prompt, no tools | 107-160 | `state=working:id=ses_e430fd…:app=opencode:title=…` (109, 112: title changes as OpenCode names the session); `state=clear:id=ses_e430fd…` (138). **No root record is re-emitted**: the root stays `blocked` from (a) |
| (c) bash prompt -> permission asked | 161-438 | `working:id=…` (163); root `state=blocked:kind=permission:app=opencode:msg=` "2 sessions need input" (241) + `state=blocked:id=ses_e430fd…:kind=permission:…:msg=` "Permission needs input" (242) |
| (d) **Allow once** (Enter) | 439-511 | root `blocked` again for the other session, msg "Permission needs input" (440); own `working:id=…` (441); `clear:id=…` (486) |
| (e) bash prompt -> permission asked again | 512-771 | `working:id=…` (514); root `blocked` "2 sessions need input" + `blocked:id=…` (557) |
| (f) **Reject** (Right, Right, Enter) | 772-803 | root `blocked` (774, 1 session pending); own `working:id=…` (775); `clear:id=…` (778). A reject ends the turn like a success |
| (g) `/exit` | 804-816 | `state=clear` with **no id** (806): the TUI removes every record on exit |
| (h) `PI_PROGRAM_STATUS=1 pi` (no model) | 817-860 | **no probe**; `state=idle:app=pi` (853) |
| (i) pi, ctrl-c twice | 861-863 | nothing (pi did not exit on ctrl-c either; killed with the session) |
| (j) plain `pi` | 864-886 | probe `?` only (876) — tmux never answers, pi stays silent |
| (k) `claude` 2.1.319: trust prompt accepted, one real turn, `/exit` | 887-928 | probe `?` **BEL-terminated**, immediately followed by DA1 `CSI c` (894). Nothing else for the whole turn: Claude's debug log says `programStatus=no (probe: no reply to OSC 7501)`. An in-pane responder (`pipe-pane -IO`) that answered the probe did not change this — tmux's own DA1 reply arrives first |
| (l) OpenCode, **fresh shared server** (killed first), TUI in `~`, no `opencode.json` | 929-976 | probe (954); `state=idle:app=opencode` (963) |
| (m) plain prompt | 977-1034 | root `state=working:app=opencode:title=…` **and** `state=working:id=ses_e430ab…:…` in the same chunk (980, again 984); `clear:id=…` (1012) then root `state=idle:app=opencode` (1013): the clean turn-end shape |
| (n) bash prompt, auto-allowed | 1035-1132 | `working` root+id (1037-1038); `clear:id` (1107); root `idle` (1108). No `blocked` |
| (o) long prompt, Escape after 3 s | 1133-1474 | `working` root+id (1135-1136); ~300 chunks of streamed text; `clear:id` (1447); root `idle` (1448). Whether Escape cut the turn short or it finished on its own is not distinguishable in the stream |
| (p) `/exit` | 1475-1490 | `state=clear` (1477) |
| (q) `AGY_CLI_OSC7501=on agy` in a new directory: the folder-trust prompt | 1491-1525 | **no probe**; `state=blocked:kind=permission:app=antigravity:msg=` "Trust this folder?" (1516). Every agy record is a root record (no `id`) and **BEL-terminated** |
| (r) trust accepted (Enter) | 1526-1532 | `state=idle:app=antigravity` (1527) |
| (s) plain prompt, no tools | 1533-1601 | `state=working:app=antigravity` (1538); `state=done:app=antigravity:msg=` "pong" (1590): `msg` is the reply text |
| (t) shell-command prompt -> permission asked | 1602-1682 | `idle` on the first keystroke after a `done` (1603); `working` (1607); `state=blocked:kind=permission:app=antigravity:msg=` "Approve RunCommand: touch rec-probe.txt" (1670) |
| (u) **Yes, run command** (Enter) | 1683-1757 | `working` (1684); `done` (1751) |
| (v) shell-command prompt -> permission asked again | 1758-1853 | `idle` (1760); `working` (1763); `blocked:kind=permission` (1843) |
| (w) **No, cancel** (Down x3, Enter) | 1854-1870 | `idle` (1859), with no `working` or `done` in between: a decline ends the turn |
| (x) prompt that makes agy ask the user a question | 1871-1972 | `working` (1878); `state=blocked:kind=question:app=antigravity:msg=` "Please pick a color:" (1962) |
| (y) answer picked (Down, Enter) | 1973-2186 | `working` (1976); the turn was still running when (z) was marked |
| (z) `/exit` | 2187-2203 | the turn's `done`, msg "blue" (2196); then `idle` twice (2198, 2199). **No `state=clear`**: agy's last word on exit is `idle` |
| (aa) `AGY_CLI_OSC7501=on agy` with an empty `HOME` (pane `agyauth`, from 2204): the "Select login method" menu | 2208-2270 | `state=blocked:kind=auth:app=antigravity:msg=` "Sign in required" (2263) |
| (ab) ctrl-c at the sign-in menu | 2271-2278 | nothing (agy asks for a second ctrl-c) |
| (ac) plain `agy`, signed in, then `/exit` (pane `agyplain`, from 2274) | 2279-2309 | probe `?` only, BEL-terminated, followed by an OSC 11 query (2283). Like Claude and unforced pi, agy stays silent inside tmux without the variable |
| (ad) second ctrl-c in the sign-in pane (`agyauth`) | 2310-2321 | `state=idle:app=antigravity` (2312), again no `clear` |

Notes
- **tmux behavior (3.5a).** `pipe-pane` receives the pane's raw bytes before tmux's parser, so OSC
  7501 arrives intact with either terminator (OpenCode and pi use `ESC \`, Claude's probe uses
  `BEL`). tmux's parser itself drops the sequence (`input_exit_osc: unknown '7501'`) and never
  forwards it to the outer terminal, and it answers `CSI c` (DA1) itself. Programs that use the
  spec's feature-detection trick (`OSC 7501 ; ?` then DA1; supported only if the 7501 reply
  arrives before the DA1 reply) therefore conclude "unsupported" inside tmux: Claude Code and
  unforced pi report nothing. Programs that report without probing (OpenCode, pi with
  `PI_PROGRAM_STATUS=1`, Codex per tmux/tmux#5713) are fully visible to the listener.
- **OpenCode's record model.** A **root record** (no `id`) plus one **child record per OpenCode
  session** (`id=ses_…`). Both are re-sent at each change; a turn end is `clear:id=<ses>` followed by
  root `idle` *only when no other session needs input*. The root record aggregates **every session
  of the user's shared `opencode serve`**, not just this pane's TUI: in (a)-(f) the root stayed
  `blocked` for a session that belonged to a dead pane, with `msg` "2 sessions need input". A
  listener cannot tell from the stream which child id is "this pane's" session (the TUI's own
  session exists only after its first prompt).
- OpenCode and pi (lines 1-1490): `kind=permission` is the only `blocked` kind; `title` is
  OpenCode's session title, `msg` is "Permission needs input" / "N sessions need input"; neither
  emitted `done`. No agent in the trace emitted `error` or `progress`.
- `/exit` emits a bare `state=clear` in OpenCode. Process death without `/exit` (session killed)
  emits nothing.
- **agy's record model.** One root record, no `id`, no `title`, always `app=antigravity`, BEL
  terminator. `AGY_CLI_OSC7501=on` skips the probe entirely (the variable is documented in the
  binary's own release note: `off|on`, "on" for a terminal that supports the sequence but does not
  answer the check). A turn is `working` -> `done` (`msg` = the reply, so the stream carries model
  output), and the `done` turns into `idle` at the operator's next keystroke. All three `blocked`
  kinds of the spec occur: `permission` (folder trust, tool approval), `question` and `auth` (the
  sign-in menu, which waits for the operator to pick a login method). agy never sends `clear`:
  leaving it, by `/exit` or ctrl-c, ends on `idle`, so a listener learns that the agent is gone
  only from the pane's command. The start-up records (trust prompt at line 1516, sign-in at 2263)
  arrive about 0.15 s after launch (the recorder here was piped before agy started), so a listener
  that attaches by the pane's command usually misses them.

Replayed by `test/osc7501Replay.test.js`, the acceptance test for the box-side reporter.
