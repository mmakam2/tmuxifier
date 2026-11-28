import { test, expect } from 'vitest';
import { AGENT_LABEL, agentChipText, agentCounts, agentCards, fmtAge, latestAgents, agentRows, worstOf, sessionAgents, windowAgents, visibleDone, eventPlace, agentNameParts } from '../src/web/agentState.ts';

const S = (agents) => [{ t: 1, up: true, agents }];
const e = (over) => ({ session: 'main', windowId: '@1', windowIndex: 2, windowName: 'frontend', paneIndex: 1, agent: 'claude', state: 'working', ts: 10, visible: true, focused: false, attached: true, ...over });
test('agentChipText spells blocked with its cause', () => {
  expect(agentChipText('blocked', 'permission')).toBe('blocked · permission');
  expect(agentChipText('blocked')).toBe('blocked');
  expect(agentChipText('idle')).toBe('idle');
});
test('agentCounts and agentCards cover every box and label the Host Shell', () => {
  const series = { b1: S({ '%1': e({ state: 'working', ts: 5 }) }), __local__: S({ '%8': e({ session: 'local', windowId: '@0', windowIndex: 0, windowName: 'zsh', state: 'done', ts: 9 }) }) };
  expect(agentCounts(series)).toEqual({ blocked: 0, done: 1, working: 1, idle: 0 });
  const cards = agentCards([{ id: 'b1', label: 'buildbox' }], series);
  expect(cards.done).toEqual([{ boxId: '__local__', label: 'Host Shell', pane: '%8', session: 'local', windowId: '@0', name: '0:zsh', state: 'done', ts: 9 }]);
  expect(cards.working[0].label).toBe('buildbox');
});
test('agentCounts counts panes, not sessions, and skips entries with no state', () => {
  const series = { b1: S({ '%1': e({}), '%2': e({ paneIndex: 2, state: 'blocked', cause: 'question' }), '%3': e({ paneIndex: 3, state: undefined }) }) };
  expect(agentCounts(series)).toEqual({ blocked: 1, done: 0, working: 1, idle: 0 });
});
test('agentCards carry the pane, the window and the row name, newest first, and the cause when there is one', () => {
  const series = {
    b1: S({
      '%1': e({ state: 'done', ts: 5 }),
      '%2': e({ paneIndex: 2, state: 'done', ts: 8 }),
      '%3': e({ windowId: '@2', windowIndex: 3, windowName: 'logs', state: 'blocked', cause: 'permission', ts: 4 }),
    }),
    gone: S({ '%1': e({}) }),
  };
  const cards = agentCards([{ id: 'b1', label: 'web01' }], series);
  expect(cards.done.map((c) => [c.pane, c.name, c.windowId, c.ts])).toEqual([['%2', '2:frontend.2', '@1', 8], ['%1', '2:frontend.1', '@1', 5]]);
  expect(cards.blocked).toEqual([{ boxId: 'b1', label: 'web01', pane: '%3', session: 'main', windowId: '@2', name: '3:logs', state: 'blocked', cause: 'permission', ts: 4 }]);
  expect(cards.working).toEqual([]);
  expect(cards.idle).toEqual([]);
});
test('agentCards names a card by the whole box, so a second session adds the prefix', () => {
  const series = { b1: S({ '%1': e({}), '%5': e({ session: 'worker-site-1', windowId: '@4', windowIndex: 1, windowName: 'claude', ts: 20 }) }) };
  const cards = agentCards([{ id: 'b1', label: 'web01' }], series);
  expect(cards.working.map((c) => c.name)).toEqual(['worker-site-1 › 1:claude', 'main › 2:frontend']);
});
test('latestAgents reads the newest sample only', () => {
  expect(latestAgents(undefined)).toEqual({});
  expect(latestAgents([{ t: 1, up: true, agents: { '%1': e({}) } }, { t: 2, up: true }])).toEqual({});
  expect(latestAgents([{ t: 1, up: true }, { t: 2, up: true, agents: { '%1': e({}) } }])).toEqual({ '%1': e({}) });
});
test('fmtAge', () => {
  expect(fmtAge(1000, 1000 * 1000 + 30_000)).toBe('<1m');
  expect(fmtAge(1000, 1000 * 1000 + 4 * 60_000)).toBe('4m');
  expect(fmtAge(1000, 1000 * 1000 + 2 * 3600_000)).toBe('2h');
  expect(fmtAge(1000, 1000 * 1000 + 3 * 86400_000)).toBe('3d');
});

