// Microphone capture for voice dictation. Raw Float32 frames are collected via
// an AudioWorklet and encoded to 16 kHz mono WAV by the pure wavEncode module,
// so whisper receives its native format and no ffmpeg is needed server-side.

import { encodeWav } from './wavEncode';
// `?url` makes Vite emit voiceWorklet.js as a real, content-hashed, same-origin
// static asset rather than bundling it — addModule() needs a URL to fetch, and
// this keeps that fetch same-origin so CSP's `script-src 'self'` covers it with
// no `blob:` widening (see voiceWorklet.js and the CSP comment in server.js).
import workletUrl from './voiceWorklet.js?url';

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
  recording(): boolean;
}

export function createVoiceRecorder(maxSeconds: number, onAutoStop: () => void): VoiceRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let chunks: Float32Array[] = [];
  let rate = 0;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  function teardown(): void {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    try { node?.disconnect(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { void ctx?.close(); } catch {}
    node = null; stream = null; ctx = null;
  }

  return {
    recording: () => ctx !== null,

    async start(): Promise<void> {
      if (ctx) return;
      // getUserMedia() resolving makes the mic LIVE (the browser's recording
      // indicator lights up) before any of the AudioContext/AudioWorklet setup
      // below runs. If any of that setup throws — addModule() is the realistic
      // failure point — the mic must not stay live with no reference left to
      // stop it, so any throw from here on tears everything down before
      // rethrowing.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        ctx = new AudioContext();
        rate = ctx.sampleRate;   // device-dependent: commonly 48000, often 44100
        chunks = [];
        await ctx.audioWorklet.addModule(workletUrl);
        node = new AudioWorkletNode(ctx, 'tmuxifier-capture');
        node.port.onmessage = (e: MessageEvent) => { chunks.push(e.data as Float32Array); };
        ctx.createMediaStreamSource(stream).connect(node);
        // Transcribe what was captured rather than discarding it: never lose
        // speech to a forgotten key.
        capTimer = setTimeout(onAutoStop, maxSeconds * 1000);
      } catch (e) {
        teardown();
        throw e;
      }
    },

    async stop(): Promise<ArrayBuffer> {
      const captured = chunks;
      const captureRate = rate;
      chunks = [];
      teardown();
      return encodeWav(captured, captureRate || 48000);
    },

    cancel(): void {
      chunks = [];
      teardown();
    },
  };
}
