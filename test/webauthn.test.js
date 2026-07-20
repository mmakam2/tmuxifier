import { test, expect } from 'vitest';
import { cborDecodeFirst } from '../src/server/webauthn.js';
import { enc } from './helpers/cbor.js';

test('decodes unsigned and negative integers across width boundaries', () => {
  for (const n of [0, 23, 24, 255, 256, 65535, 65536, -1, -24, -25, -256]) {
    expect(cborDecodeFirst(enc(n)).value).toBe(n);
  }
});

test('decodes byte strings, text strings, arrays and maps', () => {
  expect(cborDecodeFirst(enc(Buffer.from('abc'))).value.equals(Buffer.from('abc'))).toBe(true);
  expect(cborDecodeFirst(enc('none')).value).toBe('none');
  expect(cborDecodeFirst(enc([1, 2, 3])).value).toEqual([1, 2, 3]);
  const m = cborDecodeFirst(enc(new Map([['fmt', 'none'], [1, 2]]))).value;
  expect(m.get('fmt')).toBe('none');
  expect(m.get(1)).toBe(2);
});

test('reports the offset just past the decoded item so trailing bytes can be trimmed', () => {
  const buf = Buffer.concat([enc(new Map([[1, 2]])), Buffer.from([0xff, 0xff])]);
  const { end } = cborDecodeFirst(buf);
  expect(end).toBe(buf.length - 2);
});

test('rejects indefinite-length items rather than guessing', () => {
  expect(() => cborDecodeFirst(Buffer.from([0x5f, 0xff]))).toThrow(/indefinite/);
});

test('rejects truncated input', () => {
  expect(() => cborDecodeFirst(Buffer.from([0x43, 0x01]))).toThrow(/truncated/);
});

test('rejects duplicate map keys', () => {
  expect(() => cborDecodeFirst(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/);
});

test('rejects unsupported major types (tags, floats, simple values)', () => {
  expect(() => cborDecodeFirst(Buffer.from([0xc0, 0x00]))).toThrow(/major type/);
  expect(() => cborDecodeFirst(Buffer.from([0xf5]))).toThrow(/major type/);
});

// Legitimate attestation objects and COSE keys nest 2-3 levels deep. 50
// repeated single-element-array headers is comfortably past any sane bound
// while still leaving plenty of buffer left over, so a wrong depth check
// would show up as either a missing throw or a "truncated" error instead of
// this one.
test('rejects excessively nested input with a descriptive error instead of overflowing the stack', () => {
  const buf = Buffer.concat([Buffer.alloc(50, 0x81), Buffer.from([0x00])]);
  expect(() => cborDecodeFirst(buf)).toThrow(/cbor: nesting too deep/);
});

// The shared test/helpers/cbor.js encoder tops out at the 4-byte (ai=26)
// length form because no existing fixture needs a value that large; these
// hand-roll the 8-byte (ai=27) header directly instead of growing the shared
// encoder for one edge case.
function u64Item(major, n) {
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

test('decodes a small value in the 8-byte (ai=27) form for both integer major types', () => {
  expect(cborDecodeFirst(u64Item(0, 42)).value).toBe(42);
  expect(cborDecodeFirst(u64Item(1, 42)).value).toBe(-43);
});

test('accepts an unsigned integer exactly at Number.MAX_SAFE_INTEGER in the 8-byte form', () => {
  expect(cborDecodeFirst(u64Item(0, Number.MAX_SAFE_INTEGER)).value).toBe(Number.MAX_SAFE_INTEGER);
});

test('rejects an unsigned integer one past Number.MAX_SAFE_INTEGER in the 8-byte form', () => {
  expect(() => cborDecodeFirst(u64Item(0, Number.MAX_SAFE_INTEGER + 1))).toThrow(/integer too large/);
});

test('the 8-byte integer-too-large guard also fires through the negative-integer major type', () => {
  expect(() => cborDecodeFirst(u64Item(1, Number.MAX_SAFE_INTEGER + 1))).toThrow(/integer too large/);
});

// `end` is what a later task uses to trim trailing extension data following a
// COSE public key. A COSE EC key's 32-byte X/Y coordinates need the
// multi-byte (ai=24) length header decoded correctly *inside a map* — the
// only existing `end` test above uses a flat, all-primitive map.
test('end is correct for a map containing a 32-byte byte string (the COSE coordinate shape)', () => {
  const coords = Buffer.alloc(32, 0xab);
  const encoded = enc(new Map([[-2, coords]]));
  // 1-byte map header + 1-byte key + (2-byte length header + 32 data bytes) value.
  expect(encoded.length).toBe(36);
  expect(cborDecodeFirst(encoded).end).toBe(36);

  const withTrailer = Buffer.concat([encoded, Buffer.from([0xff, 0xff])]);
  expect(cborDecodeFirst(withTrailer).end).toBe(36);
});

test('end is correct for a nested array/map/array structure', () => {
  const encoded = enc([new Map([[1, [2, 3]]])]);
  // outer array(1) header + map(1) header + key + inner array(2) header + 2 elements.
  expect(encoded.length).toBe(6);
  const { value, end } = cborDecodeFirst(encoded);
  expect(end).toBe(6);
  expect(value[0].get(1)).toEqual([2, 3]);

  const withTrailer = Buffer.concat([encoded, Buffer.from([0xff, 0xff])]);
  expect(cborDecodeFirst(withTrailer).end).toBe(6);
});
