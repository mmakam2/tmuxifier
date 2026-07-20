# Voice dictation for Tmuxifier terminals

Date: 2026-07-20
Status: design approved, not yet implemented

## Problem

Claude Code ships a `/voice` slash command for dictation, but it cannot work on a Tmuxifier
box. The CLI opens a real audio capture device on the machine it runs on — a native audio
module, falling back to `arecord` (ALSA) or `rec` (SoX). A box is a headless LXC container
with no microphone, no audio device, and no sound server, so `/voice` fails with
`"Voice mode requires a microphone, but SoX could not open an audio capture device"`.
Upstream documents this as unsupported over SSH and in headless remote sessions.

The microphone that does exist is in the browser — which is exactly where Tmuxifier's UI
already runs. So the capability belongs in Tmuxifier, not in the remote CLI.

### Alternative rejected: give the box a fake audio device

It is technically possible to make the built-in `/voice` work: load `snd-aloop` on the
Proxmox host, pass the device into the unprivileged container, run a daemon that streams
browser microphone audio into that virtual source, and let the CLI record from it. This was
rejected. It requires an audio streaming protocol, a per-box daemon, per-container audio
provisioning, and loosening LXC device privileges — strictly more work than capturing in the
browser, while still requiring browser microphone capture and streaming anyway. It is also
fragile: any change to how Claude Code probes audio devices breaks it.

## Solution

Capture audio in the browser, transcribe it with a local whisper.cpp on the Tmuxifier host,
and type the transcript into the box's tmux session over the existing ControlMaster.

Audio never leaves the host. Browser to the operator's own server to a local whisper process.
Unlike the built-in `/voice`, no audio is sent to Anthropic or any third party.

## Decisions

Each of these was chosen against explicit alternatives during design.

| Decision | Chosen | Rejected alternatives |
| --- | --- | --- |
| Transcript destination | Typed into the pane as literal keystrokes, never auto-Enter | A review/edit overlay before insertion; an undo toast that sends backspaces (fragile — a concurrent redraw invalidates the backspace count) |
| Trigger | Both a toolbar microphone button and a hold-to-talk hotkey, sharing one recorder module | Hotkey only (undiscoverable); button only (hand leaves keyboard); tap-to-toggle (microphone can be left hot) |
| whisper process model | Lazy persistent: spawned on first use, kept warm, shut down after an idle timeout | Spawn per request (pays model load every clip); always-resident (holds ~0.85 GB permanently) |
| Provisioning | Build from source into a gitignored `vendor/`, driven by a job manager | Third-party prebuilt binary (no official upstream Linux x64 build; supply-chain risk on a host holding fleet SSH access); manual system-wide install (breaks the self-contained principle) |
| Injection path | Server-side `tmux send-keys`, pane-aware, reusing `injectVia`/`classifyPaneState` | Client-side write into the `/term` WebSocket (no busy-pane guard, lost during reconnect); server-side without the guard (diverges from upload behaviour) |
| Default model | `small.en` | `medium.en-q5_0` (~4s per clip is a noticeable pause after every phrase) |
| Install surface | The Settings tab performs the full install, including the build, as a persisted job | CLI-only install with a configure-only tab; a split where only model downloads are in the UI |

### Audio format: no ffmpeg

The browser's `MediaRecorder` emits webm/opus, but whisper.cpp wants 16 kHz mono PCM. Rather
than add an ffmpeg system dependency to decode server-side, raw PCM is captured via the Web
Audio API and the WAV is encoded client-side. whisper receives its native format, no system
dependency is introduced, and the encoder is a pure function that is unit-testable in Node.

The cost is bandwidth: 16 kHz mono 16-bit is ~32 KB/s, so a 30-second clip is roughly 1 MB.
This is acceptable for a LAN-local dashboard.

### Host sizing

Measured on the target host (Intel i9-12900K, container limited to 4 cores):

| Model | File | Peak RAM | ~10s clip |
| --- | --- | --- | --- |
| `base.en` | 150 MB | ~0.3 GB | ~0.4s |
| `small.en` | 500 MB | ~0.85 GB | ~1.5s |
| `medium.en-q5_0` | 540 MB | ~1.7 GB | ~4s |
| `medium.en` fp16 | 1.5 GB | ~2.6 GB | ~5–6s |

