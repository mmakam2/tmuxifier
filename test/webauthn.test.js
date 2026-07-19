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