test('AGENT_LABEL names agy Antigravity', () => {
  expect(AGENT_LABEL.agy).toBe('Antigravity');
});

test('AGENT_LABEL names codex and pi', () => {
  expect(AGENT_LABEL.codex).toBe('Codex'); expect(AGENT_LABEL.pi).toBe('pi');
});

test('agentRows names by window, adds the pane only for a shared window and the session only across sessions', () => {
  expect(agentRows({ '%1': e({}) }).map((r) => r.name)).toEqual(['2:frontend']);
  expect(agentRows({ '%1': e({}), '%2': e({ paneIndex: 2 }) }).map((r) => r.name)).toEqual(['2:frontend.1', '2:frontend.2']);
  expect(agentRows({ '%1': e({}), '%5': e({ session: 'worker-site-1', windowId: '@4', windowIndex: 1, windowName: 'claude' }) }).map((r) => r.name))
    .toEqual(['main › 2:frontend', 'worker-site-1 › 1:claude']);
  expect(agentRows({ '%1': e({ windowName: '' }) })[0].name).toBe('2:window');
});
test('agentRows orders by session, window, pane and skips entries with no state', () => {
  const rows = agentRows({ '%9': e({ windowIndex: 3, windowId: '@2' }), '%2': e({ paneIndex: 2 }), '%1': e({}), '%7': e({ windowIndex: 1, windowId: '@0', state: undefined }) });
  expect(rows.map((r) => r.pane)).toEqual(['%1', '%2', '%9']);
});
test('the pane suffix counts stateless agents in the window too', () => {
  expect(agentRows({ '%1': e({}), '%2': e({ paneIndex: 2, state: undefined }) })[0].name).toBe('2:frontend.1');
});
test('agentRows carries what the surfaces need and nothing else', () => {
  const [r] = agentRows({ '%4': e({ state: 'blocked', cause: 'permission', agent: 'opencode', ts: 77, visible: false, focused: true }) });
  expect(r).toEqual({ pane: '%4', session: 'main', windowId: '@1', name: '2:frontend', state: 'blocked', cause: 'permission', agent: 'opencode', ts: 77, visible: false, focused: true });
  const [noCause] = agentRows({ '%4': e({}) });
  expect(Object.hasOwn(noCause, 'cause')).toBe(false);
  expect(agentRows({ '%4': e({ ts: undefined }) })[0].ts).toBe(0);
});
test('agentRows reads nothing from an absent map and skips null entries', () => {
  expect(agentRows(undefined)).toEqual([]);
  expect(agentRows({})).toEqual([]);
  expect(agentRows({ '%1': null, '%2': e({}) }).map((r) => r.pane)).toEqual(['%2']);
});
test('worstOf follows blocked, done, working, idle', () => {
  expect(worstOf([e({}), e({ state: 'blocked', cause: 'permission' }), e({ state: undefined })])).toEqual({ state: 'blocked', cause: 'permission', count: 2 });
  expect(worstOf([e({ state: undefined })])).toBeNull();
  expect(worstOf([])).toBeNull();
  expect(worstOf([e({ state: 'idle' }), e({ state: 'working' })])).toEqual({ state: 'working', count: 2 });
  expect(worstOf([e({ state: 'working' }), e({ state: 'done' })])).toEqual({ state: 'done', count: 2 });
  expect(Object.hasOwn(worstOf([e({ state: 'working' })]), 'cause')).toBe(false);
});
test('worstOf takes any iterable, so Object.values(...) and a Set both work', () => {
  expect(worstOf(Object.values({ '%1': e({ state: 'done' }) }))).toEqual({ state: 'done', count: 1 });
  expect(worstOf(new Set([e({ state: 'blocked', cause: 'question' })]))).toEqual({ state: 'blocked', cause: 'question', count: 1 });
});
test('sessionAgents and windowAgents pick entries by session and window, stateless ones included, in window and pane order', () => {
  const agents = {
    '%3': e({ windowId: '@2', windowIndex: 3 }),
    '%2': e({ paneIndex: 2, state: undefined }),
    '%1': e({}),
    '%8': e({ session: 'other', windowId: '@1' }),
  };
  expect(sessionAgents(agents, 'main').map((x) => [x.windowId, x.paneIndex])).toEqual([['@1', 1], ['@1', 2], ['@2', 1]]);
  expect(sessionAgents(agents, 'nope')).toEqual([]);
  expect(sessionAgents(undefined, 'main')).toEqual([]);
  expect(windowAgents(agents, 'main', '@1').map((x) => x.paneIndex)).toEqual([1, 2]);
  expect(windowAgents(agents, 'other', '@1')).toHaveLength(1);
  expect(windowAgents(agents, 'main', '@9')).toEqual([]);
  expect(windowAgents(undefined, 'main', '@1')).toEqual([]);
});
test('visibleDone lists only done panes visible in that session', () => {
  expect(visibleDone({ '%1': e({ state: 'done', ts: 5 }), '%2': e({ state: 'done', ts: 6, visible: false }), '%3': e({ state: 'done', ts: 7, session: 'x' }) }, 'main')).toEqual([{ pane: '%1', ts: 5 }]);
  expect(visibleDone({ '%1': e({ state: 'working', ts: 5 }), '%2': e({ state: 'blocked' }), '%3': e({ state: undefined }) }, 'main')).toEqual([]);
  expect(visibleDone(undefined, 'main')).toEqual([]);
});
test('eventPlace', () => {
  expect(eventPlace({ session: 'main', window: '2:frontend', paneIndex: 1 })).toBe('main › 2:frontend.1');
  expect(eventPlace({ session: 'main', window: '2:frontend' })).toBe('main › 2:frontend');
  expect(eventPlace({ session: 'main' })).toBe('main');
  expect(eventPlace({})).toBe('');
  expect(eventPlace({ session: 'main', window: '2:frontend', paneIndex: 0 })).toBe('main › 2:frontend.0');
  expect(eventPlace({ window: '2:frontend' })).toBe('2:frontend');
});