The container was raised to 4 GB of RAM for this feature. `small.en` at ~1.5s is low enough
that dictation feels immediate; the model is a configuration knob, so upgrading is a settings
change plus a download.

## Architecture

### New server modules

| Module | Responsibility | Injected dependencies |
| --- | --- | --- |
| `src/server/voiceText.js` | Pure. `normalizeTranscript(raw)`: strip whisper segment and timestamp markers, collapse newlines to spaces, strip non-printable characters, trim, cap length | none |
| `src/server/voiceCatalog.js` | Pure. Model-id allowlist resolving to `{file, bytes, sha256, url}`; the pinned whisper.cpp repository URL and git ref | none |
| `src/server/voiceEngine.js` | `createVoiceEngine(...)`: lazy spawn, readiness gate, idle-timeout shutdown, crash restart, bounded request queue, `transcribe(wav)`, `stop()` | `spawn`, `fetch`, `now`, timers |
| `src/server/voiceInstall.js` | `createVoiceInstallManager(...)`: single-flight persisted install job (apt, clone, build, fetch model, verify), streaming capped log | `run`, store, `freeSpace` |
| `src/server/voiceInstallStore.js` | Debounced `data/voice-jobs.json` persistence via `debouncedJsonStore.js` | `jsonFile` |
| `src/server/voiceStore.js` | `data/voice.json` — `{enabled, model}`. Written `0o600` via `jsonFile.js` | `jsonFile` |

All follow the repo's factory-function-with-injected-dependencies pattern, which is what makes
them testable with real code rather than mocks.

`voiceCatalog.js` is the security chokepoint. Every value that reaches the install script
originates there or is a hardcoded constant. Nothing user-supplied passes through it.

### Changed server code

- **`tmuxInject.js`** — generalize `injectVia(runScript, session, remotePath)` into
  `injectVia(runScript, session, text, { label })`. It currently hardcodes `injectionText(path)`
  and `"image pasted:"` status messages. Uploads pass `injectionText(path)` with
  `label: 'image'`; voice passes normalized text with `label: 'dictation'`. `classifyPaneState`
  is untouched, so both callers keep the busy-pane guard.
- **`boxActions.js`** — add `injectText(box, session, text)`; `injectUploadPath` becomes a thin
  caller of it.
- **`server.js`** — the five routes below, modelled on the existing `/api/upload` handler.
- **`config.js`** — `whisperBin`, `whisperModel`, `voiceIdleMs`, `voiceMaxMb`,
  `voiceMaxSeconds`, plus a `voiceEnabled` derivation.
- **`GET /api/ui-config`** — gains `voice: boolean`, following the `termFont` precedent. The
  client omits the microphone entirely when whisper is not installed or voice is disabled.
- **`shutdown.js`** — `engine.stop()` joins the SIGTERM flush.

### Routes

```
GET   /api/voice/status        installed?, models on disk, selected, enabled, engine state, running job
POST  /api/voice/install       { model } -> job id      (single-flight)
GET   /api/voice/install/:id   poll: status + log tail
PATCH /api/voice/settings      { enabled, model }
POST  /api/voice?box=<id>      wav bytes -> { text, injected, mode }
```

All five require authentication.

### New client modules

| Module | Responsibility |
| --- | --- |
| `src/web/wavEncode.ts` | Pure. Float32 chunks at an arbitrary input sample rate, resampled to 16 kHz mono, Int16 quantized, WAV header. The input rate is a parameter, not an assumption — `AudioContext.sampleRate` is commonly 48000 but is device-dependent and may be 44100. No DOM access |
| `src/web/voiceRecorder.ts` | Thin DOM wrapper: `getUserMedia`, AudioWorklet capture, `start()`/`stop()` returning WAV bytes |
| `src/web/voiceUi.ts` | Microphone button, hold-hotkey binding, state indicator (idle, recording, transcribing, error) |
| `src/web/settingsVoice.ts` | Settings tab: install state, Install button with streaming log, enable toggle, model picker, engine status |

`terminal.ts` binds the hotkey through xterm's `attachCustomKeyEventHandler` so the combination
is swallowed before reaching the PTY. `api.ts` gains `postVoice`. `settingsVoice.ts` joins the
existing tab shell in `settingsUi.ts` and reuses `setupPoller.ts`'s generation-guarded poll loop
for the install log.

### Settings storage: two places, deliberately

This mirrors the existing `passkeyOnly` precedent:

