// Microphone capture for voice dictation. Raw Float32 frames are collected via
// an AudioWorklet and encoded to 16 kHz mono WAV by the pure wavEncode module,
// so whisper receives its native format and no ffmpeg is needed server-side.

import { encodeWav } from './wavEncode';

// Inlined as a Blob URL rather than a separate asset: Vite would otherwise need
// a worklet entry point, and the module is four lines.
const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tmuxifier-capture', Cap);
`;

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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext();
      rate = ctx.sampleRate;   // device-dependent: commonly 48000, often 44100
      chunks = [];
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      node = new AudioWorkletNode(ctx, 'tmuxifier-capture');
      node.port.onmessage = (e: MessageEvent) => { chunks.push(e.data as Float32Array); };
      ctx.createMediaStreamSource(stream).connect(node);
      // Transcribe what was captured rather than discarding it: never lose
      // speech to a forgotten key.
      capTimer = setTimeout(onAutoStop, maxSeconds * 1000);
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
