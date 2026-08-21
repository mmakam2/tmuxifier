import { test, expect } from 'vitest';
import { isSoleWindow, killLegend, rowKey } from '../src/web/sessionPicker.ts';
import { WINDOW_INDENT } from '../src/web/paneHeader.ts';

const s = (name) => ({ kind: 'session', value: `s:${name}`, label: name, session: name });
const w = (name, id, label) => ({ kind: 'window', value: `w:${name}:${id}`, label, session: name, windowId: id });

test('a session with one window: that window is the sole one', () => {
  const rows = [s('web'), w('web', '@1', '1: zsh'), s('other'), w('other', '@2', '1: bash'), w('other', '@3', '2: vim')];
  expect(isSoleWindow(rows, rows[1])).toBe(true);
  expect(isSoleWindow(rows, rows[3])).toBe(false);
  expect(isSoleWindow(rows, rows[4])).toBe(false);
});

test('a session row is never a sole window', () => {
  const rows = [s('web'), w('web', '@1', '1: zsh')];
  expect(isSoleWindow(rows, rows[0])).toBe(false);
});

test('the legend for a sole window says the session goes with it', () => {
  // tmux destroys a session when its last window goes. Not special-cased — but
  // not allowed to be a surprise either.
  const sole = w('web', '@1', '1: zsh');
  expect(killLegend(sole, true)).toMatch(/session/i);
  expect(killLegend(sole, false)).not.toMatch(/session/i);
});

test('the legend names what is about to die', () => {
  expect(killLegend(s('web'), false)).toContain('web');
  expect(killLegend(w('web', '@2', '2: claude'), false)).toContain('2: claude');
});

test('rowKey carries the session, so an armed row cannot migrate to another', () => {
  // A grouped session shares window objects, so '@7' alone appears under two
  // session names. Keying an arm by id alone would let a poll move the arm onto
  // a different session's row — and then fire on it.
  expect(rowKey(w('web', '@7', '1: zsh'))).not.toBe(rowKey(w('webclone', '@7', '1: zsh')));
  expect(rowKey(s('web'))).not.toBe(rowKey(w('web', '@7', '1: zsh')));
});

test('the legend strips the real window indent from labels before confirmation', () => {
  // Window labels in the dropdown are indented with WINDOW_INDENT (non-breaking
  // space + arrow). The legend must strip this so the confirmation reads
  // "kill 2: claude?" not "kill  → 2: claude?". Assert both the positive
  // (label name is in the legend) and negative (indent/arrow are not).
  const indent = WINDOW_INDENT + '2: claude';
  const legend = killLegend(w('web', '@2', indent), false);
  expect(legend).toContain('2: claude');
  expect(legend).not.toMatch(/→/);
  expect(legend).not.toContain(WINDOW_INDENT);
});
