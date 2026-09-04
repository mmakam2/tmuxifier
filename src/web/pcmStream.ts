//
// Streaming counterpart of wavEncode.ts for the voice link: Float32 blocks at
// the device rate in, 16 kHz S16 mono frames out, as they arrive. The same
// linear interpolation as resampleTo16k, but stateful — the fractional
// resampling position and the previous block's last sample survive between
// push() calls, so a 128-sample AudioWorklet block boundary produces no seam.
// Frames are a fixed size (20 ms) so the server's per-frame caps and the
// box-side writer's even-length invariant hold by construction.

export const LINK_RATE = 16000;
export const FRAME_BYTES = 640;   // 20 ms of 16 kHz S16 mono

export interface PcmStream {
  push(block: Float32Array): Uint8Array[];
}

export function createPcmStream(inputRate: number, opts: { outRate?: number; frameBytes?: number } = {}): PcmStream {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('invalid input sample rate');
  const outRate = opts.outRate ?? LINK_RATE;
  const frameBytes = opts.frameBytes ?? FRAME_BYTES;
  if (!Number.isInteger(frameBytes) || frameBytes < 2 || frameBytes % 2 !== 0) throw new Error('frameBytes must be a positive even integer');
  const ratio = inputRate / outRate;
  // Position of the next output sample, in input samples, relative to the
  // start of the current block. Index -1 addresses `prev`, the last sample of
  // the previous block, which is how interpolation reaches across the seam.
  let pos = 0;
  let prev = 0;
  let hasPrev = false;
  let pending = new Uint8Array(frameBytes);
  let filled = 0;
  return {
    push(block: Float32Array): Uint8Array[] {
      const frames: Uint8Array[] = [];
      const n = block.length;
      if (n === 0) return frames;
      let p = pos;
      for (;;) {
        const i = Math.floor(p);
        const j = i + 1;
        if (j > n - 1) break;              // need both samples i and j within block (i, j < n)
        const frac = p - i;
        const s0 = i < 0 ? (hasPrev ? prev : block[0]) : block[i];
        const s1 = block[j];
        const s = s0 + (s1 - s0) * frac;
        const c = Math.max(-1, Math.min(1, s));
        const v = c < 0 ? c * 0x8000 : c * 0x7fff;
        const vi = Math.trunc(v);
        pending[filled++] = vi & 0xff;
        pending[filled++] = (vi >> 8) & 0xff;
        if (filled === frameBytes) {
          frames.push(pending);
          pending = new Uint8Array(frameBytes);
          filled = 0;
        }
        p += ratio;
      }
      pos = p - n;
      prev = block[n - 1];
      hasPrev = true;
      return frames;
    },
  };
}
