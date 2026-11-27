import { test, expect } from 'vitest';
import { jumpTargetOf, needsSelect } from '../src/web/agentJump.ts';

const entry = (over = {}) => ({
  session: 'main', windowId: '@3', windowIndex: 2, windowName: 'frontend', paneIndex: 1,
  agent: 'claude', state: 'done', ts: 100, visible: false, focused: false, attached: true, ...over,
});

test('jumpTargetOf takes the session and window from the pane entry', () => {
  const agents = { '%12': entry(), '%13': entry({ session: 'other', windowId: '@7', focused: true, visible: true }) };
  expect(jumpTargetOf('b1', agents, '%12')).toEqual({ boxId: 'b1', pane: '%12', session: 'main', windowId: '@3', focused: false });
  expect(jumpTargetOf('b1', agents, '%13')).toEqual({ boxId: 'b1', pane: '%13', session: 'other', windowId: '@7', focused: true });
});

test('jumpTargetOf is null for an unknown pane, an inherited key and no map', () => {
  const agents = { '%12': entry() };
  expect(jumpTargetOf('b1', agents, '%99')).toBeNull();
  expect(jumpTargetOf('b1', agents, 'constructor')).toBeNull();
  expect(jumpTargetOf('b1', agents, 'toString')).toBeNull();
  expect(jumpTargetOf('b1', undefined, '%12')).toBeNull();
  expect(jumpTargetOf('b1', { '%12': null }, '%12')).toBeNull();
});

test('needsSelect is false only for an entry already focused', () => {
  const agents = {
    '%1': entry({ visible: true, focused: true }),
    '%2': entry({ visible: true, focused: false }), // in the window in front, another pane focused
    '%3': entry({ visible: false, focused: false }), // a background window
  };
  expect(needsSelect(jumpTargetOf('b1', agents, '%1'))).toBe(false);
  expect(needsSelect(jumpTargetOf('b1', agents, '%2'))).toBe(true);
  expect(needsSelect(jumpTargetOf('b1', agents, '%3'))).toBe(true);
});
