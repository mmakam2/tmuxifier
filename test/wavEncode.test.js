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
