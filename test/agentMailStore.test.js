import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailStore } from '../src/server/agentMailStore.js';

const A = { boxId: 'box-a', session: 'orders' };
const B = { boxId: 'box-b', session: 'billing' };
const DAY = 24 * 60 * 60 * 1000;
const ID = /^[a-hj-km-np-z2-9]{8}$/;

let dir; let clock; let stores;
const make = (extra = {}) => { const s = createAgentMailStore({ dataDir: dir, now: () => clock, ...extra }); stores.push(s); return s; };
const mailDir = () => path.join(dir, 'agent-mail');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailstore-')); clock = 1_000_000; stores = []; });
afterEach(async () => { await Promise.all(stores.map((s) => s.whenIdle())); fs.rmSync(dir, { recursive: true, force: true }); });

describe('agentMailStore', () => {
  test('ids use the look-alike-free alphabet', () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    const m = s.addMessage(t.id, { from: 'starter', body: 'hi' });
    expect(t.id).toMatch(/^t-[a-hj-km-np-z2-9]{8}$/);
    expect(m.id).toMatch(/^m-[a-hj-km-np-z2-9]{8}$/);
  });

  test('first message is a task, later ones are replies', () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    expect(s.addMessage(t.id, { from: 'starter', body: 'do it' }).kind).toBe('task');
    expect(s.addMessage(t.id, { from: 'peer', body: 'done' }).kind).toBe('reply');
    expect(s.addMessage(t.id, { from: 'starter', body: 'ok' }).kind).toBe('reply');
  });

  test('returned threads are copies: mutating one does not touch the store', () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    s.addMessage(t.id, { from: 'starter', body: 'x' });
    const got = s.thread(t.id);
    got.messages[0].body = 'tampered'; got.state = 'closed'; got.starter.boxId = 'evil';
    s.threads()[0].messages.length = 0;
    const again = s.thread(t.id);
    expect(again.messages[0].body).toBe('x');
    expect(again.state).toBe('open');
    expect(again.starter.boxId).toBe('box-a');
    expect(s.thread('t-zzzzzzzz')).toBeNull();
    expect(s.thread('__proto__')).toBeNull();
  });

  test('threads are newest activity first', () => {
    const s = make();
    const t1 = s.createThread({ starter: A, peer: B });
    clock += 10; const t2 = s.createThread({ starter: B, peer: A });
    expect(s.threads().map((t) => t.id)).toEqual([t2.id, t1.id]);
    clock += 10; s.addMessage(t1.id, { from: 'starter', body: 'x' });
    expect(s.threads().map((t) => t.id)).toEqual([t1.id, t2.id]);
  });

  test('a thread file is 0600 and a second store loads it back', async () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    const m = s.addMessage(t.id, { from: 'starter', body: 'hello' });
    s.setMessageState(t.id, m.id, 'delivered', { deliveredAt: 77 });
    s.addRefusal({ from: A, target: 'nobody', reason: 'no such box' });
    await s.whenIdle();
    expect(fs.statSync(path.join(mailDir(), `${t.id}.json`)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(mailDir(), 'refusals.json')).mode & 0o777).toBe(0o600);
    const s2 = make();
    await s2.load();
    expect(s2.thread(t.id)).toEqual(s.thread(t.id));
    expect(s2.thread(t.id).messages[0]).toMatchObject({ state: 'delivered', deliveredAt: 77, body: 'hello' });
    expect(s2.refusals()).toEqual(s.refusals());
  });

  test('load turns handed into queued and leaves delivered alone', async () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    const m1 = s.addMessage(t.id, { from: 'starter', body: 'one' });
    const m2 = s.addMessage(t.id, { from: 'peer', body: 'two' });
    s.setMessageState(t.id, m1.id, 'handed', { handedAt: 5, handedPane: '%3' });
    s.setMessageState(t.id, m2.id, 'delivered', { deliveredAt: 6 });
    await s.whenIdle();
    const s2 = make();
    await s2.load();
    const [a, b] = s2.thread(t.id).messages;
    expect(a.state).toBe('queued');
    expect(a.handedPane).toBeUndefined();
    expect(b.state).toBe('delivered');
    await s2.whenIdle();
    const onDisk = JSON.parse(fs.readFileSync(path.join(mailDir(), `${t.id}.json`), 'utf8'));
    expect(onDisk.messages[0].state).toBe('queued');
  });

  test('load ignores a file whose name is not a thread id', async () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    await s.whenIdle();
    const body = fs.readFileSync(path.join(mailDir(), `${t.id}.json`), 'utf8');
    for (const name of ['t-ABC.json', 't-abcdefg2.json.bak', 'x.json', 't-abcdefgi.json', 't-abcdefg.json']) {
      fs.writeFileSync(path.join(mailDir(), name), body.replace(t.id, name.replace('.json', '')));
    }
    const s2 = make();
    await s2.load();
    expect(s2.threads().map((x) => x.id)).toEqual([t.id]);
  });

  test('load ignores a file whose id does not match its name', async () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    await s.whenIdle();
    const body = fs.readFileSync(path.join(mailDir(), `${t.id}.json`), 'utf8');
    fs.writeFileSync(path.join(mailDir(), 't-bcdfghjk.json'), body);
    const s2 = make();
    await s2.load();
    expect(s2.threads().map((x) => x.id)).toEqual([t.id]);
  });

  test('a thread past 500 messages keeps the newest 500 and counts the rest', () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    for (let i = 0; i < 503; i++) s.addMessage(t.id, { from: i % 2 ? 'peer' : 'starter', body: `m${i}` });
    const th = s.thread(t.id);
    expect(th.messages).toHaveLength(500);
    expect(th.dropped).toBe(3);
    expect(th.messages[0].body).toBe('m3');
    expect(th.messages[499].body).toBe('m502');
    expect(th.messages.every((m) => m.kind === 'reply')).toBe(true);
  });

  test('closeThread drops undelivered messages and is false for an unknown id', () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    const m1 = s.addMessage(t.id, { from: 'starter', body: 'a' });
    const m2 = s.addMessage(t.id, { from: 'peer', body: 'b' });
    const m3 = s.addMessage(t.id, { from: 'starter', body: 'c' });
    s.setMessageState(t.id, m1.id, 'delivered', { deliveredAt: 1 });
    s.setMessageState(t.id, m2.id, 'handed', { handedAt: 2 });
    expect(s.closeThread(t.id, 'operator')).toBe(true);
    const th = s.thread(t.id);
    expect(th.state).toBe('closed');
    expect(th.reason).toBe('operator');
    expect(th.messages.map((m) => m.state)).toEqual(['delivered', 'dropped', 'dropped']);
    expect(m3.id).toBe(th.messages[2].id);
    expect(s.closeThread('t-zzzzzzzz', 'operator')).toBe(false);
    expect(s.closeThread('__proto__', 'operator')).toBe(false);
    expect(() => s.addMessage(t.id, { from: 'peer', body: 'late' })).toThrow();
  });

  test('prune deletes a thread idle 30 days and its file', async () => {
    const s = make();
    const old = s.createThread({ starter: A, peer: B });
    await s.whenIdle();
    clock += 29 * DAY;
    const fresh = s.createThread({ starter: B, peer: A });
    clock += 2 * DAY;
    s.prune();
    await s.whenIdle();
    expect(s.thread(old.id)).toBeNull();
    expect(s.thread(fresh.id)).not.toBeNull();
    expect(fs.existsSync(path.join(mailDir(), `${old.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(mailDir(), `${fresh.id}.json`))).toBe(true);
  });

  test('over 1000 threads the longest-idle closed ones go first; open ones stay', () => {
    const s = make();
    const open = s.createThread({ starter: A, peer: B }); // oldest, but open
    const closedIds = [];
    for (let i = 0; i < 1002; i++) {
      clock += 1000;
      const t = s.createThread({ starter: A, peer: B });
      closedIds.push(t.id);
      s.closeThread(t.id, 'operator');
    }
    expect(s.threads()).toHaveLength(1003);
    s.prune();
    const left = s.threads();
    expect(left).toHaveLength(1000);
    expect(left.some((t) => t.id === open.id)).toBe(true);
    expect(s.thread(closedIds[0])).toBeNull();
    expect(s.thread(closedIds[2])).toBeNull();
    expect(s.thread(closedIds[3])).not.toBeNull();
  });

  test('over 1000 open threads nothing is deleted', () => {
    const s = make();
    for (let i = 0; i < 1005; i++) s.createThread({ starter: A, peer: B });
    s.prune();
    expect(s.threads()).toHaveLength(1005);
  });

  test('refusals keep the newest 200', async () => {
    const s = make();
    for (let i = 0; i < 205; i++) { clock += 1; s.addRefusal({ from: A, target: `t${i}`, reason: 'nope' }); }
    const r = s.refusals();
    expect(r).toHaveLength(200);
    expect(r[0].target).toBe('t204');
    expect(r[199].target).toBe('t5');
    expect(r[0]).toEqual({ at: clock, from: A, target: 't204', reason: 'nope' });
    await s.whenIdle();
    const s2 = make(); await s2.load();
    expect(s2.refusals()).toHaveLength(200);
  });

  test('whenIdle resolves after the last write landed', async () => {
    const s = make();
    const t = s.createThread({ starter: A, peer: B });
    for (let i = 0; i < 20; i++) s.addMessage(t.id, { from: 'starter', body: `b${i}` });
    await s.whenIdle();
    const onDisk = JSON.parse(fs.readFileSync(path.join(mailDir(), `${t.id}.json`), 'utf8'));
    expect(onDisk.messages).toHaveLength(20);
    expect(fs.readdirSync(mailDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('id minting rejects out-of-range bytes and retries a collision', () => {
    const seq = [Buffer.alloc(16, 0), Buffer.alloc(16, 250), Buffer.alloc(16, 1)];
    let i = 0;
    const s = make({ randomBytes: () => seq[Math.min(i++, 2)] });
    const t1 = s.createThread({ starter: A, peer: B });
    expect(t1.id).toBe('t-aaaaaaaa');
    const t2 = s.createThread({ starter: A, peer: B });
    expect(t2.id).toBe('t-bbbbbbbb'); // 250 skipped, then byte 1
    expect(t2.id.slice(2)).toMatch(ID);
  });
});
