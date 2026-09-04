import { test, expect } from 'vitest';
import { createVoiceLinks, LINK_CLOSE } from '../src/server/voiceLinks.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake sshPipe handle: records writes, exposes writableNeedDrain, and lets
// a test end the child with a chosen exit code.
function fakeSink() {
  const s = { chunks: [], ended: false, killed: false, needDrain: false };
  let settle;
  s.done = new Promise((r) => { settle = r; });
  s.stdin = { write: (b) => { s.chunks.push(Buffer.from(b)); return true; }, end: () => { s.ended = true; }, get writableNeedDrain() { return s.needDrain; } };
  s.kill = () => { s.killed = true; };
  s.exit = (code) => settle({ code, stderr: '' });
  return s;
}

function make(opts = {}) {
  const sinks = [];
  const links = createVoiceLinks({
    openSink: async () => { const s = fakeSink(); sinks.push(s); return s; },
    readyMs: 20, stallMs: 60, killGraceMs: 10,
    ...opts,
  });
  return { links, sinks };
}
function hooks() {
  const h = { ready: 0, closes: [] };
  h.onReady = () => { h.ready++; };
  h.onClose = (code, reason) => { h.closes.push([code, reason]); };
  return h;
}

test('sends ready once the writer has stayed alive readyMs, and forwards frames after that', async () => {
  const { links, sinks } = make();
  const h = hooks();
  const link = links.open('b1', { id: 'b1' }, h);
  expect(link.write(Buffer.alloc(640))).toBe(false);       // before ready: dropped
  await tick(40);
  expect(h.ready).toBe(1);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(sinks[0].chunks).toHaveLength(1);
  link.close();
  expect(sinks[0].ended).toBe(true);
  expect(h.closes).toEqual([[1000, 'closed']]);
  await tick(20);
  expect(sinks[0].killed).toBe(true);
  expect(links.has('b1')).toBe(false);
});

test('a writer exiting 3 before ready closes 4002 not-set-up; any other early exit is 4003', async () => {
  const a = make(); const ha = hooks();
  a.links.open('b1', {}, ha);
  await tick(5);
  a.sinks[0].exit(3);
  await tick(5);
  expect(ha.ready).toBe(0);
  expect(ha.closes).toEqual([[LINK_CLOSE.notSetUp, 'not-set-up']]);
  const b = make(); const hb = hooks();
  b.links.open('b1', {}, hb);
  await tick(5);
  b.sinks[0].exit(255);
  await tick(5);
  expect(hb.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('a writer dying after ready closes 4003', async () => {
  const { links, sinks } = make(); const h = hooks();
  links.open('b1', {}, h);
  await tick(40);
  sinks[0].exit(1);
  await tick(5);
  expect(h.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('openSink throwing closes 4003', async () => {
  const links = createVoiceLinks({ openSink: async () => { throw new Error('no ssh'); }, readyMs: 20 });
  const h = hooks();
  links.open('b1', {}, h);
  await tick(10);
  expect(h.closes).toEqual([[LINK_CLOSE.writerFailed, 'writer-failed']]);
});

test('newest wins: a second open for the same box closes the first with 4001', async () => {
  const { links, sinks } = make();
  const h1 = hooks(); const h2 = hooks();
  links.open('b1', {}, h1);
  await tick(40);
  const l2 = links.open('b1', {}, h2);
  expect(h1.closes).toEqual([[LINK_CLOSE.superseded, 'superseded']]);
  expect(sinks[0].ended).toBe(true);
  await tick(40);
  expect(h2.ready).toBe(1);
  expect(links.has('b1')).toBe(true);
  l2.close();
  expect(links.has('b1')).toBe(false);
});

test('a closed superseded link cannot remove its successor from the registry', async () => {
  const { links } = make();
  const l1 = links.open('b1', {}, hooks());
  const l2 = links.open('b1', {}, hooks());
  l1.close();
  expect(links.has('b1')).toBe(true);
  l2.close();
  expect(links.has('b1')).toBe(false);
});

test('drops oversize frames, frames beyond the byte-rate cap, and frames while stdin needs drain', async () => {
  let t = 1000;
  const { links, sinks } = make({ now: () => t, maxFrameBytes: 1000, maxBytesPerSec: 2000 });
  const link = links.open('b1', {}, hooks());
  await tick(40);
  expect(link.write(Buffer.alloc(1001))).toBe(false);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(true);
  expect(link.write(Buffer.alloc(640))).toBe(false);       // 2560 > 2000 in this second
  t += 1000;
  expect(link.write(Buffer.alloc(640))).toBe(true);        // new window
  sinks[0].needDrain = true;
  expect(link.write(Buffer.alloc(640))).toBe(false);
  expect(link.dropped).toBe(3);
  expect(sinks[0].chunks).toHaveLength(4);
  link.close();
});

test('no frame for stallMs after ready closes 4004; frames keep it alive', async () => {
  const { links } = make(); const h = hooks();
  const link = links.open('b1', {}, h);
  await tick(40);
  for (let i = 0; i < 4; i++) { link.write(Buffer.alloc(640)); await tick(30); }
  expect(h.closes).toEqual([]);
  await tick(90);
  expect(h.closes).toEqual([[LINK_CLOSE.stalled, 'stalled']]);
});

test('closeAll closes every link with 1001 going away', async () => {
  const { links } = make(); const h1 = hooks(); const h2 = hooks();
  links.open('b1', {}, h1); links.open('b2', {}, h2);
  await tick(40);
  links.closeAll();
  expect(h1.closes).toEqual([[1001, 'going away']]);
  expect(h2.closes).toEqual([[1001, 'going away']]);
  expect(links.has('b1')).toBe(false);
});

test('a link closed before openSink resolves ends and kills the late sink', async () => {
  let resolveSink;
  const s = fakeSink();
  const links = createVoiceLinks({ openSink: () => new Promise((r) => { resolveSink = r; }), readyMs: 20, killGraceMs: 5 });
  const link = links.open('b1', {}, hooks());
  link.close();
  resolveSink(s);
  await tick(20);
  expect(s.ended).toBe(true);
  expect(s.killed).toBe(true);
});
