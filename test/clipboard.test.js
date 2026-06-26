import { test, expect, vi } from 'vitest';
import {
  clipboardActionForKey,
  writeClipboard,
  readClipboard,
} from '../src/web/clipboard.ts';

const MAC = { mac: true };
const PC = { mac: false };

// --- clipboardActionForKey: classify a key event as copy/paste/none ---------

test('mac: Cmd+C copies', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'c', metaKey: true, ctrlKey: false, shiftKey: false }, MAC)).toBe('copy');
});

test('mac: Cmd+V is left to xterm native paste (none) so we never regress the working mac path', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'v', metaKey: true, ctrlKey: false, shiftKey: false }, MAC)).toBe('none');
});

test('mac: plain Ctrl+C stays SIGINT, not copy', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'c', metaKey: false, ctrlKey: true, shiftKey: false }, MAC)).toBe('none');
});

test('mac: Cmd+Shift+C is not the standard copy combo', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'c', metaKey: true, ctrlKey: false, shiftKey: true }, MAC)).toBe('none');
});

test('pc: Ctrl+Shift+C copies (key arrives uppercase under shift)', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'C', metaKey: false, ctrlKey: true, shiftKey: true }, PC)).toBe('copy');
});

test('pc: Ctrl+Shift+V pastes', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'V', metaKey: false, ctrlKey: true, shiftKey: true }, PC)).toBe('paste');
});

test('pc: bare Ctrl+C must pass through as SIGINT (not copy)', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'c', metaKey: false, ctrlKey: true, shiftKey: false }, PC)).toBe('none');
});

test('pc: bare Ctrl+V must pass through as a literal byte (not paste)', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'v', metaKey: false, ctrlKey: true, shiftKey: false }, PC)).toBe('none');
});

test('keyup of a copy combo is ignored so a single press fires once', () => {
  expect(clipboardActionForKey({ type: 'keyup', key: 'c', metaKey: true, ctrlKey: false, shiftKey: false }, MAC)).toBe('none');
});

test('an unrelated key with modifiers is none', () => {
  expect(clipboardActionForKey({ type: 'keydown', key: 'a', metaKey: false, ctrlKey: true, shiftKey: true }, PC)).toBe('none');
});

// --- writeClipboard: async clipboard API with secure-context fallback -------

test('writeClipboard: empty selection is a no-op and never touches the clipboard', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const fallbackCopy = vi.fn(() => true);
  expect(await writeClipboard('', { clipboard: { writeText }, fallbackCopy })).toBe(false);
  expect(writeText).not.toHaveBeenCalled();
  expect(fallbackCopy).not.toHaveBeenCalled();
});

test('writeClipboard: uses the async Clipboard API when available', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const fallbackCopy = vi.fn(() => true);
  expect(await writeClipboard('hello', { clipboard: { writeText }, fallbackCopy })).toBe(true);
  expect(writeText).toHaveBeenCalledWith('hello');
  expect(fallbackCopy).not.toHaveBeenCalled();
});

test('writeClipboard: falls back to execCommand when the Clipboard API rejects (e.g. not focused)', async () => {
  const writeText = vi.fn(() => Promise.reject(new Error('NotAllowed')));
  const fallbackCopy = vi.fn(() => true);
  expect(await writeClipboard('hello', { clipboard: { writeText }, fallbackCopy })).toBe(true);
  expect(fallbackCopy).toHaveBeenCalledWith('hello');
});

test('writeClipboard: uses the fallback when there is no Clipboard API (insecure context / plain HTTP)', async () => {
  const fallbackCopy = vi.fn(() => true);
  expect(await writeClipboard('hello', { fallbackCopy })).toBe(true);
  expect(fallbackCopy).toHaveBeenCalledWith('hello');
});

test('writeClipboard: returns false when neither path is available', async () => {
  expect(await writeClipboard('hello', {})).toBe(false);
});

// --- readClipboard: read for the explicit paste shortcut --------------------

test('readClipboard: returns clipboard text when readText is available', async () => {
  const readText = vi.fn(() => Promise.resolve('pasted'));
  expect(await readClipboard({ clipboard: { readText } })).toBe('pasted');
});

test('readClipboard: returns empty string when reading is unavailable (insecure context)', async () => {
  expect(await readClipboard({})).toBe('');
});
