// The one 🎤 button: the readiness verdict, the hotkey predicate, and the
// controller that turns a press into either a voice LINK (a Claude Code pane
// hears this browser's mic directly) or today's dictation (anything else).
// The verdict and the hotkey predicate are pure so they are unit-testable and
// so the login-style "why is this unavailable" text has exactly one source;
// the press decision itself is voicePress.ts's pure reducer, and this file
// runs the effects it names.

import { api } from './api';
import { createVoiceRecorder, type VoiceRecorder } from './voiceRecorder';
import { termSafe } from './upload';
import { reducePress, IDLE, inFlight, endInFlight, type PressModel, type PressEvent, type PressEffect, type PaneKind } from './voicePress';
import { openVoiceLink, type VoiceLink, type LinkCloseWhy } from './voiceLink';

export interface VoiceEnv {
  supported: boolean;
  secureContext: boolean;
  enabled: boolean;
}

export interface VoiceVerdict {
  ok: boolean;
  reason: string;
  hint: string;
}

// Ordered readiness check, mirroring passkeys.ts evaluateOrigin: the most
// fundamental blocker is reported first, so a user on an unsupported browser is
// never told to go configure TLS.
export function evaluateVoice(env: VoiceEnv): VoiceVerdict {
  if (!env.supported) {
    return { ok: false, reason: 'This browser has no microphone capture support.', hint: 'Try a current Chrome, Edge, or Firefox.' };
  }
  if (!env.secureContext) {
    return {
      ok: false,
      reason: 'Microphone access needs a secure context (HTTPS or localhost).',
      hint: 'Configure TLS — see docs/DEPLOY.md — or reach Tmuxifier on localhost.',
    };
  }
  if (!env.enabled) {
    return { ok: false, reason: 'Voice dictation is not enabled on this server.', hint: 'Run `npm run setup-voice` on the Tmuxifier host.' };
  }
  return { ok: true, reason: '', hint: '' };
}

// Ctrl+Shift+Space TOGGLES recording: this same non-repeat keydown match is
// used both to start (no recording in flight) and to stop (one already is) —
// see createVoiceHotkeyHandler below, which is what actually decides which.
// Deliberately not Ctrl+Shift+V — clipboard.ts already claims that for paste.
// `repeat` is excluded because a held key auto-repeats keydown, which would
// otherwise read as a stream of fresh presses; createVoiceHotkeyHandler still
// has to swallow those repeats (and the eventual keyups) so a held chord
// can't leak Space characters into the terminal, it just doesn't treat them
// as a second toggle.
export function isVoiceHotkey(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return false;
  if (ev.repeat) return false;
  if (!ev.ctrlKey || !ev.shiftKey || ev.metaKey || ev.altKey) return false;
  return ev.code === 'Space';
}

// The three physical keys of the Ctrl+Shift+Space chord (either Control,
// either Shift, Space), matched on `code` regardless of event type or repeat.
// Used only by createVoiceHotkeyHandler while a chord press is already in
// progress, to swallow every remaining event that belongs to it. Matching on
// physical key identity rather than re-checking modifier state is
// deliberate: this used to matter for deciding when to STOP (the old
// hold-to-talk design), where a release order like "Ctrl up, then Space up"
// already reports ctrlKey: false on the Space keyup, which made a naive
// require-all-three check unreliable. Toggling removed that decision
// entirely, but the same reasoning still applies here for a different
// purpose — swallowing must not depend on which modifier let go first either.
function isVoiceHotkeyChordKey(ev: KeyboardEvent): boolean {
  return ev.code === 'Space' || ev.code === 'ControlLeft' || ev.code === 'ControlRight'
    || ev.code === 'ShiftLeft' || ev.code === 'ShiftRight';
}

export interface VoiceHotkeyTarget {
  ready(): boolean;
  recording(): boolean;
  begin(): void;
  finish(): void;
}

