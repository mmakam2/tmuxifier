import { test, expect } from 'vitest';
import { agentRows } from '../src/web/agentState.ts';

// The row naming rule has one definition per runtime (the browser here, the MCP
// server's own copy): both are pinned to this one table, so the name an operator
// reads in the sidebar is the name an MCP tool reports. The rule itself is in
// the header of src/web/agentState.ts.
const e = (over) => ({ session: 'main', windowId: '@1', windowIndex: 2, windowName: 'frontend', paneIndex: 1, agent: 'claude', state: 'working', ts: 10, visible: true, focused: false, attached: true, ...over });

const NAMING_CASES = [
  { why: 'one agent: the window alone',
    agents: { '%1': e({}) },
    names: ['2:frontend'] },
  { why: 'two panes of one window: the pane index is added',
    agents: { '%1': e({}), '%2': e({ paneIndex: 2 }) },
    names: ['2:frontend.1', '2:frontend.2'] },
  { why: 'two sessions: the session is prefixed, one pane per window has no suffix',
    agents: { '%1': e({}), '%5': e({ session: 'worker-site-1', windowId: '@4', windowIndex: 1, windowName: 'claude' }) },
    names: ['main › 2:frontend', 'worker-site-1 › 1:claude'] },
  { why: 'an empty window name reads "window"',
    agents: { '%1': e({ windowName: '' }) },
    names: ['2:window'] },
  { why: 'a stateless agent in the window still adds the pane index',
    agents: { '%1': e({}), '%2': e({ paneIndex: 2, state: undefined }) },
    names: ['2:frontend.1'] },
  { why: 'a stateless agent in another session still adds the session prefix',
    agents: { '%1': e({}), '%2': e({ session: 'side', windowId: '@9', state: undefined }) },
    names: ['main › 2:frontend'] },
  { why: 'the same window id under two sessions is counted per session: no pane suffix',
    agents: { '%1': e({}), '%2': e({ session: 'side' }) },
    names: ['main › 2:frontend', 'side › 2:frontend'] },
  { why: 'rows are ordered by session, window index (numerically), pane index',
    agents: {
      '%9': e({ session: 'b', windowId: '@2', windowIndex: 1, windowName: 'one' }),
      '%3': e({ windowId: '@7', windowIndex: 10, windowName: 'late' }),
      '%2': e({ paneIndex: 2, windowName: 'two' }),
      '%1': e({ paneIndex: 1, windowName: 'two' }),
      '%4': e({ windowId: '@5', windowIndex: 3, windowName: 'three' }),
    },
    names: ['b › 1:one', 'main › 2:two.1', 'main › 2:two.2', 'main › 3:three', 'main › 10:late'] },
  { why: 'pane index 0 (pane-base-index 0) is a suffix, not "none"',
    agents: { '%1': e({ paneIndex: 0 }), '%2': e({ paneIndex: 1 }) },
    names: ['2:frontend.0', '2:frontend.1'] },
  { why: 'nothing stateful: no rows',
    agents: { '%1': e({ state: undefined }) },
    names: [] },
  { why: 'no agents at all',
    agents: undefined,
    names: [] },
];

test.each(NAMING_CASES.map((c) => [c.why, c]))('%s', (_why, c) => {
  expect(agentRows(c.agents).map((r) => r.name)).toEqual(c.names);
});
