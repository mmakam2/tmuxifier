import { test, expect } from 'vitest';
import { encodeWav, resampleTo16k, TARGET_RATE } from '../src/web/wavEncode';

function sine(seconds, rate, hz = 440) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

const view = (buf) => new DataView(buf);
const ascii = (buf, off, len) => String.fromCharCode(...new Uint8Array(buf, off, len));

test('writes a RIFF/WAVE header describing 16 kHz mono 16-bit PCM', () => {
  const buf = encodeWav([sine(1, 48000)], 48000);
  const dv = view(buf);
  expect(ascii(buf, 0, 4)).toBe('RIFF');
  expect(ascii(buf, 8, 4)).toBe('WAVE');
  expect(ascii(buf, 12, 4)).toBe('fmt ');
  expect(dv.getUint32(16, true)).toBe(16);      // PCM fmt chunk size
  expect(dv.getUint16(20, true)).toBe(1);       // format = PCM
  expect(dv.getUint16(22, true)).toBe(1);       // mono
  expect(dv.getUint32(24, true)).toBe(TARGET_RATE);
  expect(dv.getUint32(28, true)).toBe(TARGET_RATE * 2); // byte rate
  expect(dv.getUint16(32, true)).toBe(2);       // block align
  expect(dv.getUint16(34, true)).toBe(16);      // bits per sample
  expect(ascii(buf, 36, 4)).toBe('data');
});

test('declared sizes match the actual buffer length', () => {
  const buf = encodeWav([sine(0.5, 48000)], 48000);
  const dv = view(buf);
  expect(dv.getUint32(4, true)).toBe(buf.byteLength - 8);   // RIFF size
  expect(dv.getUint32(40, true)).toBe(buf.byteLength - 44); // data size
});

test('resamples from both common device rates', () => {
  // AudioContext.sampleRate is device-dependent — 44100 is as common as 48000.
  for (const rate of [48000, 44100]) {
    const buf = encodeWav([sine(1, rate)], rate);
    const samples = (buf.byteLength - 44) / 2;
    expect(samples).toBeGreaterThan(TARGET_RATE * 0.98);
    expect(samples).toBeLessThan(TARGET_RATE * 1.02);
  }
});

test('passes 16 kHz input through without resampling', () => {
  const src = sine(1, 16000);
  expect(resampleTo16k(src, 16000)).toBe(src);
});

test('joins multiple captured chunks in order', () => {
  const a = new Float32Array([1, 1, 1, 1]);
  const b = new Float32Array([-1, -1, -1, -1]);
  const buf = encodeWav([a, b], 16000);
  const dv = view(buf);
  expect(dv.getInt16(44, true)).toBe(32767);      // clamped +1.0
  expect(dv.getInt16(44 + 4 * 2, true)).toBe(-32768); // clamped -1.0
});

test('clamps out-of-range samples instead of wrapping', () => {
  const buf = encodeWav([new Float32Array([2.5, -2.5, 0])], 16000);
  const dv = view(buf);
  expect(dv.getInt16(44, true)).toBe(32767);
  expect(dv.getInt16(46, true)).toBe(-32768);
  expect(dv.getInt16(48, true)).toBe(0);
});

test('produces a header-only file for no input', () => {
  expect(encodeWav([], 48000).byteLength).toBe(44);
});

// The tests above either check output length only, or feed 16 kHz input,
// which hits resampleTo16k's identity shortcut and never runs the
// interpolation loop. The tests below assert actual sample *values* coming
// out of that loop, at a non-16k input rate.

test('resamples a rising ramp with interpolated values, not truncation', () => {
  // A broken resampler that merely truncated the raw samples — e.g.
  // `samples.slice(0, Math.floor(samples.length / ratio))` — would produce
  // an output of exactly the same LENGTH as a real resample (both are
  // samples.length / ratio samples long), so a length-only check can't tell
  // them apart. But a truncated ramp's last output sample would just be the
  // input's sample at index samples.length / ratio, i.e. still only about a
  // third of the way up the ramp (~0.333, ~10922 as Int16) — not the input's
  // true final value near 1.0. A rising ramp exposes this: only a resampler
  // that actually walks the full input produces an output that also rises
  // across its full range.
  const n = 48000; // 1 second at 48000 Hz
  const ramp = new Float32Array(n);
  for (let i = 0; i < n; i++) ramp[i] = i / (n - 1); // 0.0 -> 1.0

  const buf = encodeWav([ramp], 48000);
  const dv = view(buf);
  const outSamples = (buf.byteLength - 44) / 2;
  const readInt16 = (i) => dv.getInt16(44 + i * 2, true);

  const tolerance = 350; // ~1% of full scale (32767); tight enough that a
                          // truncated ~1/3-scale reading (~10922) still fails
  const first = readInt16(0);
  const middle = readInt16(Math.floor(outSamples / 2));
  const last = readInt16(outSamples - 1);

  expect(Math.abs(first - 0)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(middle - 16383)).toBeLessThanOrEqual(tolerance); // ~0.5
  expect(Math.abs(last - 32767)).toBeLessThanOrEqual(tolerance); // ~1.0
});

test('interpolates a constant signal to a constant output', () => {
  // Interpolating between two equal neighbours must return that same value,
  // regardless of the fractional position between them — this catches a
  // resampler whose interpolation weighting (the `frac`/`1 - frac` terms) is
  // wrong, since a weighting bug would still show up even on a flat signal.
  const n = Math.round(0.1 * 44100);
  const constant = new Float32Array(n).fill(0.5);

  const buf = encodeWav([constant], 44100);
  const dv = view(buf);
  const outSamples = (buf.byteLength - 44) / 2;
  const readInt16 = (i) => dv.getInt16(44 + i * 2, true);

  const tolerance = 50;
  for (const i of [0, 1, Math.floor(outSamples / 4), Math.floor(outSamples / 2), outSamples - 1]) {
    expect(Math.abs(readInt16(i) - 16383)).toBeLessThanOrEqual(tolerance); // ~0.5
  }
});

test('inputRate genuinely drives the resample, not just the header', () => {
  // Same input sample count, two different declared input rates: if
  // inputRate were ignored (or only used to pick the identity shortcut),
  // both would produce identical-length output. A real resample must scale
  // by the input rate, so 48000 and 44100 input must land on different
  // output lengths.
  const n = 48000;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin(i);

  const outAt48k = resampleTo16k(samples, 48000).length;
  const outAt44k = resampleTo16k(samples, 44100).length;

  expect(outAt48k).not.toBe(outAt44k);
});
