import { test, expect } from 'vitest';
import { AGENT_LABEL, worstAgent, agentChipText, agentCounts, agentCards, fmtAge, latestAgents } from '../src/web/agentState.ts';

const S = (agents) => [{ t: 1, up: true, agents }];
test('worstAgent folds by precedence and counts stateful sessions', () => {
  const w = worstAgent({ web: { present: true, attached: false, state: 'done', ts: 1 }, 'web-2': { present: true, attached: false, state: 'blocked', cause: 'permission', ts: 2 }, nomark: { present: true, attached: false } });
  expect(w).toEqual({ state: 'blocked', count: 2, sessions: [{ session: 'web-2', state: 'blocked', cause: 'permission' }, { session: 'web', state: 'done' }] });
  expect(worstAgent({ nomark: { present: true, attached: false } })).toBeNull();
  expect(worstAgent(undefined)).toBeNull();
});
test('agentChipText spells blocked with its cause', () => {
  expect(agentChipText('blocked', 'permission')).toBe('blocked · permission');
  expect(agentChipText('blocked')).toBe('blocked');
  expect(agentChipText('idle')).toBe('idle');
});
test('agentCounts and agentCards cover every box and label the Host Shell', () => {
  const series = { b1: S({ web: { present: true, attached: false, state: 'working', ts: 5 } }), __local__: S({ local: { present: true, attached: false, state: 'done', ts: 9 } }) };
  expect(agentCounts(series)).toEqual({ blocked: 0, done: 1, working: 1, idle: 0 });
  const cards = agentCards([{ id: 'b1', label: 'buildbox' }], series);
  expect(cards.done).toEqual([{ boxId: '__local__', label: 'Host Shell', session: 'local', state: 'done', ts: 9 }]);
  expect(cards.working[0].label).toBe('buildbox');
});
test('latestAgents reads the newest sample only', () => {
  expect(latestAgents(undefined)).toEqual({});
  expect(latestAgents([{ t: 1, up: true, agents: { a: { present: true, attached: false } } }, { t: 2, up: true }])).toEqual({});
});
test('fmtAge', () => {
  expect(fmtAge(1000, 1000 * 1000 + 30_000)).toBe('<1m');
  expect(fmtAge(1000, 1000 * 1000 + 4 * 60_000)).toBe('4m');
  expect(fmtAge(1000, 1000 * 1000 + 2 * 3600_000)).toBe('2h');
  expect(fmtAge(1000, 1000 * 1000 + 3 * 86400_000)).toBe('3d');
});

test('AGENT_LABEL names codex and pi', () => {
  expect(AGENT_LABEL.codex).toBe('Codex'); expect(AGENT_LABEL.pi).toBe('pi');
});