// The `.<paneIndex>` that tells two split panes apart is carried on its own, so a renderer can
// keep it whole while the window name is cut (dom.ts paintAgentName).
test('agentRows and agentCards carry the pane suffix only when the name has one', () => {
  const rows = agentRows({ '%1': e({}), '%2': e({ paneIndex: 2 }), '%5': e({ session: 'side', windowId: '@4', windowIndex: 1, windowName: 'solo' }) });
  expect(rows.map((r) => [r.name, r.suffix])).toEqual([['main › 2:frontend.1', '.1'], ['main › 2:frontend.2', '.2'], ['side › 1:solo', undefined]]);
  expect(Object.hasOwn(rows[2], 'suffix')).toBe(false);
  const cards = agentCards([{ id: 'b1', label: 'web01' }], { b1: S({ '%1': e({}), '%2': e({ paneIndex: 2 }), '%9': e({ windowId: '@9', windowIndex: 9 }) }) });
  expect(cards.working.map((c) => [c.name, c.suffix])).toEqual([['2:frontend.1', '.1'], ['2:frontend.2', '.2'], ['9:frontend', undefined]]);
  expect(Object.hasOwn(cards.working[2], 'suffix')).toBe(false);
});

test('agentNameParts splits off the suffix the name ends with, and nothing else', () => {
  expect(agentNameParts('main › 2:a-very-long-window-name.2', '.2')).toEqual(['main › 2:a-very-long-window-name', '.2']);
  expect(agentNameParts('2:frontend', undefined)).toEqual(['2:frontend', '']);
  expect(agentNameParts('2:frontend', '.3')).toEqual(['2:frontend', '']); // not its suffix
  expect(agentNameParts('.2', '.2')).toEqual(['.2', '']); // nothing would be left to cut
});
