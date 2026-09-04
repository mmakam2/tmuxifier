# Claude Code voice: browser mic link — design

Date: 2026-09-04. Status: approved design, pre-implementation.

## Summary

Claude Code (v2.1.69+) has a built-in voice mode: hold or tap Space, speak, and the
transcript lands in the prompt. Its documentation says it does not work over SSH or on a
headless machine. The real constraint is narrower: on Linux it reads the **system default
microphone**, and a headless box has none. This feature gives every box that runs Claude Code
a default microphone that is the operator's browser mic, streamed through Tmuxifier.

The pane header's one 🎤 button keeps a single meaning, "my voice goes here", and the pane
decides how. On a pane where Claude Code is open, a tap **links** the browser mic to the box
and the operator uses Claude's own voice mode (hold Space) with Anthropic's transcription. On
any other pane, the button keeps today's behaviour: hold to dictate through local whisper.cpp,
which types the transcript into the pane.

## Facts established by the probe (2026-09-04, Claude Code 2.1.260)

Verified on the Tmuxifier host itself, an Ubuntu 25.04 LXC on Proxmox with no `/dev/snd`:
Claude Code's voice mode transcribed an 11 s speech sample fed through a FIFO, word for word,
and auto-submitted it (tap mode).

From the embedded source of the Linux voice module:

- The only remote gate is the `CLAUDE_CODE_REMOTE` environment variable. The `pg()` "remote
  session" predicate is compiled to `return false` in this build. Nothing inspects SSH.
- Capture order on Linux: (1) a native module (cpal over a dlopen'd `libasound.so.2`, opening
  ALSA `default`), attempted only when `/proc/asound/cards` lists a card; (2) `arecord -f
  S16_LE -r 16000 -c 1 -t raw -q -`, probed first with the same flags against `/dev/null`
  and considered usable when it exits 0 or is still alive after 150 ms; (3) SoX `rec … -r
  16000 -e signed -b 16 -c 1 -` with silence detection `silence 1 0.1 3% 1 2.0 3%`.
- **An LXC mirrors the Proxmox host's `/proc/asound/cards`** (this host shows the PVE host's
  USB audio device) while having no `/dev/snd`, so the native path is what runs on this
  fleet, and it fails loudly (alsa-lib error spew into the TUI) unless `default` resolves.
- The native module negotiates **mono, 48 000 Hz, 32-bit** with whatever device it opens. It
  does not ask for 16 kHz S16 the way the fallbacks do. Feeding 16 kHz S16 straight into a
  device it opened produced "No speech detected".
- Voice needs a Claude.ai login (not an API key) and can be disabled by org policy.
- `~/.cache/coder-audio/{port,token}` and `activeForwardedSocket` exist in the bundle but are
  unused fields. There is no official audio-forwarding hook.

The user-level ALSA configuration that made it work, needing no packages beyond alsa-lib, no
daemon, and no kernel module:

```
# tmuxifier-voice-link
pcm.tmuxifier_mic {
  type file
  slave.pcm "null"
  file "/dev/null"
  infile "/home/<user>/.tmuxifier-voice/mic"
  format "raw"
}
pcm.!default {
  type plug
  slave { pcm "tmuxifier_mic" format S16_LE rate 16000 channels 1 }
}
```

The `plug` layer converts whatever the application requests (48 kHz 32-bit from the native
module, 16 kHz S16 from `arecord`) to one fixed pipe contract, 16 kHz S16 mono, which is
exactly what the browser side of Tmuxifier's dictation already produces. The `file` plugin
substitutes what it can read from `infile` into each transfer and pads the rest with the
`null` slave's silence.

