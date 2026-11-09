import { test, expect } from 'vitest';
import { createLiveHub } from '../src/server/liveHub.js';

function harness(opts = {}) {
  let t = 0;
  let tickFn = null;
  let cleared = 0;
  const hub = createLiveHub({
    now: () => t,
    setIntervalFn: (fn) => { tickFn = fn; return 'timer'; },
    clearIntervalFn: () => { tickFn = null; cleared += 1; },
    ...opts,
  });
  return {
    hub,
    tick: (ms) => { t += ms; if (tickFn) tickFn(); },
    running: () => tickFn !== null,
    cleared: () => cleared,
  };
}
function client() {
  const c = { sent: [], pings: 0, closed: null, terminated: false };
  c.send = (text) => { c.sent.push(text); };
  c.ping = () => { c.pings += 1; };
  c.close = (code, reason) => { c.closed = [code, reason]; };
  c.terminate = () => { c.terminated = true; };
  return c;
}

test('publish sends one JSON line naming the box to every client', () => {
  const { hub } = harness();
  const a = client();
  const b = client();
  hub.add(a);
  hub.add(b);
  hub.publish('box-1');
  expect(a.sent).toEqual(['{"box":"box-1"}']);
  expect(b.sent).toEqual(['{"box":"box-1"}']);
  expect(hub.size()).toBe(2);
});

test('publish refuses anything that is not a plain box id', () => {
  const { hub } = harness();
  const a = client();
  hub.add(a);
  for (const bad of [undefined, null, '', 42, {}, 'a b', 'x'.repeat(65), '../etc', 'a"b', 'a\nb']) hub.publish(bad);
  expect(a.sent).toEqual([]);
  hub.publish('__local__');
  hub.publish('3f2b9c1e-0a4d-4f6e-9b7a-2c1d5e8f0a3b');
  expect(a.sent).toHaveLength(2);
});

test('a removed client gets nothing more, and removing twice is harmless', () => {
  const { hub } = harness();
  const a = client();
  const remove = hub.add(a);
  remove();
  remove();
  hub.publish('b');
  expect(a.sent).toEqual([]);
  expect(hub.size()).toBe(0);
});

test('a client whose send throws is dropped without disturbing the others', () => {
  const { hub } = harness();
  const bad = client();
  bad.send = () => { throw new Error('socket closed'); };
  const good = client();
  hub.add(bad);
  hub.add(good);
  hub.publish('b');
  expect(good.sent).toHaveLength(1);
  expect(hub.size()).toBe(1);
  expect(bad.terminated).toBe(true);
});

test('the hub is bounded: a client past the cap is refused', () => {
  const { hub } = harness({ maxClients: 2 });
  expect(hub.add(client())).toBeTypeOf('function');
  expect(hub.add(client())).toBeTypeOf('function');
  expect(hub.add(client())).toBeNull();
  expect(hub.size()).toBe(2);
});

test('the tick pings live clients and terminates one that never answered', () => {
  const { hub, tick } = harness({ pingMs: 1000 });
  const quiet = client();
  const lively = client();
  hub.add(quiet);
  hub.add(lively);
  tick(1000);
  expect([quiet.pings, lively.pings]).toEqual([1, 1]);
  hub.alive(lively);                 // its pong came back
  tick(1000);
  expect(quiet.terminated).toBe(true);
  expect(lively.terminated).toBe(false);
  expect(lively.pings).toBe(2);
  expect(hub.size()).toBe(1);
});

test('a client is closed for renewal at maxAgeMs, so a stream never outlives its session check for long', () => {
  const { hub, tick } = harness({ pingMs: 1000, maxAgeMs: 2500 });
  const a = client();
  hub.add(a);
  tick(1000); hub.alive(a);
  tick(1000); hub.alive(a);
  expect(a.closed).toBeNull();
  tick(1000);
  expect(a.closed).toEqual([4000, 'renew']);
  expect(hub.size()).toBe(0);
});

test('the timer runs only while someone is connected', () => {
  const { hub, running, cleared } = harness();
  expect(running()).toBe(false);
  const remove = hub.add(client());
  expect(running()).toBe(true);
  remove();
  expect(running()).toBe(false);
  expect(cleared()).toBe(1);
});

test('closeAll closes every client with the given code and empties the hub', () => {
  const { hub, running } = harness();
  const a = client();
  const b = client();
  hub.add(a);
  hub.add(b);
  hub.closeAll(1001, 'shutdown');
  expect(a.closed).toEqual([1001, 'shutdown']);
  expect(b.closed).toEqual([1001, 'shutdown']);
  expect(hub.size()).toBe(0);
  expect(running()).toBe(false);
});
