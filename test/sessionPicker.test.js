import { test, expect } from 'vitest';
import { isSoleWindow, killLegend, rowKey, canKillTarget, renderKey } from '../src/web/sessionPicker.ts';
import { startTargetsOf } from '../src/web/agentWorkersView.ts';
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

test('start rows are neither sessions nor windows to the sole-window rule', () => {
  // A start row carries session: '' and names nothing on the box; appending them
  // must not change which window is the last of its session.
  const rows = [s('web'), w('web', '@1', '1: zsh'), s('other'), w('other', '@2', '1: bash'), w('other', '@3', '2: vim')];
  const withStarts = [...rows, ...startTargetsOf([{ name: 'api' }, { name: 'web' }])];
  for (const t of rows) expect(isSoleWindow(withStarts, t)).toBe(isSoleWindow(rows, t));
  for (const t of withStarts.slice(rows.length)) expect(isSoleWindow(withStarts, t)).toBe(false);
});

test('a start row is keyed by its value', () => {
  const [start] = startTargetsOf([{ name: 'api' }]);
  expect(rowKey(start)).toBe('start:api');
});

test('a start row has no kill; session and window rows do', () => {
  const [start] = startTargetsOf([{ name: 'api' }]);
  expect(canKillTarget(start)).toBe(false);
  expect(canKillTarget(s('web'))).toBe(true);
  expect(canKillTarget(w('web', '@1', '1: zsh'))).toBe(true);
});

test('the render key changes with any row\'s chip, window rows included', () => {
  // The popup skips its DOM rebuild when the key is unchanged, so a window row's
  // chip is only repainted if its state and cause are in the key.
  const list = (win) => ({ value: 's:web', options: [s('web'), { ...w('web', '@1', '1: zsh'), ...win }] });
  const idle = renderKey(list({}), null);
  expect(renderKey(list({}), null)).toBe(idle);
  const working = renderKey(list({ agent: 'working' }), null);
  const blocked = renderKey(list({ agent: 'blocked', agentCause: 'permission' }), null);
  const question = renderKey(list({ agent: 'blocked', agentCause: 'question' }), null);
  expect(new Set([idle, working, blocked, question]).size).toBe(4);
  // And with the selected row and the armed row, as before.
  expect(renderKey({ ...list({}), value: 'w:web:@1' }, null)).not.toBe(idle);
  expect(renderKey(list({}), 'w:web:@1')).not.toBe(idle);
  expect(renderKey(null, null)).not.toBe(idle);
});