// Wires the Ctrl+Shift+Space chord as a toggle for terminal.ts's single xterm
// custom key event handler: the first non-repeat keydown of the chord starts
// a recording, or finishes one already in flight, depending on
// voice.recording() at that instant. Every other event belonging to that same
// physical press — the auto-repeat keydowns fired for as long as Space stays
// held, and the keyups as the keys come back up in whatever order — is
// swallowed too rather than left to fall through, so a chord held for
// several seconds can never leak spaces (or anything else) into the pane.
// Returns a per-event predicate: true means "consumed — the caller should
// return false to xterm"; false means "not ours, keep evaluating (clipboard,
// then ordinary pass-through)". Internally checks voice.ready() so the chord
// falls through untouched whenever voice isn't actually usable yet (readiness
// fetch still in flight, or the readiness verdict itself failed, e.g. plain
// HTTP) — a controller that isn't there can't be handed a begin()/finish()
// call anyway. A server with whisper OFF is no longer one of those cases: the
// press can still link a Claude pane, and a non-Claude one explains itself.
export function createVoiceHotkeyHandler(voice: VoiceHotkeyTarget): (ev: KeyboardEvent) => boolean {
  let chordActive = false;
  return (ev: KeyboardEvent): boolean => {
    if (!voice.ready()) return false;
    if (chordActive) {
      if (!isVoiceHotkeyChordKey(ev)) return false;
      // Space coming back up is what ends this physical press — regardless
      // of whether Ctrl/Shift already let go earlier or haven't yet, since a
      // released modifier doesn't stop Space's auto-repeat by itself.
      if (ev.type === 'keyup' && ev.code === 'Space') chordActive = false;
      return true;
    }
    if (ev.type === 'keydown' && isVoiceHotkey(ev)) {
      chordActive = true;
      if (voice.recording()) voice.finish(); else voice.begin();
      return true;
    }
    return false;
  };
}

export function detectVoiceEnv(enabled: boolean): VoiceEnv {
  return {
    supported: typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof AudioWorkletNode !== 'undefined',
    secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    enabled,
  };
}

export interface VoiceHost {
  write(text: string): void;      // echo status into the terminal
  copy(text: string): void;       // clipboard fallback when a pane is busy
  focus(): void;                  // return keyboard focus to the terminal
  // Present while the phone composer is open: a dictation reroutes the
  // transcript here (inject=off server-side) instead of typing it into the
  // pane, and skips the terminal refocus — the composer field is holding focus
  // so the soft keyboard stays up for the edit-then-Send loop. Dictation only:
  // a linked pane's audio never comes back through the browser at all.
  sink?(): ((text: string) => void) | null;
  // The session THIS pane is attached to (per-pane since duplicate panes);
  // undefined for the Host Shell, whose session the server names itself.
  session?(): string | undefined;
  // Pre-press hint from the status snapshot's paneCmd — the idle tooltip
  // only. The press-time verdict (POST pane-kind) decides.
  hint?(): 'claude' | null;
}

export interface VoiceControllerDeps {
  probe?: (boxId: string, session: string | undefined) => Promise<PaneKind>;
  openLink?: (boxId: string, onClose: (why: LinkCloseWhy) => void) => Promise<VoiceLink>;
  dictationEnabled?: boolean;   // whisper.cpp usable on this server
}

const PROBE_MS = 1500;

// Never blocks dictation on a slow box: a probe that misses the window reads
// as 'error', which the reducer treats like any non-claude verdict. The timer
// is cleared once the race settles so a fast answer leaves nothing pending.
async function probeDefault(boxId: string, session: string | undefined): Promise<PaneKind> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PaneKind>((r) => { timer = setTimeout(() => r('error'), PROBE_MS); });
  const ask = api.paneKind(boxId, session).then((r) => r.kind as PaneKind).catch((): PaneKind => 'error');
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function idleTitle(hint: 'claude' | null, dictationEnabled: boolean): string {
  if (hint === 'claude') return 'Tap to link your mic to Claude Code (then hold Space in the pane)';
  if (!dictationEnabled) return 'Dictation is not enabled on this server (npm run setup-voice); tap on a Claude Code pane to link your mic';
  return 'Hold to dictate (or tap Ctrl+Shift+Space to start/stop)';
}

function refusedText(why: string): string {
  if (why === 'not-set-up') return 'box not set up — run setup with Claude Code ticked';
  if (why === 'setting-up') return 'box setup is running';
  if (why === 'writer-failed') return 'the box-side writer failed';
  if (why === 'unauthorized') return 'session expired';
  return why;
}

function closedText(why: string): string {
  if (why === 'superseded') return 'unlinked — linked from another pane';
  if (why === 'stalled') return 'unlinked — audio stalled';
  if (why === 'cap') return 'off after 30 min';
  if (why === 'hidden') return 'unlinked — tab hidden';
  if (why === 'writer-failed') return 'unlinked — the box-side writer died';
  return 'unlinked';
}