- `data/voice.json` holds the user-editable `{enabled, model}`, changed from the Settings tab.
- `.env` `TMUXIFIER_VOICE=off` is a deploy-level hard kill switch that overrides the stored
  flag, for an operator who wants voice impossible regardless of what the UI says.

**Amendment (stage 2 planning).** `data/voice.json` is authoritative for both the enable flag
and the model choice. The deciding factor is lifetime: `.env` is parsed once at boot, so a
Settings picker writing to it could not take effect until a restart and would appear to do
nothing in the meantime, whereas `data/voice.json` is read per request and applies
immediately.

Path resolution therefore becomes, in order:

- Binary: `TMUXIFIER_WHISPER_BIN` if set, else the vendored build path if it exists.
- Model: `TMUXIFIER_WHISPER_MODEL` if set, else `voiceCatalog.resolveModel(store.model)`
  mapped into the vendored models directory.
- Enabled: the resolved binary and model both exist, AND `data/voice.json`'s `enabled` is
  true, AND `TMUXIFIER_VOICE=off` is not set.

The two `TMUXIFIER_WHISPER_*` variables are retained as deliberate escape hatches — a custom
whisper build, or the e2e suite pointing at a fixture. When either is set it wins, and the
Settings tab shows the affected control as pinned by `.env` rather than offering a picker that
silently does nothing.

Migration: stage 1's `setup-voice` script wrote both variables into `.env`. Stage 2 stops
writing them and instead records the model in `data/voice.json`. An existing deployment that
ran stage 1 must have those two lines removed for the picker to govern; the Settings tab
surfaces this rather than failing quietly.

## Data flow

### Dictation

```
boot        GET /api/ui-config -> voice:true only if installed && enabled && not killed by .env
            microphone button rendered only then

hold        voiceRecorder.start()
              getUserMedia({audio:{channelCount:1, echoCancellation, noiseSuppression}})
              AudioWorklet -> Float32 frames at the context rate (usually 48 kHz)

release     wavEncode: 48k->16k downsample, Float32->Int16, WAV header
            client guard: voiceMaxSeconds (default 120)

            POST /api/voice?box=<id>   Content-Type: audio/wav, raw body
                                       server guard: voiceMaxMb as bodyLimit

server      requireAuth -> enabled? -> engine.transcribe(wav)
              engine cold -> spawn whisper-server, poll readiness with a deadline
              engine warm -> straight to the loopback POST /inference
              either way  -> cancel the idle timer for the duration of the request

            normalizeTranscript(raw)
            boxActions.injectText(box, session, text)
              -> injectVia -> classifyPaneState
                   'claude' | 'shell' -> send-keys -l   (literal, no Enter)
                   'busy'             -> display-message

            <- { text, injected, mode }
```

On `mode: 'busy'` the client shows "pane busy — not typed" and copies the transcript to the
clipboard via the existing `clipboard.ts`, so a rejected injection never loses what was said.

The engine serializes transcriptions behind a small bounded queue; overflow returns 429 rather
than accumulating spawned work.

### Secure-context gate

`getUserMedia` requires HTTPS or localhost, so voice is unavailable over a plain-HTTP LAN
address. This is the same shape as `passkeys.ts`'s `evaluateOrigin`: an ordered readiness check
returning a reason and a hint, rendered identically in two places. The order is browser support,
then secure context, then permission state, then installed/enabled — so the microphone button
and the Settings tab explain a disabled microphone with the same text.

### Install

```
POST /api/voice/install {model}  -> single-flight guard -> persisted job, returns id

manager (sequential, streaming into a rolling capped log):
  0. preflight: free disk space vs the catalog's required bytes
  1. cmake present? -> skip step 2
  2. apt-get install -y cmake            (hardcoded package, DEBIAN_FRONTEND=noninteractive)
  3. git clone --depth 1 <pinned url> --branch <pinned ref> -> vendor/whisper
     (already cloned -> fetch + checkout the pinned ref)
  4. cmake --build -j min(4, cores, ramCap)
  5. fetch model -> temp file -> SHA-256 verify -> rename into place
  6. write data/voice.json { enabled: true, model }

client polls GET /api/voice/install/:id via setupPoller.ts and renders the log tail
restart mid-build -> 'running' reconciles to 'interrupted' (the setupManager precedent)
```