FIFO semantics that shaped the design (the first of them is also what forced the idle-device
symlink — see "The idle capture device is `/dev/zero`" below): `open(O_RDONLY)` blocks until
a writer exists; a read on an empty FIFO blocks (Claude's stop hung until bytes flowed); a
short read is padded with silence, so the feed is not rate-locked to the reader. And once the
last writer closes, reads do **not** pad with silence: alsa-lib's file plugin returns stale
buffer contents immediately, in a tight loop (measured: two million reads in three seconds).
The writer must therefore stay open and keep feeding for the whole linked period, never let
stale audio pile up, and never hand a mid-recording reader a bare EOF.

## Goals

- A Claude Code pane hears the browser mic through Claude's own voice mode, with Anthropic's
  transcription, on any box the setup job has prepared, and on Host Shell.
- One button. Claude pane: tap to link, tap to unlink, hold Space in Claude to talk. Any other
  pane: hold to dictate, unchanged.
- Nothing on a box is left listening when the browser goes away.
- No new secrets, no new persisted state, no new dependency in the server.

## Non-goals

- Emulating Claude's Space key from Tmuxifier (push-to-talk proxy). Claude's hold and tap
  modes work unchanged through xterm and tmux; Tmuxifier only supplies the microphone.
- The Android app. It never attaches a terminal and has no mic path.
- Retiring whisper.cpp dictation. It remains the answer for shells and non-Claude panes.
- Boxes with a real microphone. The ALSA config would shadow it; it is guarded and documented.

## Interaction model

- **Press (pointerdown, or the Ctrl+Shift+Space hotkey)** starts the recorder at once, so the
  mic is live before anything else happens, and fires the pane classification.
- **Verdict `claude`**: open `/voice-link`; on the server's `ready` frame, switch the recorder
  to streaming, discard the buffered pre-roll, show the `live` state. Release is ignored from
  then on. The next press unlinks.
- **Any other verdict, a probe failure, or a 1.5 s timeout**: today's dictation. Release
  finishes and transcribes.
- **Release before the verdict** is remembered. `claude` still links (a tap); anything else
  finishes dictation immediately.
- **Link refused by the server** after the mic went live (box not set up, or setup running):
  the press continues as dictation with the buffered audio, plus a one-line notice.
- **Unlink triggers**: a second press; the socket closing for any reason (no automatic
  re-arm), including the server closing a link that delivered no frame for 3 s; the pane being
  undocked, replaced, or its box removed; the page going hidden (`visibilitychange`); logout or
  session expiry; a hard cap of 30 minutes linked. Window blur
  alone does not unlink, unlike dictation, because the live state is persistent in the header
  and the browser's own microphone indicator is showing.

## Architecture

### Browser (`src/web/`)

- `pcmStream.ts` (new, pure): a streaming resampler from Float32 blocks at the device rate to
  16 kHz S16 mono, carrying the fractional resampling position across blocks, plus a framer
  that emits 20 ms frames of 640 bytes and holds the remainder. Shares the interpolation with
  `wavEncode.ts`; the whole-buffer encoder stays for dictation.
- `voiceRecorder.ts`: gains a `stream(sink)` mode. Until it is called the recorder buffers as
  today; after it, the buffer is discarded and every new block is resampled and framed to
  `sink`. `stop()` in stream mode returns nothing and tears down the mic.
- `voiceLink.ts` (new): the client side of the socket. `open(boxId, clientId)` connects,
  resolves on the `ready` text frame, rejects on a close code before it; `send(frame)`;
  `close()`. Handles the 30-minute cap and the `visibilitychange` unlink.
- `voiceUi.ts`: the controller grows the state machine described above as a pure reducer
  (`voicePress.ts`, new, unit-tested): states `idle` → `probing` → (`recording` → `working` | `linking` →
  `live`) → `idle`, events `press`, `release`, `verdict(kind)`, `ready`, `refused(code)`,
  `done`, `closed`. The DOM layer maps states to `data-state` and labels. `live` is the fourth
  button state: `● live`, `--accent`, tooltip and accessible name "Linked to Claude Code, hold
  Space in the pane to talk. Tap to unlink."
- Pre-press hint: the idle tooltip reads "Tap to link your mic to Claude Code" when the status
  snapshot's entry for the pane's session shows an active-pane command of `claude` (or
  `claude-*`), else "Hold to dictate". A hint only; the press-time verdict decides.
- Phone mode: the touch bar's mic slot adopts the same button, so tap links and hold dictates
  there too. The composer sink applies to dictation only.
- Duplicate panes: the link belongs to the box. The button that linked owns the `live` state.
  Linking from another pane on the same box supersedes; the first button returns to idle with a
  one-line notice in its terminal.

### Server (`src/server/`)

- `POST /api/boxes/:id/pane-kind` `{ session }` → `{ kind: 'claude' | 'shell' | 'busy' }`.
  Runs `buildPaneStateRemote` and `classifyPaneState` from `tmuxInject.js`, the same function
  dictation and uploads use to decide where text goes, so "links" and "would type here" cannot
  disagree. `session` validated against `SESSION_NAME_RE`. Host Shell (`__local__`) takes the
  local branch. Gated 409 while the box's setup job is `running`, like `/term`.
- `GET /voice-link?box=<id>&client=<id>` (WebSocket). Cookie-authenticated through the same
  `isAuthed` path as `/term`; `client` through `safeClientId`. Close `1008 'setting up'` while
  the box's setup job is running. Accepts `__local__`. Binary frames only, each ≤ 8 KB; a text
  frame from the client is ignored. Server → client text frames: `ready`, and close codes
  `4001 superseded`, `4002 not-set-up`, `4003 writer-failed`, `4004 stalled`.
- `voiceLinks.js` (new): `createVoiceLinks({ openSink })`. One link per box, newest wins: a
  second `open(boxId)` closes the earlier socket with `4001`. `open` spawns the writer through
  `openSink(box)` and starts a 300 ms readiness timer; if the writer exits before it, the
  socket closes with `4002` (exit 3) or `4003` (anything else); otherwise `ready` is sent.
  `write(frame)` drops the frame when the child's stdin needs drain, or when the rolling
  byte-rate exceeds 64 KB/s (twice nominal). Never queues. A link that has delivered no frame
  for 3 s is closed with `4004 stalled`, because a stalled feed leaves Claude's reader blocked
  and its stop hanging. `close` ends stdin and kills the child 3 s later, after the writer's
  silence tail. `closeAll` is wired into shutdown.
- `sshRun.js`: `sshPipe(argv)` (new), the streaming-stdin primitive beside `sshRunStdin` and
  `sshStream`: returns `{ stdin, done, kill }` with stdout ignored and stderr captured (capped)
  for the failure message.
- `boxActions.js`: `openAudioSink(box)` builds the writer remote through `buildProbeArgv` (so
  `assertBoxSafe` and the ControlMaster args apply) and calls `sshPipe`.
- `localShellActions.js`: `openAudioSink()` spawns the same writer program locally with
  `python3 -c` (or `cat`) for Host Shell.
- `claudeVoiceLink.js` (new): `buildVoiceLinkInstallScript()` (pure, interpolates nothing) and
  `createVoiceLinkPusher()`, the structural twin of `claudeAgentHooks.js`. Runs as the
  `voice-link` phase of `setupManager.js`, after `agent-hooks` and before `script`, gated by
  the `claude` tools selection, recorded on `job.voiceLink`, never promoted to a job failure.
  Also reachable for Host Shell through the existing `claudeHooks` flag on `PATCH
  /api/local-shell`, over the same local stdin transport the hooks install uses.

### Box side

The writer program is static text carried in the remote command; audio arrives on stdin.

```
python3 -c '<program>' || <cat fallback into "$HOME/.tmuxifier-voice/mic.fifo">
```

Program contract (`test/voiceWriter.test.js` pins it against the real python3):

- Exits 3 immediately when `~/.tmuxifier-voice/mic.fifo` is not a FIFO (box never set up).
- Opens the FIFO `O_RDWR | O_NONBLOCK`, so opening never blocks and the pipe never signals
  EOF while the link is up; `F_SETPIPE_SZ` to 4096 bytes (about 128 ms of audio), so Claude
  never hears more than that of pre-roll when it opens the device.
- Reads stdin in chunks, writes non-blocking, drops on `EAGAIN`. Only whole even-length runs
  are written or dropped: a one-byte carry keeps S16 sample alignment across arbitrary stdin
  chunk boundaries and across drops. Writes are ≤ `PIPE_BUF`, hence atomic.
- On stdin EOF (the link is gone) it feeds 2.5 s of paced silence, past Claude Code's 2.0 s
  silence-detection window, then keeps pacing silence for as long as any process still holds
  the FIFO open for reading (a `/proc/*/fd` scan every ~240 ms, checking the access mode in
  `fdinfo` so a successor writer's `O_RDWR` handle does not count; capped at 10 minutes), and
  only then parks the idle device and exits 0. A reader mid-recording therefore always ends on
  silence and never sees EOF.

There is no `cat` fallback. A box without python3 gets exit 3 from the remote (`4002`), and the
setup phase installs nothing on it (`skipped-no-python3`): a shadowing capture device with no
writer that can honour the reader rule is a hazard, not a degraded feature.

#### The idle capture device is an absent path — not the FIFO, and not `/dev/zero`

Amended 2026-09-04, twice. The path `~/.asoundrc` names, `~/.tmuxifier-voice/mic`, is a
**symlink**; the real FIFO is `~/.tmuxifier-voice/mic.fifo`. Idle, the symlink points at
`~/.tmuxifier-voice/mic.absent`, which never exists; only while a writer is alive does it point
at the FIFO.

Why not the FIFO: alsa-lib's file plugin opens `infile` `O_RDONLY`, and **opening a FIFO with no
writer blocks forever** (verified on this host). With `infile` naming the FIFO directly, every
Claude Code Space press on a prepared box with nothing linked hung inside `snd_pcm_open`.

Why not `/dev/zero` (the first amendment, shipped in v1.24.59 and reverted the same day):
**alsa-lib's null slave has no clock.** The only pacing capture ever has is a live writer whose
empty FIFO makes reads block. A source that never blocks — `/dev/zero`, or the EOF a closed FIFO
returns — makes `snd_pcm_readi` return immediately, forever: measured at **331 million frames
per second** on this host, 20,000× real time. Claude Code's capture thread buffers what it is
handed, so one unlinked Space press filled the box's memory, then its swap, then took the
Proxmox host down. An absent path makes the open fail instead: Claude reports that it could not
open an audio device — an error, not a hang and not a crash — and the box is untouched.
Rejected alternatives: a permanent FIFO holder (reads still block when a writer exists but sends
nothing), a per-box silence daemon (a new persistent process, needing boot persistence), and
any process-free "silence" source (all of them spin).

The writer owns the swap, and one pidfile makes it single-instance:

- Start: require `mic.fifo` to be a FIFO (else exit 3); read `~/.tmuxifier-voice/writer.pid`
  and, when it names a **live** pid, `SIGTERM` it and poll ~300 ms for it to go; write our own
  pid; open the FIFO; swap `mic → mic.fifo` atomically (temp symlink + `rename`).
- Superseded (our `SIGTERM` handler fired): exit at once — **no silence tail**, no symlink
  restore, no pidfile removal. The successor owns all three by then. Without this the
  predecessor's 2.5 s tail interleaved zeros into the successor's live audio.
- Normal end (stdin EOF): play the tail, keep pacing silence while any reader still holds the
  FIFO, then swap back to the absent path and remove the pidfile.
- A writer `SIGKILL`ed without cleanup leaves the symlink on the FIFO until the next link. The
  next writer always repairs it (it re-points unconditionally) and treats a dead pid as stale.
  Accepted residual: between those two moments an unlinked press blocks as it did before, and
  a reader that held the FIFO at the kill sees EOF and spins — which is why `voiceLinks.js`
  never kills a writer before its 11-minute grace, and only ends its stdin.

The install script therefore creates `mic.fifo` and `ln -sfn "$VDIR/mic.absent" mic`, migrating
older layouts in place: a **FIFO** named `mic` is renamed to `mic.fifo` when that name is free,
else removed; any existing symlink (v1.24.59's `/dev/zero`) is re-pointed. A **regular file**
named `mic` is never clobbered — the same posture as the foreign-`.asoundrc` guard.

Setup phase, decided on the box by `command -v claude` (`skipped-no-claude` otherwise):

- `~/.asoundrc`: written with the recipe above (path from `$HOME` on the box) only when the
  file is absent or already carries the `# tmuxifier-voice-link` marker. Otherwise
  `skipped-asoundrc-exists`; an operator's own ALSA config is never touched.
- `~/.tmuxifier-voice/mic.fifo`: `mkfifo`, mode 600, directory 700; plus `mic`, the symlink
  to the absent path described above (older layouts are migrated in place). Skipped entirely,
  `skipped-no-python3`, on a box without python3.
- Claude settings: `voice.enabled: true` merged into `~/.claude/settings.json` with the same
  jq → node → python3 chain the statusline push uses, only when no `voice` key exists, so an
  operator who ran `/voice off` stays off. Mode is left at Claude's default (hold). A box with
  none of the three tools reports `error-no-json-tool` for this sub-step and still gets the
  ALSA config and FIFO.
- Result shape recorded on the job: `{ status: 'applied' | 'skipped-no-claude' |
  'skipped-asoundrc-exists' | 'error-…', settings: 'applied' | 'kept' | 'error-…' }`.

Package: `alsa-utils` joins the Claude tool's package set in the main setup script
(`boxActions.js` tool catalog), where sudo installs already happen. It brings `libasound2`
(the native path's runtime dependency on boxes that see a card) and `arecord` (the fallback on
boxes that see none). The same ALSA config serves both.

## Data flow

```
browser mic ─AudioWorklet─▶ pcmStream (16 kHz S16, 640 B / 20 ms)
  ─binary WS /voice-link─▶ voiceLinks.write (drop on backpressure or over-rate)
  ─ssh stdin over ControlMaster─▶ writer (O_RDWR FIFO, 4 KB pipe, drop when full)
  ─FIFO─▶ ALSA file plugin ─plug─▶ Claude Code (native 48 kHz/32-bit, or arecord 16 kHz)
  ─Anthropic transcription─▶ Claude's prompt
```

Nominal rate 32 KB/s per linked box. At most one link per box.

## Error handling

| Case | Behaviour |
|---|---|
| Box never set up | writer exits 3 → close `4002` → press continues as dictation; terminal line: "voice link: box not set up — run setup with Claude Code ticked; dictating instead" |
| Setup running on the box | socket refused `1008` → dictation, which the existing gate refuses too → the setting-up panel the user already sees |
| Claude's voice mode off on the box | frames stream into a device nobody opens; the writer drops them; no ● REC in Claude; the setup phase result names the settings outcome |
| Socket drops mid-link, or stalls for 3 s | button → idle, no re-arm; the writer's stdin ends, it feeds 2.5 s of silence so a recording in flight ends on Claude's own silence detection, then exits |
| Second tab or pane links the same box | earlier socket closed `4001` → its button idle with a one-line notice |
| Claude pane read as shell (npm wrapper, heuristic miss) | dictation types the transcript into Claude's input box: degraded, not broken. The reverse cannot come from the command name |
| Probe fails or exceeds 1.5 s | dictation |
| Writer dies later (python crash) | socket closed `4003`; button idle; one-line notice |
| 30 minutes linked | client unlinks; terminal line "voice link: off after 30 min" |

## Security

- `/voice-link` carries only audio the operator is deliberately producing, over the same
  authenticated cookie path as `/term`, into a per-box FIFO the box's own user owns (mode 600).
- No script text is interpolated with user or box data: the writer program and the install
  script are static; the FIFO path is derived on the box from `$HOME`. `session` and `box` go
  through the existing allowlists (`SESSION_NAME_RE`, `assertBoxSafe`, `safeClientId`).
- A misbehaving client cannot flood a box: frames over 8 KB, a rate over 64 KB/s, and any
  audio behind a stalled channel are dropped, never queued.
- The link is bounded in time (30 min), bounded in count (one per box), and tied to a live
  socket, so nothing keeps listening after the browser is gone.
- Audio leaves the host: it goes to the box and from there to Anthropic's transcription, under
  the box's Claude.ai login. This is the deliberate difference from whisper.cpp dictation, and
  the docs say so.

## Testing

- **Unit (vitest, node, no DOM).** `pcmStream.ts`: fractional carry across blocks, 640-byte
  frames, even-length invariant, remainder handling. `voicePress.ts`: every ordering of press,
  verdict, release, ready, refused, including release-before-verdict both ways.
  `voiceLinks.js` with a fake sink: newest-wins supersede, drop on backpressure, frame and rate
  caps, 300 ms readiness, exit-3 → `4002`, other exit → `4003`, `closeAll`.
  `claudeVoiceLink.js`: marker guard, no interpolation, `command -v claude` gate, settings
  merge only when `voice` is absent. The classification route reuses `classifyPaneState`,
  already covered by `test/tmuxInject.test.js`.
- **Writer contract, real python3.** Spawn the program against a local FIFO with a slow
  reader: alignment survives odd-length chunks and drops; the writer never blocks; a missing
  FIFO exits 3 inside 300 ms; after stdin EOF a reader receives about 2.5 s of zeros, then
  EOF, and the writer exits 0.
- **Integration, isolated sshd box** (`test/helpers/localBox.js`). Open `/voice-link` against
  the localBox, stream a known pattern, read the FIFO on the box side, compare. Setup-job gate,
  supersede code, not-set-up code, Host Shell branch. The `voice-link` setup phase writing
  `.asoundrc`, the FIFO and the settings merge into the fixture home, and skipping when a
  foreign `.asoundrc` exists.
- **e2e, playwright, fake microphone.** A pane running a stand-in executable named `claude`
  so `#{pane_current_command}` reports it: press → `live` and a socket; press → idle. The same
  box at a shell prompt: hold still dictates (existing coverage).
- **Live validation before merge.** On a real box and on Host Shell: link, hold Space in
  Claude, speak, watch the transcript. This is the only place hold mode over xterm is
  exercised (the probe used tap) and the place to confirm a `setup-token`-seeded box is allowed
  to use voice.

## Documentation

- `docs/terminal.md`: the mic link beside dictation; what "live" means; the Anthropic
  transcription note; the 30-minute cap.
- `docs/boxes-and-setup.md`: the `voice-link` phase, `alsa-utils`, the `.asoundrc` guard, the
  python3/`cat` writer note.
- `CLAUDE.md` / `AGENTS.md`: new modules and routes. `DESIGN.md`: the `live` button state.
- `README.md`: the voice line mentions that a Claude Code pane uses Claude's own transcription.

## Known limits

- Voice needs a Claude.ai login on the box. Whether a `setup-token`-seeded box qualifies is
  confirmed on the first live run; if not, the docs point at an interactive `/login`.
- Hold mode depends on the browser's key auto-repeat reaching Claude through xterm and tmux,
  as it does on a local terminal. Tap mode (`/voice tap`) is the fallback and is what the probe
  used.
- Alpine and minimal images without python3 get the `cat` writer (stale pre-roll possible).
- A box with a real microphone keeps its own config (`skipped-asoundrc-exists`) and gets no
  link.
