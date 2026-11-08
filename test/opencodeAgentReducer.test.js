import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReducer, deriveState } from '../src/server/assets/tmuxifier-opencode-agent.js';

// Drives the OpenCode reporter's pure reducer with the real OpenCode 2.2.6
// recording (test/fixtures/opencode-event-trace.jsonl). Line numbers are the
// 1-based physical lines of the fixture, matching
// test/fixtures/README-opencode-event-trace.md; non-event lines (plugin.*,
// hook.*) are counted but never applied.

const TRACE = fileURLToPath(new URL('./fixtures/opencode-event-trace.jsonl', import.meta.url));
const LINES = readFileSync(TRACE, 'utf8')
  .split('\n')
  .map((text, i) => ({ n: i + 1, text }))
  .filter(({ text }) => text.trim())
  .map(({ n, text }) => ({ n, rec: JSON.parse(text) }))
  .filter(({ rec }) => rec.kind === 'event')
  .map(({ n, rec }) => ({ n, event: rec.event }));

const MAIN = 'ses_e47631a19ffeng7cUQkWJqeVg1';
const SECOND = 'ses_e475b9a7dffeT7ObFNG20gGov2';

function lineEvent(n) {
  const hit = LINES.find((l) => l.n === n);
  if (!hit) throw new Error(`fixture line ${n} is not an event`);
  return hit.event;
}

function applyUntil(r, lines, n) {
  for (const l of lines) if (l.n <= n) r.apply(l.event);
  return r;
}

function at(n, sessionID = MAIN) {
  const r = applyUntil(createReducer(), LINES, n);
  return { r, d: r.derive(sessionID) };
}

const sc = (d) => `${d.state}/${d.cause}`;

test('a user prompt starts working/prompt and the turn end is ready/stop', () => {
  expect(at(18).d).toMatchObject({ state: 'working', cause: 'prompt' });
  const end = at(46).d;
  expect(end).toMatchObject({ state: 'ready', cause: 'stop' });
  expect(end.ts).toBe(Math.floor(1794098652752 / 1000)); // execution.succeeded created
});

test('permission.asked blocks with cause permission; once/always/reject all unblock', () => {
  expect(sc(at(60).d)).toBe('blocked/permission');
  expect(sc(at(61).d)).toBe('working/unblock'); // once
  expect(sc(at(92).d)).toBe('blocked/permission');
  expect(sc(at(93).d)).toBe('working/unblock'); // reject (Escape)
  expect(sc(at(187).d)).toBe('blocked/permission');
  expect(sc(at(188).d)).toBe('working/unblock'); // always
});

test('the interrupted path ends the turn ready/stop with no block left', () => {
  for (const n of [97, 115, 160, 266]) {
    const { r, d } = at(n);
    expect(sc(d), `line ${n}`).toBe('ready/stop');
    expect(r.sessions.get(MAIN).blocks.size, `line ${n}`).toBe(0);
  }
});

test('a question form blocks with cause question; reply and cancel both unblock', () => {
  expect(sc(at(127).d)).toBe('blocked/question');
  expect(sc(at(129).d)).toBe('working/unblock'); // form.replied
  expect(sc(at(155).d)).toBe('blocked/question');
  expect(sc(at(156).d)).toBe('working/unblock'); // form.cancelled
});

test('a backgrounded shell keeps the session working across execution.succeeded, and its completion resumes', () => {
  const bg = at(298);
  expect(sc(bg.d)).toBe('working/prompt');
  expect(bg.r.sessions.get(MAIN).executing).toBe(false);
  expect([...bg.r.sessions.get(MAIN).shells]).toEqual(['sh_1b8a1df3e001c9IT7xTMOXc8ST']);
  expect(sc(at(303).d)).toBe('working/resume');
  const end = at(313);
  expect(sc(end.d)).toBe('ready/stop');
  expect(end.r.sessions.get(MAIN).shells.size).toBe(0);
});

test('duplicate event ids are ignored and apply() reports no change', () => {
  const r = applyUntil(createReducer(), LINES, 336);
  expect(lineEvent(337).id).toBe(lineEvent(336).id);
  const before = r.derive(SECOND);
  expect(r.apply(lineEvent(337))).toBe(false);
  expect(r.derive(SECOND)).toEqual(before);

  applyUntil(r, LINES.filter((l) => l.n > 337), 343);
  expect(sc(r.derive(SECOND))).toBe('working/prompt');
  const working = r.derive(SECOND);
  expect(lineEvent(344).id).toBe(lineEvent(343).id);
  expect(r.apply(lineEvent(344))).toBe(false);
  expect(r.derive(SECOND)).toEqual(working);
});

