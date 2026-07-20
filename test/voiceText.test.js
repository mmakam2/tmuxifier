import { test, expect } from 'vitest';
import { normalizeTranscript, MAX_TRANSCRIPT_CHARS } from '../src/server/voiceText.js';

test('collapses newlines to spaces so send-keys never submits early', () => {
  // whisper emits one line per segment; a newline through send-keys is Enter.
  expect(normalizeTranscript('refactor the auth middleware\nto use the new helper'))
    .toBe('refactor the auth middleware to use the new helper');
});

test('strips whisper blank-audio and timestamp markers', () => {
  expect(normalizeTranscript('[BLANK_AUDIO]')).toBe('');
  expect(normalizeTranscript('[00:00:00.000 --> 00:00:05.000]  hello there')).toBe('hello there');
});

test('strips control characters so no escape sequence reaches the pane', () => {
  expect(normalizeTranscript('run \x1b[31mmake\x1b[0m now')).toBe('run [31mmake[0m now');
  expect(normalizeTranscript('a\x00b\x07c\x7f')).toBe('abc');
});

test('keeps non-ASCII text intact', () => {
  // Unlike upload.ts termSafe (ASCII-only filenames), transcripts may be
  // legitimately non-English when a multilingual model is selected.
  expect(normalizeTranscript('café naïve 日本語')).toBe('café naïve 日本語');
});

test('collapses whitespace runs and trims', () => {
  expect(normalizeTranscript('  hello   \t  world  ')).toBe('hello world');
});

test('returns empty string for empty, whitespace, and non-string input', () => {
  expect(normalizeTranscript('')).toBe('');
  expect(normalizeTranscript('   \n  ')).toBe('');
  expect(normalizeTranscript(null)).toBe('');
  expect(normalizeTranscript(undefined)).toBe('');
});

test('caps length so one dictation cannot produce an unbounded argv', () => {
  const out = normalizeTranscript('word '.repeat(2000));
  expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
  expect(out.endsWith(' ')).toBe(false);
});
