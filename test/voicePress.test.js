import { test, expect } from 'vitest';
import { reducePress, IDLE, inFlight, endInFlight } from '../src/web/voicePress';

const run = (events, start = IDLE) => events.reduce((acc, ev) => {
  const r = reducePress(acc.model, ev);
  return { model: r.model, effects: [...acc.effects, ...r.effects] };
}, { model: start, effects: [] });

test('press starts the mic and the probe', () => {
  const r = reducePress(IDLE, { t: 'press' });
  expect(r.model).toEqual({ state: 'probing', released: false });
  expect(r.effects).toEqual(['startMic', 'probe']);
});

test('claude verdict opens the link; ready streams and goes live; release is ignored while live', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'release' }]);
  expect(r.model.state).toBe('live');
  expect(r.effects).toEqual(['startMic', 'probe', 'openLink', 'stream']);
});

test('a second press while live unlinks and stops the mic', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'press' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['unlink', 'stopMic']);
});

test('a press while still linking unlinks too', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'press' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['unlink', 'stopMic']);
});

test('shell verdict records; release finishes dictation; done returns to idle', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'shell' }, { t: 'release' }, { t: 'done' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects).toEqual(['startMic', 'probe', 'finishDictation']);
});

test('release before a non-claude verdict finishes dictation the moment the verdict lands', () => {
  for (const kind of ['shell', 'busy', 'codex', 'error']) {
    const r = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind }]);
    expect(r.model.state).toBe('working');
    expect(r.effects).toEqual(['startMic', 'probe', 'finishDictation']);
  }
});

test('release before a claude verdict still links (a tap)', () => {
  const r = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }]);
  expect(r.model.state).toBe('live');
  expect(r.effects).toEqual(['startMic', 'probe', 'openLink', 'stream']);
});

test('a release that lands while the link is still opening is remembered, and ready still goes live', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'release' }, { t: 'ready' }]);
  expect(r.model).toEqual({ state: 'live', released: true });
  expect(r.effects).toEqual(['startMic', 'probe', 'openLink', 'stream']);
  const refused = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'release' }, { t: 'refused' }]);
  expect(refused.model.state).toBe('working');
  expect(refused.effects.slice(-2)).toEqual(['noticeRefused', 'finishDictation']);
});

test('a refused link continues as dictation: recording if still held, finishing if already released', () => {
  const held = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'refused' }]);
  expect(held.model.state).toBe('recording');
  expect(held.effects.slice(-1)).toEqual(['noticeRefused']);
  const released = run([{ t: 'press' }, { t: 'release' }, { t: 'verdict', kind: 'claude' }, { t: 'refused' }]);
  expect(released.model.state).toBe('working');
  expect(released.effects.slice(-2)).toEqual(['noticeRefused', 'finishDictation']);
  const closedEarly = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'closed' }]);
  expect(closedEarly.model.state).toBe('recording');
});

test('the link closing while live stops the mic and says so', () => {
  const r = run([{ t: 'press' }, { t: 'verdict', kind: 'claude' }, { t: 'ready' }, { t: 'closed' }]);
  expect(r.model).toEqual(IDLE);
  expect(r.effects.slice(-2)).toEqual(['stopMic', 'noticeClosed']);
});

test('stray events are inert', () => {
  for (const [state, ev] of [
    ['idle', { t: 'release' }], ['idle', { t: 'ready' }], ['idle', { t: 'done' }], ['idle', { t: 'closed' }],
    ['probing', { t: 'press' }], ['probing', { t: 'ready' }], ['probing', { t: 'done' }],
    ['recording', { t: 'press' }], ['recording', { t: 'ready' }], ['recording', { t: 'verdict', kind: 'claude' }],
    ['working', { t: 'press' }], ['working', { t: 'release' }], ['working', { t: 'closed' }],
    ['live', { t: 'release' }], ['live', { t: 'verdict', kind: 'shell' }], ['live', { t: 'ready' }],
  ]) {
    const m = { state, released: false };
    const r = reducePress(m, ev);
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  }
});

test('inFlight and endInFlight give the hotkey its toggle', () => {
  expect(inFlight('idle')).toBe(false);
  for (const s of ['probing', 'recording', 'working', 'linking', 'live']) expect(inFlight(s)).toBe(true);
  expect(endInFlight('probing')).toEqual({ t: 'release' });
  expect(endInFlight('recording')).toEqual({ t: 'release' });
  expect(endInFlight('linking')).toEqual({ t: 'press' });
  expect(endInFlight('live')).toEqual({ t: 'press' });
  expect(endInFlight('working')).toBeNull();
  expect(endInFlight('idle')).toBeNull();
});
