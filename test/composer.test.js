import { test, expect } from 'vitest';
import { sendTextOf } from '../src/web/composer';

// A raw newline reaching the pty IS Enter — it would submit mid-text. The
// composer collapses instead, the same rule voiceText.js applies server-side
// to transcripts, because Send means "one message, one Enter".
test('newline runs collapse to single spaces', () => {
  expect(sendTextOf('fix the login bug\nthen run the tests')).toBe('fix the login bug then run the tests');
  expect(sendTextOf('a\r\n\r\nb')).toBe('a b');
});

test('tabs and space runs collapse too — a tab at a shell prompt triggers completion', () => {
  expect(sendTextOf('a\t\tb   c')).toBe('a b c');
});

test('non-whitespace control characters are stripped', () => {
  // ESC survives \s-collapse (it is not whitespace); left in, a pasted
  // artefact could open an escape sequence in the pane.
  expect(sendTextOf('a\u001bb')).toBe('ab');
  expect(sendTextOf('a\u007fb')).toBe('ab');
});

test('trims, and an empty or whitespace-only draft normalizes to empty (bare-Enter send)', () => {
  expect(sendTextOf('  hi  ')).toBe('hi');
  expect(sendTextOf('')).toBe('');
  expect(sendTextOf(' \n \t ')).toBe('');
});
