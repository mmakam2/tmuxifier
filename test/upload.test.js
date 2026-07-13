import { test, expect } from 'vitest';
import {
  sanitizeUploadName,
  uploadName,
  filesFromDataTransfer,
  sizeError,
  termSafe,
} from '../src/web/upload';

test('sanitizeUploadName keeps safe names and coerces unsafe ones', () => {
  expect(sanitizeUploadName('shot.png')).toBe('shot.png');
  expect(sanitizeUploadName('My Report (final).pdf')).toBe('My Report _final_.pdf');
  expect(sanitizeUploadName('.env')).toBe('env');
  expect(sanitizeUploadName('---weird')).toBe('weird');
  // Cyrillic chars all map to '_', which the leading-junk trim then strips.
  expect(sanitizeUploadName('док.png')).toBe('png');
  expect(sanitizeUploadName('')).toBe('');
  expect(sanitizeUploadName('x'.repeat(300)).length).toBeLessThanOrEqual(128);
});

test('uploadName uses the sanitized filename when present', () => {
  expect(uploadName({ name: 'shot.png', type: 'image/png' }, 1760000000000)).toBe('shot.png');
});

test('uploadName synthesizes pasted-<ts>.<ext> for nameless clipboard images', () => {
  expect(uploadName({ name: '', type: 'image/png' }, 1760000000000)).toBe('pasted-1760000000000.png');
  expect(uploadName({ type: 'image/jpeg' }, 5)).toBe('pasted-5.jpg');
  expect(uploadName({ type: 'application/x-thing' }, 5)).toBe('pasted-5.bin');
});

test('filesFromDataTransfer prefers items, falls back to files, tolerates null', () => {
  const f1 = { name: 'a.png' };
  const f2 = { name: 'b.txt' };
  const viaItems = filesFromDataTransfer({
    items: [
      { kind: 'file', getAsFile: () => f1 },
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f2 },
    ],
  });
  expect(viaItems).toEqual([f1, f2]);
  expect(filesFromDataTransfer({ files: [f1] })).toEqual([f1]);
  expect(filesFromDataTransfer(null)).toEqual([]);
  expect(filesFromDataTransfer({ items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
});

test('sizeError reports MB over-limit, null when within', () => {
  expect(sizeError(10, 100)).toBeNull();
  expect(sizeError(26 * 1024 * 1024, 25 * 1024 * 1024)).toBe('file too large (max 25 MB)');
});

test('termSafe strips escape sequences and control chars', () => {
  expect(termSafe('ok message 1.2')).toBe('ok message 1.2');
  expect(termSafe('bad\x1b[31mred\x07')).toBe('bad[31mred');
});
