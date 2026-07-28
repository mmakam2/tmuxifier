import { test, expect } from 'vitest';
import { createImmichRegistry } from '../src/server/immichRegistry.js';

const svc = (over = {}) => ({ id: 'svc-1', url: 'https://immich.example.com', check: { kind: 'immich' }, ...over });

function harness(secret = 'key-1') {
  const built = [];
  const closed = [];
  const store = { getServiceSecret: async () => secret };
  const makeClient = (options) => {
    built.push(options);
    return { options, close: async () => { closed.push(options); } };
  };
  return { built, closed, registry: createImmichRegistry({ store, makeClient }) };
}

test('builds one client per service and reuses it', async () => {
  const h = harness();
  const a = await h.registry.clientFor(svc());
  const b = await h.registry.clientFor(svc());
  expect(a).toBe(b);
  expect(h.built).toHaveLength(1);
});

test('derives the base url from the check target, falling back to the tile url', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  expect(h.built[0].baseUrl).toBe('https://immich.example.com');
  await h.registry.clientFor(svc({ id: 'svc-2', check: { kind: 'immich', target: 'http://192.168.1.10:2283' } }));
  expect(h.built[1].baseUrl).toBe('http://192.168.1.10:2283');
});

test('rebuilds the client when the insecure flag changes', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  await h.registry.clientFor(svc({ check: { kind: 'immich', insecure: true } }));
  expect(h.built).toHaveLength(2);
  expect(h.built[1].insecure).toBe(true);
});

test('retain closes the clients of services that have gone away', async () => {
  const h = harness();
  await h.registry.clientFor(svc());
  await h.registry.retain([]);
  expect(h.closed).toHaveLength(1);
});
