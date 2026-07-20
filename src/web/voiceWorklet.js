// AudioWorklet processor for voice dictation capture. Loaded by voiceRecorder.ts
// via `?url` so Vite emits this as a real, content-hashed, same-origin static
// asset — `ctx.audioWorklet.addModule()` then loads it under CSP's
// `script-src 'self'` with no `blob:` widening required. Must stay plain
// JavaScript: Vite's `?url` import does not transpile TypeScript.
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tmuxifier-capture', Cap);