Step 5's temp-then-rename follows the `jsonFile.js` discipline: a killed download can never
leave a truncated file that whisper would later mmap. Verification happens before the rename,
so an unverified blob never occupies the real path.

### Setup script

`scripts/setup-voice.mjs`, wired as `npm run setup-voice`, is the headless equivalent of the
Install button and drives the same job manager. It accepts an optional model id argument.

## Error handling

### Dictation

| Failure | Behaviour |
| --- | --- |
| Microphone permission denied | Button disabled with a reason; re-checked on each attempt, since permission state can change without a reload |
| Insecure context (plain-HTTP LAN address) | Button disabled; hint points at the TLS steps in `docs/DEPLOY.md` |
| Silence or muted microphone | whisper returns empty or `[BLANK_AUDIO]`; normalized to empty; `mode: 'empty'`, nothing typed |
| Clip reaches `voiceMaxSeconds` | Auto-stop and transcribe what was captured, rather than discarding it |
| Body over `voiceMaxMb` | Fastify 413; the client message reuses `upload.ts`'s `sizeError` shape |
| Binary or model missing at request time | 503, and `/api/voice/status` reports `installed: false` so the tab re-offers Install |
| Engine readiness timeout | Kill the child, return 503, keep detail server-side |
| whisper crashes mid-request | Request returns 502; the engine marks itself dead and respawns on the next request |
| Box unreachable or session gone | Transcript still returned and copied to the clipboard; `{injected: false, mode: 'error'}` |
| Two tabs dictating simultaneously | Bounded queue; overflow returns 429 |

Two of these are load-bearing rather than routine:

**The idle timer is cancelled during a request, not merely reset.** Reset-on-use has a race: a
request starting at T+9:59 of a ten-minute idle window would have its engine killed underneath
it. The timer is cleared on request entry and re-armed on completion.

**Transcript sanitization is a security control.** `normalizeTranscript` strips non-printable
characters before the text reaches `send-keys`, so a transcription artefact can never emit an
escape sequence into the pane — the same class of control as `upload.ts`'s `termSafe`. It also
caps length at roughly 4000 characters, so no single dictation produces an unbounded argv.

Collapsing newlines is likewise load-bearing rather than cosmetic: whisper emits one line per
segment, and a newline delivered through `send-keys` is Enter, which would submit a
half-finished prompt.

### Install

| Failure | Behaviour |
| --- | --- |
| Not root, or apt fails | Job errors with the exact `sudo apt-get install cmake` command to run by hand |
| No network | Clone or download fails; the log shows it; Retry re-runs the job |
| Insufficient disk | Preflight check fails early, reporting bytes required against bytes available |
| SHA-256 mismatch | Temp file deleted, job fails as an integrity failure. Never renamed into place |
| Compile out-of-memory | Build parallelism capped at `-j2` when host RAM is under 6 GB; whisper.cpp translation units run about 1 GB each, so `-j4` in a 4 GB container would OOM |
| Restart mid-build | `running` reconciles to `interrupted` on boot. `vendor/whisper` may be partial, so the next install does fetch, checkout, and rebuild. Idempotent by construction |
| Second install while one is running | 409, single-flight |
| Model switched or voice disabled while the engine is warm | Engine stopped immediately; the next request spawns against the new selection |

### Out of scope

No uninstall button and no per-model delete. The disable toggle covers "stop using this";
reclaiming the disk is `rm -rf vendor/whisper`, documented in the README rather than built.

## Testing

The governing constraint is that CI and contributors will not have a 500 MB model or a
compiler. The whole pipeline must be testable without whisper installed.

### Unit — pure, no dependencies

- `voiceText.test.js` — newline collapse, `[BLANK_AUDIO]`, timestamp markers, control-character
  and ANSI stripping, length cap, empty input
- `voiceCatalog.test.js` — unknown and path-traversal ids rejected; every entry carries a url,
  sha256, and byte count; the git ref is a pinned constant
- `wavEncode.test.ts` — synthetic sine input; RIFF/fmt/data header sizes, Int16 clamping, and
  correct output length from both 48000 and 44100 input rates
- `tmuxInject.test.js`, extended — the generalized `injectVia(text, {label})`. The existing
  upload cases must keep passing unchanged, which is the regression guard on that refactor

### Integration — real code, fakes only at the process boundary