test('a session whose first event carries no directory stays unattributed and never throws', () => {
  const r = createReducer({ now: () => 1000 });
  expect(r.apply({ id: 'x1', type: 'session.execution.started', data: { sessionID: 'ses_unknown' } })).toBe(true);
  expect(r.sessions.get('ses_unknown').dir).toBe(null);
  expect(r.derive('ses_unknown')).toEqual({ state: 'working', cause: 'prompt', ts: 1000 });
  // Malformed input is swallowed, never thrown.
  for (const bad of [null, undefined, 42, 'x', {}, { type: 'permission.asked' }, { type: 'shell.created', data: {} }]) {
    expect(() => r.apply(bad)).not.toThrow();
    expect(r.apply(bad)).toBe(false);
  }
});

test('a resumed session learns its directory from inbox.enqueued before execution.started', () => {
  const r = createReducer();
  r.apply(lineEvent(415));
  r.apply(lineEvent(416));
  expect(r.sessions.get(MAIN).dir).toBe('/home/user/proj');
  expect(r.derive(MAIN)).toMatchObject({ state: 'working', cause: 'prompt' });
});

test('a child session rolls up: its block and its work become the parent\'s', () => {
  const r = createReducer({ now: () => 2000 });
  let i = 0;
  const ev = (type, data, extra = {}) => r.apply({ id: `e${++i}`, type, data, ...extra });
  ev('session.created', { sessionID: 'ses_p' }, { location: { directory: '/d' } });
  ev('session.created', { sessionID: 'ses_c', parentID: 'ses_p' }, { location: { directory: '/d' } });
  expect(r.sessions.get('ses_c').parent).toBe('ses_p');
  ev('session.execution.started', { sessionID: 'ses_p' });
  ev('session.execution.succeeded', { sessionID: 'ses_p' });
  expect(sc(r.derive('ses_p'))).toBe('ready/stop');
  ev('session.execution.started', { sessionID: 'ses_c' });
  expect(r.derive('ses_p').state).toBe('working');
  ev('permission.asked', { id: 'per_1', sessionID: 'ses_c' }, { location: { directory: '/d' } });
  expect(sc(r.derive('ses_p'))).toBe('blocked/permission');
  expect(r.sessions.get('ses_p').blocks.size).toBe(0); // the block is the child's own
  ev('permission.replied', { requestID: 'per_1', sessionID: 'ses_c', reply: 'once' }, { location: { directory: '/d' } });
  expect(r.derive('ses_p').state).toBe('working');
  ev('session.execution.succeeded', { sessionID: 'ses_c' });
  expect(sc(r.derive('ses_p'))).toBe('ready/stop');
});

test('a child already running when its session.created arrives moves its parent\'s state and ts', () => {
  const r = createReducer();
  r.apply({ id: 'k1', type: 'session.created', created: 10_000, data: { sessionID: 'ses_p' } });
  r.apply({ id: 'k2', type: 'session.execution.started', created: 20_000, data: { sessionID: 'ses_c' } });
  expect(sc(r.derive('ses_p'))).toBe('ready/start'); // the parent itself never started
  expect(r.apply({ id: 'k3', type: 'session.created', created: 30_000, data: { sessionID: 'ses_c', parentID: 'ses_p' } })).toBe(true);
  expect(r.derive('ses_p')).toEqual({ state: 'working', cause: 'prompt', ts: 30 });
});

test('an elicitation form on a real session blocks with cause elicitation; the "global" sentinel is ignored', () => {
  const r = createReducer({ now: () => 3000 });
  expect(r.apply({ id: 'f-a', type: 'form.created', data: { form: { id: 'f1', sessionID: 'ses_p', metadata: {} } } })).toBe(true);
  expect(sc(r.derive('ses_p'))).toBe('blocked/elicitation');
  expect(r.apply({ id: 'f-b', type: 'form.created', data: { form: { id: 'f2', sessionID: 'global', metadata: {} } } })).toBe(false);
  expect(r.sessions.has('global')).toBe(false);
  expect(r.sessions.size).toBe(1);
});

