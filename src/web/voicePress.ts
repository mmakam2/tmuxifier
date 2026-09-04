//
// The one 🎤 button's decision logic (spec 2026-09-04), as a pure reducer so
// every ordering of press, release, verdict, ready, refused and closed is a
// unit test rather than a race in a browser. The controller in voiceUi.ts
// owns the side effects the reducer names.
//
//   idle ─press─▶ probing ─verdict(claude)─▶ linking ─ready─▶ live
//                    │                          │refused         │press/closed
//                    └verdict(other)─▶ recording ─release─▶ working ─done─▶ idle
//
// `released` remembers a release that lands before the verdict: a Claude pane
// still links (the press was a tap), anything else finishes dictation at
// once. A refused link falls back to dictation with the audio the recorder
// buffered while the link was attempted — nothing said is lost.

export type PressState = 'idle' | 'probing' | 'recording' | 'working' | 'linking' | 'live';
export type PaneKind = 'claude' | 'codex' | 'shell' | 'busy' | 'error';
export type PressEvent =
  | { t: 'press' }
  | { t: 'release' }
  | { t: 'verdict'; kind: PaneKind }
  | { t: 'ready' }
  | { t: 'refused' }
  | { t: 'done' }
  | { t: 'closed' };
export type PressEffect =
  | 'startMic' | 'probe' | 'openLink' | 'stream' | 'finishDictation'
  | 'unlink' | 'stopMic' | 'noticeRefused' | 'noticeClosed';
export interface PressModel { state: PressState; released: boolean }

export const IDLE: PressModel = { state: 'idle', released: false };

const same = (m: PressModel) => ({ model: m, effects: [] as PressEffect[] });
const to = (state: PressState, released: boolean, effects: PressEffect[]) => ({ model: { state, released }, effects });

export function reducePress(m: PressModel, ev: PressEvent): { model: PressModel; effects: PressEffect[] } {
  switch (m.state) {
    case 'idle':
      return ev.t === 'press' ? to('probing', false, ['startMic', 'probe']) : same(m);
    case 'probing':
      if (ev.t === 'release') return to('probing', true, []);
      if (ev.t === 'verdict') {
        if (ev.kind === 'claude') return to('linking', m.released, ['openLink']);
        return m.released ? to('working', true, ['finishDictation']) : to('recording', false, []);
      }
      return same(m);
    case 'recording':
      return ev.t === 'release' ? to('working', true, ['finishDictation']) : same(m);
    case 'working':
      return ev.t === 'done' ? to('idle', false, []) : same(m);
    case 'linking':
      if (ev.t === 'release') return to('linking', true, []);
      if (ev.t === 'press') return to('idle', false, ['unlink', 'stopMic']);
      if (ev.t === 'ready') return to('live', m.released, ['stream']);
      if (ev.t === 'refused' || ev.t === 'closed') {
        return m.released ? to('working', true, ['noticeRefused', 'finishDictation']) : to('recording', false, ['noticeRefused']);
      }
      return same(m);
    case 'live':
      if (ev.t === 'press') return to('idle', false, ['unlink', 'stopMic']);
      if (ev.t === 'closed') return to('idle', false, ['stopMic', 'noticeClosed']);
      return same(m);
  }
}

export function inFlight(state: PressState): boolean { return state !== 'idle'; }

// The hotkey's second press ends whatever is in flight: a held/probing
// recording is released, a link is unlinked, a transcription in progress is
// left alone.
export function endInFlight(state: PressState): PressEvent | null {
  if (state === 'probing' || state === 'recording') return { t: 'release' };
  if (state === 'linking' || state === 'live') return { t: 'press' };
  return null;
}
