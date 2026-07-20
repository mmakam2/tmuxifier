// Voice dictation UI: the readiness verdict, the hotkey predicate, and the
// button/indicator wiring. The first two are pure so they are unit-testable and
// so the login-style "why is this unavailable" text has exactly one source.

import { api } from './api';
import { createVoiceRecorder, type VoiceRecorder } from './voiceRecorder';
import { termSafe } from './upload';

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

// Ctrl+Shift+Space to START recording. Deliberately not Ctrl+Shift+V —
// clipboard.ts already claims that for paste. `repeat` is excluded because a
// held key auto-repeats keydown, which would otherwise read as a stream of
// fresh presses. Keydown stays strict (all three modifiers required together)
// because a false-positive START is cheap to recover from (release stops it)
// while a false-positive STOP is not — see isVoiceHotkeyRelease below for why
// release can't use this same strict check.
export function isVoiceHotkey(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return false;
  if (ev.repeat) return false;
  if (!ev.ctrlKey || !ev.shiftKey || ev.metaKey || ev.altKey) return false;
  return ev.code === 'Space';
}

// Whether this keyup is the release of one of the three chord keys
// (Ctrl+Shift+Space) that should STOP an in-flight recording. Deliberately
// does NOT re-require the other two modifiers to still be held: a keyup
// reports modifier state as of the instant that specific key was released,
// and physical chord releases are rarely simultaneous. Releasing Ctrl even
// ~20ms before Space already reports ctrlKey: false on the Space keyup —
// roughly a coin flip on an ordinary release — so requiring all three here
// would make stopping unreachable on a normal release order, stranding a
// live microphone until the 120s auto-stop transcribes whatever the room said
// in the meantime. The caller is expected to gate this on a recording
// actually being in flight, since outside that window an ordinary Ctrl/Shift
// keyup (e.g. after typing a capital letter) must not be swallowed.
export function isVoiceHotkeyRelease(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keyup') return false;
  return ev.code === 'Space' || ev.key === 'Control' || ev.key === 'Shift';
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
}

