// Pure PCM → WAV encoding for voice dictation. Like upload.ts and clipboard.ts,
// no DOM or global access — the caller hands in the captured sample chunks — so
// this is unit-testable in Node.
//
// This module is why Tmuxifier needs no ffmpeg: whisper.cpp wants 16 kHz mono
// 16-bit PCM, and the browser can produce exactly that from raw Web Audio
// samples. Encoding server-side would have meant decoding MediaRecorder's
// webm/opus, i.e. an ffmpeg system dependency.

export const TARGET_RATE = 16000;

// Linear interpolation. Good enough for speech at these rates, and far cheaper
// than a windowed-sinc filter; whisper's own frontend is tolerant of the
// aliasing this leaves behind.
//
// inputRate is a parameter, not an assumption: AudioContext.sampleRate is
// device-dependent (commonly 48000, but 44100 on plenty of hardware), so this
// must handle an arbitrary input rate. 16000 input passes through untouched.
export function resampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('invalid input sample rate');
  if (inputRate === TARGET_RATE) return samples;
  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function writeAscii(dv: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(chunks: Float32Array[], inputRate: number): ArrayBuffer {
  const resampled = resampleTo16k(concat(chunks), inputRate);
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const dv = new DataView(buffer);

  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);            // PCM chunk size
  dv.setUint16(20, 1, true);             // format: PCM
  dv.setUint16(22, 1, true);             // channels: mono
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true); // byte rate = rate * blockAlign
  dv.setUint16(32, 2, true);             // block align = channels * bytesPerSample
  dv.setUint16(34, 16, true);            // bits per sample
  writeAscii(dv, 36, 'data');
  dv.setUint32(40, resampled.length * 2, true);

  // Clamp before scaling: a sample outside [-1, 1] would otherwise wrap and
  // turn a loud syllable into a burst of noise. Int16 range is asymmetric
  // ([-32768, 32767]), so negative samples scale by 0x8000 and positive ones
  // by 0x7fff.
  for (let i = 0; i < resampled.length; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
