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

// Ctrl+Shift+Space. Deliberately not Ctrl+Shift+V — clipboard.ts already claims
// that for paste. `repeat` is excluded because a held key auto-repeats keydown,
// which would otherwise read as a stream of fresh presses.
export function isVoiceHotkey(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown' && ev.type !== 'keyup') return false;
  if (ev.repeat) return false;
  if (!ev.ctrlKey || !ev.shiftKey || ev.metaKey || ev.altKey) return false;
  return ev.code === 'Space';
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
export function createVoiceController(boxId: string, maxSeconds: number, host: VoiceHost) {
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
    const r = createVoiceRecorder(maxSeconds, () => { void finish(); });
    recorder = r;
    try {
      await r.start();
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

  void api.uiConfig().then((cfg) => {
    // No microphone at all when the server has voice off: a button that only
    // ever 503s is worse than no button.
    if (disposed || !cfg?.voice) return;
    const verdict = evaluateVoice(detectVoiceEnv(true));
    controller = createVoiceController(boxId, cfg.voiceMaxSeconds ?? 120, host);
    controller.mount(parent, verdict);
  }).catch(() => {});

  return {
    // True once a controller is actually mounted — false while the
    // /api/ui-config readiness fetch is still in flight, and permanently false
    // when the server has voice off. terminal.ts's key handler consults this
    // so the hotkey isn't swallowed with no explanation when voice can't act
    // on it anyway.
    ready(): boolean { return controller !== null; },
    begin(): void { void controller?.begin(); },
    finish(): void { void controller?.finish(); },
    dispose(): void { disposed = true; controller?.dispose(); controller = null; },
  };
}
