import { test, expect } from 'vitest';
import { createSingleFlight } from '../src/server/singleFlight.js';

test('concurrent calls for one key share one run; the key frees on settle', async () => {
  const flight = createSingleFlight();
  let runs = 0; let release;
  const fn = () => { runs += 1; return new Promise((r) => { release = r; }); };
  const a = flight('k', fn); const b = flight('k', fn);
  expect(runs).toBe(1);
  release('v');
  expect(await a).toBe('v'); expect(await b).toBe('v');
  void flight('k', fn); expect(runs).toBe(2);
});

test('different keys run independently', async () => {
  const flight = createSingleFlight();
  let runs = 0;
  const fn = () => { runs += 1; return Promise.resolve(runs); };
  await Promise.all([flight('a', fn), flight('b', fn)]);
  expect(runs).toBe(2);
});

test('a rejection reaches every waiter and frees the key', async () => {
  const flight = createSingleFlight();
  let runs = 0; let fail;
  const fn = () => { runs += 1; return new Promise((_, rej) => { fail = rej; }); };
  const a = flight('k', fn); const b = flight('k', fn);
  expect(runs).toBe(1);
  fail(new Error('boom'));
  await expect(a).rejects.toThrow('boom');
  await expect(b).rejects.toThrow('boom');
  const c = flight('k', () => Promise.resolve('ok'));
  expect(await c).toBe('ok');
});
