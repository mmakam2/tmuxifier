import { test, expect } from 'vitest';
import { openVoiceLink, closeReason, voiceLinkUrl, LINK_MAX_MS } from '../src/web/voiceLink';

// A minimal WebSocket stand-in: the client only uses addEventListener, send,
// close and readyState.
function fakeSocket() {
  const ls = {};
  const s = {
    readyState: 0, sent: [], closes: [],
    addEventListener: (t, fn) => { (ls[t] ||= []).push(fn); },
    send: (d) => s.sent.push(d),
    close: (code, reason) => { s.closes.push([code, reason]); },
    emit: (t, ev) => { for (const fn of ls[t] || []) fn(ev); },
    open() { s.readyState = 1; s.emit('open', {}); },
    ready() { s.emit('message', { data: 'ready' }); },
    closed(code, reason = '') { s.readyState = 3; s.emit('close', { code, reason }); },
  };
  return s;
}
const loc = { protocol: 'https:', host: 'tmuxifier.example.com' };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('voiceLinkUrl follows the page scheme and encodes the box id', () => {
  expect(voiceLinkUrl('b 1', loc)).toBe('wss://tmuxifier.example.com/voice-link?box=b%201');
  expect(voiceLinkUrl('__local__', { protocol: 'http:', host: '127.0.0.1:7437' })).toBe('ws://127.0.0.1:7437/voice-link?box=__local__');
});

test('closeReason maps the server codes', () => {
  expect(closeReason(4001, '')).toBe('superseded');
  expect(closeReason(4002, '')).toBe('not-set-up');
  expect(closeReason(4003, '')).toBe('writer-failed');
  expect(closeReason(4004, '')).toBe('stalled');
  expect(closeReason(1008, 'setting up')).toBe('setting-up');
  expect(closeReason(1008, 'unauthorized')).toBe('unauthorized');
  expect(closeReason(1006, '')).toBe('closed');
  expect(LINK_MAX_MS).toBe(30 * 60 * 1000);
});

test('resolves on ready, forwards frames only after it, and reports a later close once', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open();
  s.ready();
  const link = await p;
  const frame = new Uint8Array(640);
  link.send(frame);
  expect(s.sent).toEqual([frame]);
  s.closed(4004, 'stalled');
  s.closed(4004, 'stalled');
  expect(closes).toEqual(['stalled']);
  link.send(frame);
  expect(s.sent).toHaveLength(1);
});

test('a close before ready rejects with the reason and never calls onClose', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open();
  s.closed(4002, 'not-set-up');
  await expect(p).rejects.toMatchObject({ why: 'not-set-up' });
  expect(closes).toEqual([]);
});

test('close() by the caller closes the socket and does not report', async () => {
  const s = fakeSocket();
  const closes = [];
  const p = openVoiceLink('b1', (why) => closes.push(why), { makeSocket: () => s, doc: null, loc });
  s.open(); s.ready();
  const link = await p;
  link.close();
  expect(s.closes).toEqual([[1000, 'unlink']]);
  s.closed(1000, '');
  expect(closes).toEqual([]);
});

test('the 30-minute cap and a hidden tab both unlink, reporting why', async () => {
  const a = fakeSocket();
  const aw = [];
  const pa = openVoiceLink('b1', (w) => aw.push(w), { makeSocket: () => a, doc: null, loc, maxMs: 30 });
  a.open(); a.ready(); await pa;
  await tick(60);
  expect(aw).toEqual(['cap']);
  expect(a.closes[0][1]).toBe('cap');

  const handlers = {};
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => { handlers[t] = fn; }, removeEventListener: (t) => { delete handlers[t]; } };
  const b = fakeSocket();
  const bw = [];
  const pb = openVoiceLink('b1', (w) => bw.push(w), { makeSocket: () => b, doc, loc });
  b.open(); b.ready(); const link = await pb;
  doc.visibilityState = 'hidden';
  handlers.visibilitychange();
  expect(bw).toEqual(['hidden']);
  expect(handlers.visibilitychange).toBeUndefined();
  link.close();
});