// Owns one recorder, at most one link, and the button element. The reducer in
// voicePress.ts decides; this runs its effects. makeRecorder/probe/openLink
// are injectable so tests drive every ordering with fakes — the same reason
// makeRecorder existed before the link: a fake recorder makes the
// begin()-before-start()-resolves race (I1) deterministic.
export function createVoiceController(
  boxId: string,
  maxSeconds: number,
  host: VoiceHost,
  makeRecorder: (maxSeconds: number, onAutoStop: () => void) => VoiceRecorder = createVoiceRecorder,
  deps: VoiceControllerDeps = {},
) {
  const probe = deps.probe ?? probeDefault;
  const openLink = deps.openLink ?? ((id: string, onClose: (why: LinkCloseWhy) => void) => openVoiceLink(id, onClose));
  const dictationEnabled = deps.dictationEnabled !== false;
  let model: PressModel = IDLE;
  let recorder: VoiceRecorder | null = null;
  let link: VoiceLink | null = null;
  let refusedWhy = 'closed';
  let closedWhy = 'closed';
  let button: HTMLButtonElement | null = null;
  // The readiness verdict this button mounted under. Held on the controller
  // rather than only read in mount(), because paint() runs again on every
  // refreshHint() — see the title rule below.
  let verdict: VoiceVerdict | null = null;

  function paint(): void {
    if (!button) return;
    const s = model.state;
    const ds = s === 'idle' ? 'idle' : s === 'recording' ? 'recording' : s === 'live' ? 'live' : 'working';
    button.dataset.state = ds;
    button.textContent = s === 'recording' ? '● rec' : s === 'live' ? '● live' : s === 'idle' ? '🎤' : '… ';
    // A button disabled by a failed verdict keeps that verdict as its tooltip
    // for good: it is the only explanation the user has, and main.ts calls
    // refreshHint() after every status poll — so a state title here would
    // paint "Hold to dictate" over the reason within seconds of mounting,
    // on a mic that cannot dictate at all.
    button.title = verdict && !verdict.ok ? `${verdict.reason} ${verdict.hint}`.trim()
      : s === 'idle' ? idleTitle(host.hint?.() ?? null, dictationEnabled)
      : s === 'recording' ? 'Release to transcribe (or tap Ctrl+Shift+Space to stop)'
      : s === 'live' ? 'Linked to Claude Code — hold Space in the pane to talk. Tap to unlink.'
      : 'Working…';
    // The visible label is a glyph — mirror the tooltip into the accessible
    // name so the state change is announced, not just painted.
    button.setAttribute('aria-label', button.title);
  }

  function dispatch(ev: PressEvent): void {
    const r = reducePress(model, ev);
    model = r.model;
    paint();
    for (const fx of r.effects) run(fx);
  }

  function startMic(): void {
    const r = makeRecorder(maxSeconds, () => {
      // The dictation cap: transcribe what was captured rather than lose it.
      // Only a dictation has one — stream() clears it when a link goes live.
      if (model.state === 'probing' || model.state === 'recording') dispatch({ t: 'release' });
    });
    recorder = r;
    void r.start().then(() => {
      // finish()/cancel()/dispose() already ran while getUserMedia's prompt
      // was up: the mic is LIVE with nothing referencing it but the local `r`,
      // so release it through that still-live reference rather than leaving it
      // to a capTimer whose own callback can no longer reach it.
      if (recorder !== r) { r.cancel(); return; }
      // The other side of the same race: the link reached `ready` while that
      // prompt was still up, so the 'stream' effect ran against a recorder
      // with no worklet node yet and was a silent no-op. Re-arm it here, or
      // the button would read 'live' with nothing ever on the wire until the
      // user unlinks and presses again.
      if (model.state === 'live') r.stream((f) => link?.send(f));
    }).catch((e) => {
      // start() tears itself down on failure; cancelling through `r` too is
      // defense in depth, so a live mic track can never outlive the object
      // that was the only handle on it.
      r.cancel();
      if (recorder !== r) return;
      recorder = null;
      link?.close(); link = null;
      model = IDLE;
      paint();
      host.write(`\r\n\x1b[33m[voice: ${termSafe((e as Error).message || 'microphone unavailable')}]\x1b[0m\r\n`);
    });
  }

  function openLinkNow(): void {
    void openLink(boxId, (why) => {
      closedWhy = why;
      // Only ever reached for a close we did NOT ask for (our own close()
      // suppresses the callback), so the socket is already gone: drop the
      // reference with it rather than leave dispose() to close it again.
      if (model.state === 'live') { dispatch({ t: 'closed' }); link = null; }
    }).then((l) => {
      if (model.state !== 'linking') { l.close(); return; }   // unlinked while connecting
      link = l;
      dispatch({ t: 'ready' });
    }).catch((e) => {
      refusedWhy = (e as { why?: string })?.why ?? 'closed';
      if (model.state === 'linking') dispatch({ t: 'refused' });
    });
  }

  async function finishDictation(): Promise<void> {
    const r = recorder;
    recorder = null;
    // Bound at finish-time, not delivery-time: if the composer closes during
    // the round trip, the text still lands in the draft it was dictated for.
    const sink = host.sink?.() ?? null;
    try {
      if (!r) return;
      if (!dictationEnabled) {
        r.cancel();
        host.write('\r\n\x1b[33m[voice: dictation is not enabled on this server — run npm run setup-voice]\x1b[0m\r\n');
        return;
      }
      const wav = await r.stop();
      // A 44-byte WAV is header-only: nothing was captured (a stray tap, or a
      // stop inside a single audio frame), so skip the round trip rather than
      // cold-spawning the whisper engine to transcribe silence.
      if (wav.byteLength <= 44) return;
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }), sink ? { inject: false } : undefined);
      if (sink) {
        if (res.text) sink(res.text);
        else host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.text) {
        host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.injected) {
        // A refused injection must never cost the user what they said — and a
        // busy pane and a genuine injection error land in the same branch, so
        // only 'busy' is reported as a busy pane.
        host.copy(res.text);
        const why = res.mode === 'busy' ? 'pane busy — transcript copied to clipboard' : 'injection failed — transcript copied to clipboard';
        host.write(`\r\n\x1b[33m[voice: ${why}]\x1b[0m\r\n`);
      }
    } catch (e) {
      host.write(`\r\n\x1b[33m[voice failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
    } finally {
      dispatch({ t: 'done' });
      // Hand focus back to the terminal so Enter submits what was dictated;
      // on the sink path focus must STAY on the composer field, or the soft
      // keyboard closes mid-composition.
      if (!sink) host.focus();
    }
  }

  function run(fx: PressEffect): void {
    switch (fx) {
      case 'startMic': startMic(); break;
      case 'probe':
        void probe(boxId, host.session?.())
          .then((kind) => { if (model.state === 'probing') dispatch({ t: 'verdict', kind }); })
          // A probe that rejects reads exactly like the 1500ms timeout — the
          // default one cannot, but an unanswered press must never strand the
          // mic in 'probing' with the audio it captured unreachable.
          .catch(() => { if (model.state === 'probing') dispatch({ t: 'verdict', kind: 'error' }); });
        break;
      case 'openLink': openLinkNow(); break;
      case 'stream': recorder?.stream((f) => link?.send(f)); break;
      case 'finishDictation': void finishDictation(); break;
      case 'unlink': link?.close(); link = null; break;
      // The focus handback follows finishDictation's rule: with the composer
      // open, focus must STAY on the draft field — an unlink that yanked it
      // back to the terminal would close the soft keyboard mid-edit.
      case 'stopMic': recorder?.cancel(); recorder = null; if (!host.sink?.()) host.focus(); break;
      case 'noticeRefused': host.write(`\r\n\x1b[33m[voice link: ${termSafe(refusedText(refusedWhy))}; dictating instead]\x1b[0m\r\n`); break;
      case 'noticeClosed': host.write(`\r\n\x1b[2m[voice link: ${termSafe(closedText(closedWhy))}]\x1b[0m\r\n`); break;
    }
  }

  const begin = (): void => { dispatch({ t: 'press' }); };
  const release = (): void => { dispatch({ t: 'release' }); };
  const cancel = (): void => { link?.close(); link = null; recorder?.cancel(); recorder = null; model = IDLE; paint(); };

  return {
    begin,
    release,
    // End whatever is in flight — the hotkey's second press.
    finish(): void { const ev = endInFlight(model.state); if (ev) dispatch(ev); },
    // Focus loss ends a dictation (privacy: a hidden tab with a live mic and
    // nobody watching) but never a link: the live state is persistent in the
    // header and the browser's own mic indicator is showing.
    blur(): void { if (model.state === 'probing' || model.state === 'recording') dispatch({ t: 'release' }); },
    // Whether anything is in flight — a mic, a pending verdict, a link, or a
    // transcription. createVoiceHotkeyHandler consults this on every fresh
    // chord keydown to decide start-vs-end; that is the whole toggle decision.
    recording(): boolean { return inFlight(model.state); },
    cancel,
    refreshHint(): void { if (model.state === 'idle') paint(); },
    mount(parent: HTMLElement, v: VoiceVerdict): void {
      // Recorded BEFORE the first paint: paint() owns the title rule now, so
      // a not-usable verdict is written by paint() itself rather than patched
      // over an idle title afterwards. That patch was correct exactly once —
      // refreshHint() repaints, and would have undone it.
      verdict = v;
      button = document.createElement('button');
      button.className = 'voice-btn';
      button.type = 'button';
      paint();
      if (!verdict.ok) {
        button.disabled = true;
      } else {
        // Pointer events, not mouse events: on touch the compatibility mouse
        // pair browsers synthesize arrives back-to-back AFTER touchend —
        // mousedown and mouseup in the same tick — which began and finished a
        // ~0ms recording, i.e. the mic was non-functional on exactly the
        // devices the touch key bar puts it on.
        //
        // preventDefault() stops the button taking DOM focus on press, so the
        // terminal keeps it for the whole hold, and it is also what suppresses
        // that compatibility pair — the handlers below can never run twice for
        // one gesture.
        button.addEventListener('pointerdown', (ev) => { ev.preventDefault(); begin(); });
        button.addEventListener('pointerup', () => release());
        button.addEventListener('pointerleave', () => release());
        // Touch-only: pointercancel instead of pointerup when the browser
        // takes the gesture over (a scroll started from the button). Without
        // it a held mic would stay live with no second event ever coming.
        button.addEventListener('pointercancel', () => release());
      }
      parent.appendChild(button);
    },
    dispose(): void { cancel(); button?.remove(); button = null; },
  };
}

// Mirrors wireUploads(parent, term, boxId): attaches to the terminal's parent
// element and returns something whose dispose() the caller folds into its own.
// openTerminal is synchronous, so the readiness fetch happens in the
// background and the button appears once the server has answered. The button
// mounts whether or not whisper is installed: a Claude pane links with nothing
// on this host, and a non-Claude press with whisper off explains itself (see
// finishDictation).
export function wireVoice(parent: HTMLElement, boxId: string, host: VoiceHost) {
  let controller: ReturnType<typeof createVoiceController> | null = null;
  let disposed = false;
  // Set alongside `controller` once the readiness verdict is known, so
  // ready() can reflect it without re-deriving detectVoiceEnv.
  let verdictOk = false;

  void api.uiConfig().then((cfg) => {
    if (disposed || !cfg) return;
    // detectVoiceEnv(true): server-side whisper is no longer part of the
    // verdict — it decides whether a press can dictate, not whether the
    // button can exist. Browser support and a secure context still gate the
    // mic itself, and a link needs the mic exactly as dictation does.
    const verdict = evaluateVoice(detectVoiceEnv(true));
    controller = createVoiceController(boxId, cfg.voiceMaxSeconds ?? 120, host, createVoiceRecorder, { dictationEnabled: !!cfg.voice });
    controller.mount(parent, verdict);
    verdictOk = verdict.ok;
  }).catch(() => {});

  // A toggle-started recording (or a link) has no second keypress guaranteed
  // to ever arrive — alt-tab can leave a tab hidden with the mic live and
  // nobody watching the '● rec' indicator, which is a real privacy problem.
  // blur() finishes a dictation (transcribing what was captured, like the
  // capTimer auto-stop) and deliberately leaves a live link alone: that state
  // is persistent in the header, the browser's own mic indicator is showing,
  // and voiceLink.ts already unlinks on a HIDDEN tab.
  const onBlur = (): void => { controller?.blur(); };
  if (typeof window !== 'undefined') window.addEventListener('blur', onBlur);

  return {
    // True once a controller is actually mounted AND the readiness verdict was
    // ok — false while the /api/ui-config fetch is still in flight, and false
    // when a controller mounted but evaluateVoice said no (e.g. plain HTTP:
    // the button correctly renders disabled with the secure-context reason,
    // but without this check the hotkey would still call begin() and hit a raw
    // getUserMedia TypeError instead of falling through to xterm). terminal.ts's
    // key handler consults this so the hotkey isn't swallowed with no
    // controller able to act on it either way.
    ready(): boolean { return controller !== null && verdictOk; },
    recording(): boolean { return controller?.recording() ?? false; },
    begin(): void { controller?.begin(); },
    finish(): void { controller?.finish(); },
    refreshHint(): void { controller?.refreshHint(); },
    dispose(): void {
      disposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
      controller?.dispose();
      controller = null;
    },
  };
}
