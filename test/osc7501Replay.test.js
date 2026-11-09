import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'helpers', 'osc7501Replay.py');
const FIXTURE = path.join(HERE, 'fixtures', 'osc7501-pane-trace.jsonl');

// Replays the real recording; returns { rows: [{line, session, marker}], lines }.
function replay(mapping = []) {
  const out = execFileSync('python3', [HELPER, 'fixture', FIXTURE, ...mapping], { encoding: 'utf8' });
  const objs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = objs.pop();
  return { rows: objs, lines: last.lines };
}
const trailOf = (rows, session) =>
  rows.filter((r) => r.session === session).map((r) => [r.line, r.marker]);

const OPENCODE = [[41, 'ready/start'], [43, 'working/prompt'], [64, 'blocked/permission'], [806, null]];
const OPENCODE2 = [
  [963, 'ready/start'], [980, 'working/prompt'], [1013, 'ready/stop'], [1037, 'working/prompt'],
  [1108, 'ready/stop'], [1135, 'working/prompt'], [1448, 'ready/stop'], [1477, null],
];
// Antigravity CLI (agy), lines 1491-2321. It never sends `clear`: both trails
// end on `ready/stop`, and the marker goes when the loop detaches the pane.
const AGY = [
  [1516, 'blocked/permission'], [1527, 'ready/stop'],                              // folder trust, accepted
  [1538, 'working/prompt'], [1590, 'ready/stop'],                                  // plain turn: working -> done
  [1607, 'working/prompt'], [1670, 'blocked/permission'], [1684, 'working/unblock'], [1751, 'ready/stop'],  // allowed
  [1763, 'working/prompt'], [1843, 'blocked/permission'], [1859, 'ready/stop'],    // declined: straight to idle
  [1878, 'working/prompt'], [1962, 'blocked/question'], [1976, 'working/unblock'], [2196, 'ready/stop'],    // question
];
const AGYAUTH = [[2263, 'blocked/elicitation'], [2312, 'ready/stop']];             // sign-in menu, then ctrl-c
const LINES = 2321;

describe('osc7501 acceptance replay over the recorded pane trace', () => {
  it('yields the exact per-pane trail (lines 109-778 change nothing for opencode)', () => {
    const { rows, lines } = replay();
    expect(lines).toBe(LINES);
    expect(trailOf(rows, 'opencode')).toEqual(OPENCODE);
    expect(trailOf(rows, 'pi')).toEqual([[853, 'ready/start']]);
    expect(trailOf(rows, 'piplain')).toEqual([]);
    expect(trailOf(rows, 'claude')).toEqual([]);
    expect(trailOf(rows, 'opencode2')).toEqual(OPENCODE2);
    expect(trailOf(rows, 'agy')).toEqual(AGY);
    expect(trailOf(rows, 'agyauth')).toEqual(AGYAUTH);
    expect(trailOf(rows, 'agyplain')).toEqual([]);
    expect(rows.length).toBe(OPENCODE.length + 1 + OPENCODE2.length + AGY.length + AGYAUTH.length);
  });

  it('folds two panes into one session', () => {
    const { rows, lines } = replay(['opencode=shared', 'opencode2=shared']);
    expect(lines).toBe(LINES);
    expect(trailOf(rows, 'shared')).toEqual([...OPENCODE, ...OPENCODE2]);
  });
});
