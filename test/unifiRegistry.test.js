import { test, expect } from 'vitest';
import { createUnifiRegistry } from '../src/server/unifiRegistry.js';

const store = (secret = 'key-1') => ({ getServiceSecret: async () => secret });
const svc = (over = {}) => ({
  id: 'svc-1', url: 'https://unifi.example.com',
  check: { kind: 'unifi', tls: 'verify', ...over },
});

function tracker() {
  const made = [];
  const closed = [];
  return {
    made,
    closed,
    makeClient: (options) => {
      const client = { options, close: async () => { closed.push(options); } };
      made.push(client);
      return client;
    },
  };
}

test('unifiRegistry reuses one client per service while its options are unchanged', async () => {
  const t = tracker();
  const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
  const a = await reg.clientFor(svc());
  const b = await reg.clientFor(svc());
  expect(a).toBe(b);
  expect(t.made).toHaveLength(1);
});

test('unifiRegistry passes the site and tls mode through to the client', async () => {
  const t = tracker();
  const reg = createUnifiRegistry({ store: store('key-1'), makeClient: t.makeClient });
  await reg.clientFor(svc({ site: 'default', tls: 'pin', fingerprint: 'ABCD' }));
  expect(t.made[0].options).toMatchObject({
    baseUrl: 'https://unifi.example.com',
    apiKey: 'key-1',
    site: 'default',
    tls: 'pin',
    fingerprint: 'ABCD',
  });
});

test('unifiRegistry prefers an explicit check target over the tile url', async () => {
  const t = tracker();
  const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
  await reg.clientFor(svc({ target: 'https://192.168.1.1/' }));
  expect(t.made[0].options.baseUrl).toBe('https://192.168.1.1');
});

test('unifiRegistry rebuilds the client when the tls mode changes', async () => {
  const t = tracker();
  const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
  const a = await reg.clientFor(svc());
  const b = await reg.clientFor(svc({ tls: 'insecure' }));
  expect(a).not.toBe(b);
  expect(t.made).toHaveLength(2);
});

test('unifiRegistry rebuilds the client when the key rotates', async () => {
  const t = tracker();
  let secret = 'key-1';
  const reg = createUnifiRegistry({ store: { getServiceSecret: async () => secret }, makeClient: t.makeClient });
  await reg.clientFor(svc());
  secret = 'key-2';
  await reg.clientFor(svc());
  expect(t.made).toHaveLength(2);
});

test('unifiRegistry drops clients for services that have gone away', async () => {
  const t = tracker();
  const reg = createUnifiRegistry({ store: store(), makeClient: t.makeClient });
  await reg.clientFor(svc());
  await reg.retain([]);
  await reg.clientFor(svc());
  expect(t.made).toHaveLength(2);
});