test('session.deleted drops the session', () => {
  const r = createReducer({ now: () => 4000 });
  r.apply({ id: 'd1', type: 'session.created', data: { sessionID: 'ses_gone' }, location: { directory: '/d' } });
  r.apply({ id: 'd2', type: 'session.execution.started', data: { sessionID: 'ses_gone' } });
  expect(r.sessions.has('ses_gone')).toBe(true);
  expect(r.apply({ id: 'd3', type: 'session.deleted', data: { sessionID: 'ses_gone' } })).toBe(true);
  expect(r.sessions.has('ses_gone')).toBe(false);
  expect(r.derive('ses_gone')).toBe(null);
  // Deleting a session nobody knows creates nothing.
  expect(r.apply({ id: 'd4', type: 'session.deleted', data: { sessionID: 'ses_never' } })).toBe(false);
  expect(r.sessions.size).toBe(0);
});

test('ts moves only on a derived transition and is in seconds', () => {
  const r = createReducer({ now: () => 999999 });
  const ev = (id, type, created, data) => r.apply({ id, type, created, data: { sessionID: 'ses_t', ...data } });
  expect(ev('t1', 'session.execution.started', 1_700_000_000_123)).toBe(true);
  expect(r.derive('ses_t')).toEqual({ state: 'working', cause: 'prompt', ts: 1_700_000_000 });
  // Same state and cause: nothing moves.
  expect(ev('t2', 'session.execution.started', 1_700_000_050_000)).toBe(false);
  expect(ev('t3', 'session.inbox.enqueued', 1_700_000_060_000, { item: { type: 'user' } })).toBe(false);
  expect(r.derive('ses_t').ts).toBe(1_700_000_000);
  // A transition moves it, in seconds.
  expect(ev('t4', 'session.execution.succeeded', 1_700_000_090_999)).toBe(true);
  expect(r.derive('ses_t')).toEqual({ state: 'ready', cause: 'stop', ts: 1_700_000_090 });
  expect(r.derive('ses_t').ts).toBeLessThan(1e11);
  // No `created`: the injected clock is the fallback.
  ev('t5', 'session.execution.started', undefined);
  expect(r.derive('ses_t').ts).toBe(999999);
  // The fixture's clock lands in seconds too.
  expect(at(18).d.ts).toBe(Math.floor(lineEvent(18).created / 1000));
  expect(at(18).d.ts).toBeLessThan(1e11);
});

test('irrelevant event types create nothing and report no change', () => {
  const r = createReducer();
  expect(r.apply(lineEvent(20))).toBe(false); // session.inbox.delivered
  expect(r.apply(lineEvent(47))).toBe(false); // session.viewed
  expect(r.sessions.size).toBe(0);
});

test('seenIds stays bounded at 5000, dropping the oldest', () => {
  const r = createReducer({ now: () => 1 });
  for (let k = 0; k < 5010; k++) r.apply({ id: `id${k}`, type: 'session.viewed', data: {} });
  expect(r.seenIds.size).toBe(5000);
  expect(r.seenIds.has('id0')).toBe(false);
  expect(r.seenIds.has('id5009')).toBe(true);
});

test('deriveState folds a session with the reducer\'s children and survives a parent cycle', () => {
  const r = createReducer({ now: () => 5 });
  r.apply({ id: 'c1', type: 'session.created', data: { sessionID: 'a', parentID: 'b' } });
  r.apply({ id: 'c2', type: 'session.created', data: { sessionID: 'b', parentID: 'a' } });
  r.apply({ id: 'c3', type: 'permission.asked', data: { id: 'per_x', sessionID: 'b' } });
  expect(deriveState(r.sessions.get('a'), r)).toEqual({ state: 'blocked', cause: 'permission' });
  expect(deriveState(r.sessions.get('b'), r)).toEqual({ state: 'blocked', cause: 'permission' });
});

