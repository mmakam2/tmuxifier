import { test, expect } from 'vitest';
import { createPcmStream, FRAME_BYTES, LINK_RATE } from '../src/web/pcmStream';
import { resampleTo16k } from '../src/web/wavEncode';

function sine(seconds, rate, hz = 440) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
function blocks(samples, size) {
  const out = [];
  for (let i = 0; i < samples.length; i += size) out.push(samples.subarray(i, i + size));
  return out;
}
function s16(frames) {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  const dv = new DataView(all.buffer);
  const v = new Float32Array(all.length / 2);
  for (let i = 0; i < v.length; i++) v[i] = dv.getInt16(i * 2, true) / 32767;
  return v;
}

test('emits whole 640-byte frames and carries the remainder', () => {
  const st = createPcmStream(48000);
  const frames = st.push(sine(0.1, 48000));            // 4800 in → 1600 out samples = 3200 B = 5 frames
  expect(frames.map((f) => f.length)).toEqual([640, 640, 640, 640, 640]);
  expect(FRAME_BYTES).toBe(640);
  expect(LINK_RATE).toBe(16000);
});

test('16 kHz input passes through sample-exact', () => {
  const st = createPcmStream(16000);
  // 640 samples: the last one is held until the next block (interpolation
  // needs its right neighbour), so one full 320-sample frame is emitted.
  const src = sine(0.04, 16000);
  const got = s16(st.push(src));
  expect(got.length).toBe(320);
  for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - src[i])).toBeLessThan(1 / 32767 + 1e-6);
});

test('chunked 48 kHz input matches the whole-buffer resampler with no seam per block', () => {
  const src = sine(0.5, 48000, 1000);
  const ref = resampleTo16k(src, 48000);
  const st = createPcmStream(48000);
  const frames = [];
  for (const b of blocks(src, 128)) frames.push(...st.push(b));   // AudioWorklet block size
  const got = s16(frames);
  // Whole frames only: 7999 resampled samples → 24 full frames (7680).
  expect(got.length).toBe(Math.floor((ref.length - 1) / 320) * 320);
  for (let i = 0; i < got.length && i < ref.length - 1; i++) {
    expect(Math.abs(got[i] - ref[i])).toBeLessThan(2 / 32767);
  }
});

test('44.1 kHz input keeps its fractional phase across blocks', () => {
  const src = sine(0.3, 44100, 700);
  const ref = resampleTo16k(src, 44100);
  const st = createPcmStream(44100);
  const frames = [];
  for (const b of blocks(src, 128)) frames.push(...st.push(b));
  const got = s16(frames);
  for (let i = 0; i < got.length && i < ref.length - 1; i++) {
    expect(Math.abs(got[i] - ref[i])).toBeLessThan(2 / 32767);
  }
});

test('clamps out-of-range samples and never emits an odd byte count', () => {
  const st = createPcmStream(16000);
  const loud = new Float32Array(640).fill(3);
  const frames = st.push(loud);
  const v = s16(frames);
  expect(v.every((x) => x === 1)).toBe(true);
  const st2 = createPcmStream(48000);
  let total = 0;
  for (const b of blocks(sine(0.2, 48000), 100)) for (const f of st2.push(b)) total += f.length;
  expect(total % 640).toBe(0);
});

test('rejects an invalid input rate or frame size', () => {
  expect(() => createPcmStream(0)).toThrow();
  expect(() => createPcmStream(48000, { frameBytes: 641 })).toThrow();
});