- `voiceEngine.test.js` — inject a fake `spawn` that starts a small stub HTTP server in place
  of whisper. Covers lazy spawn, warm reuse, idle-timeout shutdown, the timer-cancelled-during-
  request race, crash and respawn, readiness timeout, and queue overflow
- `voiceInstall.test.js` — inject a fake `run` scripting each step's outcome: single-flight 409,
  SHA mismatch aborting before the rename, the preflight disk check, apt skipped when cmake is
  already present, the `running`-to-`interrupted` reconcile, and log capping
- `voiceRoutes.test.js` — a real Fastify app per the `server.test.js` pattern: authentication
  required on all five routes, disabled returning 503, bodyLimit 413, unknown box 400, and the
  `__local__` branch

### End-to-end — playwright, using the existing local-sshd box helper

Point `TMUXIFIER_WHISPER_BIN` at a fixture script that emits fixed JSON. This exercises browser
to route to engine to `send-keys` to a real tmux pane, asserting the text lands in the session,
with no model, no compiler, and no GPU. Also covers the Settings tab's install-gated and
disabled-state rendering.

### Manual verification

Real transcription accuracy and real microphone capture are not automated. Chromium's
`--use-file-for-fake-audio-capture` makes a real-audio run possible but too heavy for CI, so it
is a manual check on this host after implementation.

## Configuration

```
TMUXIFIER_VOICE=off              hard kill switch, overrides data/voice.json
TMUXIFIER_WHISPER_BIN            override the binary path (tests, custom builds)
TMUXIFIER_WHISPER_MODEL          override the model path
TMUXIFIER_VOICE_IDLE_MS          engine idle shutdown, default 600000
TMUXIFIER_VOICE_MAX_MB           request bodyLimit, default 8
TMUXIFIER_VOICE_MAX_SECONDS      client auto-stop, default 120
```

`data/voice.json` holds `{enabled, model}`, written `0o600`. It contains no secrets, so unlike
`proxmox.json` and `netbox.json` nothing in it is sealed.

`vendor/` joins `data/` and `tls/` in `.gitignore`. `.env.example` documents every knob above,
per the repo rule that any gitignored file ships with a placeholder counterpart.

## Security

The install route lets an authenticated HTTP request run `apt-get`, a `git clone`, a compile,
and a large download as root — the service runs as `User=root` in `deploy/tmuxifier.service`.
The existing authentication gate already protects SSH-as-root into the whole fleet, so a stolen
session is not made meaningfully worse, but that holds only if no attacker-controlled value ever
reaches the install script. The design therefore requires:

- The apt package list is a hardcoded constant (`cmake`), never a parameter.
- The whisper.cpp repository URL and git ref are pinned constants, not user input.
- Model downloads resolve a model id against a server-side allowlist to a fixed URL. No
  user-supplied URL is ever fetched. Without this the route would be an SSRF and
  arbitrary-file-write primitive.
- Each model carries a pinned SHA-256 verified after download and before the rename, because
  the file is mmap'd into the server process.
- Installs are single-flight.

This is the same discipline `boxActions.js` already applies with `TOOL_IDS`: ids validated
server-side, nothing user-typed reaching the script.

Beyond the install route:

- Transcripts are stripped of non-printable characters before reaching `send-keys`, so no
  escape sequence can be injected into a pane.
- Voice is off until explicitly enabled, and `TMUXIFIER_VOICE=off` overrides the stored flag.
- Audio never leaves the host: browser, to the operator's own server, to a local whisper
  process. No audio is sent to Anthropic or any third party — a genuine privacy advantage over
  Claude Code's built-in `/voice`, which streams audio to Anthropic for transcription.

## Suggested implementation phasing

The work splits cleanly into two shippable stages. This is guidance for the implementation
plan, not a scope change — both stages are in scope.

1. **Dictation path.** `voiceText`, `voiceCatalog`, `voiceEngine`, the generalized `injectVia`,
   `POST /api/voice`, `wavEncode`, `voiceRecorder`, `voiceUi`, and `scripts/setup-voice.mjs`.
   At the end of this stage voice works, installed from the command line.
2. **Install and settings UI.** `voiceInstall`, `voiceInstallStore`, `voiceStore`, the four
   management routes, and `settingsVoice.ts`. At the end of this stage a new deployer can turn
   voice on entirely from the browser.

Stage 1 is independently useful and independently testable, so it should land first.