test('a session that never started reads ready/start, not a finished turn', () => {
  expect(at(15).d).toMatchObject({ state: 'ready', cause: 'start' });
  expect(at(15).d.ts).toBe(Math.floor(lineEvent(15).created / 1000));
  expect(at(17).d).toMatchObject({ state: 'ready', cause: 'start' }); // inbox.enqueued is not a start
  expect(sc(at(18).d)).toBe('working/prompt');
  expect(sc(at(46).d)).toBe('ready/stop');
  // A block or a running shell still wins over a session that never started.
  const r = createReducer({ now: () => 7 });
  r.apply({ id: 's1', type: 'session.created', data: { sessionID: 'ses_n' } });
  r.apply({ id: 's2', type: 'shell.created', data: { info: { id: 'sh_n', metadata: { sessionID: 'ses_n' } } } });
  expect(sc(r.derive('ses_n'))).toBe('working/prompt');
  r.apply({ id: 's3', type: 'shell.exited', data: { id: 'sh_n' } });
  expect(sc(r.derive('ses_n'))).toBe('ready/start');
  r.apply({ id: 's4', type: 'permission.asked', data: { id: 'per_n', sessionID: 'ses_n' } });
  expect(sc(r.derive('ses_n'))).toBe('blocked/permission');
});

test('a non-finite created falls back to the injected clock', () => {
  const r = createReducer({ now: () => 4242 });
  for (const [k, created] of [[1, NaN], [2, Infinity], [3, -Infinity], [4, '1700000000000']]) {
    r.apply({ id: `nf${k}a`, type: 'session.execution.started', created, data: { sessionID: `ses_nf${k}` } });
    expect(r.derive(`ses_nf${k}`).ts, String(created)).toBe(4242);
  }
});

test('a reply or an inbox item for a session the reducer does not know creates nothing', () => {
  const r = createReducer({ now: () => 9 });
  const loc = { location: { directory: '/home/user/proj' } };
  expect(r.apply({ id: 'u1', type: 'permission.replied', data: { requestID: 'per_u', sessionID: 'ses_u', reply: 'once' }, ...loc })).toBe(false);
  expect(r.apply({ id: 'u2', type: 'form.replied', data: { id: 'que_u', sessionID: 'ses_u' }, ...loc })).toBe(false);
  expect(r.apply({ id: 'u3', type: 'form.cancelled', data: { id: 'que_u', sessionID: 'ses_u' }, ...loc })).toBe(false);
  expect(r.apply({ id: 'u4', type: 'session.inbox.enqueued', data: { sessionID: 'ses_u', item: { type: 'synthetic' } }, ...loc })).toBe(false);
  expect(r.sessions.size).toBe(0);
  // The inbox item is still remembered as a hint: a resumed session's first
  // execution.started carries no directory, so the hint is how it is attributed.
  expect(r.apply({ id: 'u5', type: 'session.execution.started', data: { sessionID: 'ses_u' } })).toBe(true);
  expect(r.sessions.get('ses_u').dir).toBe('/home/user/proj');
  expect(sc(r.derive('ses_u'))).toBe('working/resume');
  // A reply for a known session but an unknown request changes nothing.
  expect(r.apply({ id: 'u6', type: 'permission.replied', data: { requestID: 'per_zz', sessionID: 'ses_u', reply: 'once' } })).toBe(false);
  expect(sc(r.derive('ses_u'))).toBe('working/resume');
  // The real resumed-session lines: 415 creates nothing, 416 lands attributed.
  const fresh = createReducer();
  expect(fresh.apply(lineEvent(415))).toBe(false);
  expect(fresh.sessions.size).toBe(0);
  expect(fresh.apply(lineEvent(416))).toBe(true);
  expect(fresh.sessions.get(MAIN).dir).toBe('/home/user/proj');
});

test('directory hints for unknown sessions stay bounded', () => {
  const r = createReducer({ now: () => 1 });
  for (let k = 0; k < 600; k++) {
    r.apply({ id: `h${k}`, type: 'session.inbox.enqueued', data: { sessionID: `ses_h${k}`, item: { type: 'user' } }, location: { directory: `/d${k}` } });
  }
  expect(r.sessions.size).toBe(0);
  r.apply({ id: 'h-old', type: 'session.execution.started', data: { sessionID: 'ses_h0' } });
  expect(r.sessions.get('ses_h0').dir).toBe(null); // evicted
  r.apply({ id: 'h-new', type: 'session.execution.started', data: { sessionID: 'ses_h599' } });
  expect(r.sessions.get('ses_h599').dir).toBe('/d599');
});
