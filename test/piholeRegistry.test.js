import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createPiholeRegistry } from '../src/server/piholeRegistry.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pireg-'));
  store = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
});

// A stand-in for createPiholeClient that records how it was built and closed.
function recorder(built) {
  return (opts) => {
    const client = { opts, closed: 0, async fetchSummary() { return { ok: true, metrics: {} }; }, async close() { this.closed++; } };
    built.push(client);
    return client;
  };
}

const spec = { name: 'pihole', url: 'https://pihole.example.com', check: { kind: 'pihole' }, password: 'app-pw' };

test('one client per service, reused across sweeps, built from url + password + insecure', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const svc = await store.getService((await store.addService(spec)).id);

  const a = await reg.clientFor(svc);
  const b = await reg.clientFor(svc);
  expect(a).toBe(b);
  expect(built).toHaveLength(1);
  expect(built[0].opts).toMatchObject({ baseUrl: 'https://pihole.example.com', password: 'app-pw', insecure: false });
});

test('check.target overrides the tile url as the API base, trailing slash stripped', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService({ ...spec, check: { kind: 'pihole', target: 'http://192.168.1.5/' } });
  await reg.clientFor(await store.getService(created.id));
  expect(built[0].opts.baseUrl).toBe('http://192.168.1.5');
});

test('a rotated password rebuilds the client and closes the old session', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));

  await store.updateService(created.id, { password: 'new-pw' });
  await reg.clientFor(await store.getService(created.id));

  expect(built).toHaveLength(2);
  expect(built[0].closed).toBe(1);
  expect(built[1].opts.password).toBe('new-pw');
});

test('a changed insecure flag rebuilds the client', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const created = await store.addService(spec);
  await reg.clientFor(await store.getService(created.id));
  await store.updateService(created.id, { check: { kind: 'pihole', insecure: true } });
  await reg.clientFor(await store.getService(created.id));
  expect(built).toHaveLength(2);
  expect(built[1].opts.insecure).toBe(true);
});

test('retain closes clients for services that are gone', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  const b = await store.addService({ ...spec, name: 'pihole2' });
  await reg.clientFor(await store.getService(a.id));
  await reg.clientFor(await store.getService(b.id));

  await reg.retain([a.id]);
  expect(built[0].closed).toBe(0);
  expect(built[1].closed).toBe(1);

  // The forgotten service rebuilds from scratch if it comes back.
  await reg.clientFor(await store.getService(b.id));
  expect(built).toHaveLength(3);
});

test('closeAll closes every live client exactly once', async () => {
  const built = [];
  const reg = createPiholeRegistry({ store, makeClient: recorder(built) });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await reg.closeAll();
  await reg.closeAll();
  expect(built[0].closed).toBe(1);
});

test('a client whose close throws does not break closeAll', async () => {
  const reg = createPiholeRegistry({
    store,
    makeClient: () => ({ async fetchSummary() { return { ok: true, metrics: {} }; }, async close() { throw new Error('boom'); } }),
  });
  const a = await store.addService(spec);
  await reg.clientFor(await store.getService(a.id));
  await expect(reg.closeAll()).resolves.toBeUndefined();
});
