import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createTruenasRegistry } from '../src/server/truenasRegistry.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-tnreg-'));
  store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
});

// A stand-in for createTruenasClient that records how it was built and closed.
function recorder(built) {
  return (opts) => {
    const client = {
      opts, closed: 0,
      async fetchMetrics() { return { ok: true, metrics: {} }; },
      async close() { this.closed++; },
    };
    built.push(client);
    return client;
  };
}

const spec = {
  name: 'nas',
  url: 'https://nas.example.com',
  check: { kind: 'truenas', username: 'truenas_admin' },
  password: '1-testkey',
};

test('one client per service, reused, built from url + username + key + insecure', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const svc = await store.getService((await store.addService(spec)).id);

  const a = await reg.clientFor(svc);
  const b = await reg.clientFor(svc);
  expect(a).toBe(b);
  expect(built).toHaveLength(1);
  expect(built[0].opts).toMatchObject({
    baseUrl: 'https://nas.example.com', username: 'truenas_admin', apiKey: '1-testkey', insecure: false,
  });
});

test('check.target overrides the tile url as the API base, trailing slash stripped', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService({
    ...spec, check: { kind: 'truenas', username: 'truenas_admin', target: 'https://192.168.1.20/' },
  });
  await reg.clientFor(await store.getService(created.id));
  expect(built[0].opts.baseUrl).toBe('https://192.168.1.20');
});

test('a rotated API key rebuilds the client and closes the old session', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));

  await store.updateService(created.id, { password: '2-newkey' });
  await reg.clientFor(await store.getService(created.id));

  expect(built).toHaveLength(2);
  expect(built[0].closed).toBe(1);
  expect(built[1].opts.apiKey).toBe('2-newkey');
});

test('a changed username rebuilds the client', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));
  await store.updateService(created.id, { check: { kind: 'truenas', username: 'admin' } });
  await reg.clientFor(await store.getService(created.id));
  expect(built).toHaveLength(2);
  expect(built[1].opts.username).toBe('admin');
});

test('retain closes clients for services that are gone', async () => {
  const built = [];
  const reg = createTruenasRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  const b = await store.addService({ ...spec, name: 'nas2' });
  await reg.clientFor(await store.getService(a.id));
  await reg.clientFor(await store.getService(b.id));

  await reg.retain([a.id]);
  expect(built[0].closed).toBe(0);
  expect(built[1].closed).toBe(1);
});

test('a client whose close throws does not break closeAll', async () => {
  const reg = createTruenasRegistry({
    store,
    makeClient: () => ({ async fetchMetrics() { return { ok: true, metrics: {} }; }, async close() { throw new Error('boom'); } }),
  });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await expect(reg.closeAll()).resolves.toBeUndefined();
});