// Owns one recorder and the button element. Returned dispose() detaches it.
// makeRecorder defaults to the real createVoiceRecorder; overridable so tests
// can drive the begin()/finish() race (I1) and the zero-sample short-circuit
// with a fake recorder instead of the real getUserMedia/AudioWorklet stack.
export function createVoiceController(
  boxId: string,
  maxSeconds: number,
  host: VoiceHost,
  makeRecorder: (maxSeconds: number, onAutoStop: () => void) => VoiceRecorder = createVoiceRecorder,
) {
  let recorder: VoiceRecorder | null = null;
  let busy = false;
  let button: HTMLButtonElement | null = null;

  function setState(s: 'idle' | 'recording' | 'working'): void {
    if (!button) return;
    button.dataset.state = s;
    button.textContent = s === 'recording' ? '● rec' : s === 'working' ? '… ' : '🎤';
    button.title = s === 'recording' ? 'Release to transcribe' : 'Hold to dictate (Ctrl+Shift+Space)';
  }

  async function begin(): Promise<void> {
    if (busy || recorder) return;
    const r = makeRecorder(maxSeconds, () => { void finish(); });
    recorder = r;
    try {
      await r.start();
      if (recorder !== r) {
        // finish() (or cancel()/dispose()) already ran while getUserMedia's
        // permission prompt / device-open latency was still in flight — it
        // nulled `recorder` (and possibly started a different recording)
        // before this recorder ever allocated its mic track. start() has now
        // resolved successfully regardless, so the mic is LIVE with nothing
        // referencing it except the local `r`: release it through that
        // still-live reference rather than leaving it to the 120s capTimer
        // (or forever, if capTimer's own onAutoStop finds `recorder` already
        // pointing elsewhere).
        r.cancel();
        return;
      }
      setState('recording');
    } catch (e) {
      // start() tears itself down on failure, but that's defense in depth —
      // cancel() is called here too via the still-live local reference `r`
      // rather than only nulling the field, so a live mic track can never
      // outlive the object that was the only handle on it.
      r.cancel();
      recorder = null;
      setState('idle');
      host.write(`\r\n\x1b[33m[voice: ${termSafe((e as Error).message || 'microphone unavailable')}]\x1b[0m\r\n`);
    }
  }

  async function finish(): Promise<void> {
    const r = recorder;
    if (!r || busy) return;
    recorder = null;
    busy = true;
    setState('working');
    try {
      const wav = await r.stop();
      // A 44-byte WAV is header-only — no PCM samples were ever captured
      // (the recorder was cancelled/stopped before it finished starting, or
      // was stopped inside a single audio frame). Skip the round trip rather
      // than cold-spawning the whisper engine (up to 120s on a cold start) to
      // transcribe silence for a stray tap.
      if (wav.byteLength <= 44) return;
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }));
      if (!res.text) {
        host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.injected) {
        // A refused injection must never cost the user what they said, on
        // EITHER path — a busy pane and a genuine injection error land in the
        // same !res.injected branch, but only 'busy' is actually a busy pane;
        // misreporting a real error as "pane busy" would hide the failure.
        host.copy(res.text);
        const why = res.mode === 'busy'
          ? 'pane busy — transcript copied to clipboard'
          : 'injection failed — transcript copied to clipboard';
        host.write(`\r\n\x1b[33m[voice: ${why}]\x1b[0m\r\n`);
      }
    } catch (e) {
      host.write(`\r\n\x1b[33m[voice failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
    } finally {
      busy = false;
      setState('idle');
    }
  }

  return {
    begin,
    finish,
    // Whether a recording is currently in flight (mic live or already handed
    // off to finish()'s transcription round trip). terminal.ts's keyup
    // handler consults this before treating a bare Ctrl/Shift release as the
    // "stop" half of the chord, so an ordinary Ctrl/Shift keyup outside a
    // recording (e.g. after typing a capital letter) is left alone.
    recording(): boolean { return recorder !== null || busy; },
    cancel(): void { recorder?.cancel(); recorder = null; setState('idle'); },
    mount(parent: HTMLElement, verdict: VoiceVerdict): void {
      button = document.createElement('button');
      button.className = 'voice-btn';
      button.type = 'button';
      if (!verdict.ok) {
        button.disabled = true;
        button.title = `${verdict.reason} ${verdict.hint}`.trim();
      } else {
        button.addEventListener('mousedown', () => { void begin(); });
        button.addEventListener('mouseup', () => { void finish(); });
        button.addEventListener('mouseleave', () => { void finish(); });
      }
      setState('idle');
      parent.appendChild(button);
    },
    dispose(): void { recorder?.cancel(); recorder = null; button?.remove(); button = null; },
  };
}

// Mirrors wireUploads(parent, term, boxId): attaches to the terminal's parent
// element and returns something whose dispose() the caller folds into its own.
// openTerminal is synchronous, so the readiness fetch happens in the
// background and the button appears once the server has answered.
export function wireVoice(parent: HTMLElement, boxId: string, host: VoiceHost) {
  let controller: ReturnType<typeof createVoiceController> | null = null;
  let disposed = false;
  // Set alongside `controller` once the readiness verdict is known, so
  // ready() can reflect it (see below) without re-deriving detectVoiceEnv.
  let verdictOk = false;

  void api.uiConfig().then((cfg) => {
    // No microphone at all when the server has voice off: a button that only
    // ever 503s is worse than no button.
    if (disposed || !cfg?.voice) return;
    const verdict = evaluateVoice(detectVoiceEnv(true));
    controller = createVoiceController(boxId, cfg.voiceMaxSeconds ?? 120, host);
    controller.mount(parent, verdict);
    verdictOk = verdict.ok;
  }).catch(() => {});

  // Alt-tab (or any other focus loss) fires no keyup at all for a held
  // chord, so a mid-recording blur is the one "stop" trigger that can't come
  // through the keyboard handler. Finishing (not cancelling) mirrors the
  // capTimer auto-stop: transcribe whatever was captured rather than
  // discarding it. Harmless when nothing is recording — finish() itself
  // no-ops without a live recorder.
  const onBlur = (): void => { controller?.finish(); };
  if (typeof window !== 'undefined') window.addEventListener('blur', onBlur);

  return {
    // True once a controller is actually mounted AND the readiness verdict
    // was ok — false while the /api/ui-config readiness fetch is still in
    // flight, false when the server has voice off, and false when a
    // controller mounted but evaluateVoice said no (e.g. plain HTTP: the
    // button correctly renders disabled with the secure-context reason, but
    // without this check the hotkey would still call begin() and hit a raw
    // getUserMedia TypeError instead of falling through to xterm and letting
    // the user hit the same disabled-button reason/hint). terminal.ts's key
    // handler consults this so the hotkey isn't swallowed with no controller
    // able to act on it either way.
    ready(): boolean { return controller !== null && verdictOk; },
    recording(): boolean { return controller?.recording() ?? false; },
    begin(): void { void controller?.begin(); },
    finish(): void { void controller?.finish(); },
    dispose(): void {
      disposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
      controller?.dispose();
      controller = null;
    },
  };
}
