import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createSecretBox } from '../src/server/secretBox.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-svc-'));
  store = createServicesStore({ dataDir: dir });
});

const spec = { name: 'Grafana', url: 'https://192.168.1.20:3000/', glyph: '', group: 'Monitoring' };

test('addService normalizes, defaults check to http, and round-trips', async () => {
  const svc = await store.addService(spec);
  expect(svc.id).toMatch(/^svc-/);
  expect(svc.check).toEqual({ kind: 'http' });
  expect(svc.createdAt).toBeTruthy();
  expect(await store.listServices()).toEqual([svc]);
  expect(await store.getService(svc.id)).toEqual(svc);
});

test('name is required, trimmed, and capped at 64 chars', async () => {
  await expect(store.addService({ ...spec, name: '  ' })).rejects.toThrow(/name/);
  await expect(store.addService({ ...spec, name: 'x'.repeat(65) })).rejects.toThrow(/name/);
  const svc = await store.addService({ ...spec, name: '  Grafana  ' });
  expect(svc.name).toBe('Grafana');
});

test('url must be http(s)', async () => {
  await expect(store.addService({ ...spec, url: 'ftp://example.com/' })).rejects.toThrow(/http/);
  await expect(store.addService({ ...spec, url: 'nonsense' })).rejects.toThrow(/URL/);
});

test('glyph is capped at 4 UTF-16 units; group at 32 chars', async () => {
  await expect(store.addService({ ...spec, glyph: 'abcde' })).rejects.toThrow(/glyph/);
  await expect(store.addService({ ...spec, group: 'g'.repeat(33) })).rejects.toThrow(/group/);
});

test('tcp check requires a validated host:port target', async () => {
  const ok = await store.addService({ ...spec, check: { kind: 'tcp', target: '192.168.1.20:53' } });
  expect(ok.check).toEqual({ kind: 'tcp', target: '192.168.1.20:53' });
  await expect(store.addService({ ...spec, check: { kind: 'tcp' } })).rejects.toThrow(/target/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: 'bad host:53' } })).rejects.toThrow(/host/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: '-evil.example.com:53' } })).rejects.toThrow(/host/);
  await expect(store.addService({ ...spec, check: { kind: 'tcp', target: '192.168.1.20:99999' } })).rejects.toThrow(/port/);
});

test('http check accepts an optional target URL; none refuses a target', async () => {
  const probe = await store.addService({ ...spec, check: { kind: 'http', target: 'http://192.168.1.20:3000/health' } });
  expect(probe.check.target).toBe('http://192.168.1.20:3000/health');
  await expect(store.addService({ ...spec, check: { kind: 'http', target: 'nonsense' } })).rejects.toThrow(/URL/);
  await expect(store.addService({ ...spec, check: { kind: 'none', target: 'http://x.example.com/' } })).rejects.toThrow(/none/);
});

test('updateService merges the patch and re-validates the whole result', async () => {
  const svc = await store.addService(spec);
  const upd = await store.updateService(svc.id, { name: 'Grafana 2' });
  expect(upd).toMatchObject({ id: svc.id, name: 'Grafana 2', url: spec.url, createdAt: svc.createdAt });
  await expect(store.updateService(svc.id, { url: 'nonsense' })).rejects.toThrow(/URL/);
  await expect(store.updateService('svc-missing', { name: 'x' })).rejects.toThrow(/not found/);
});

test('null clears glyph and group', async () => {
  const svc = await store.addService(spec);
  const upd = await store.updateService(svc.id, { glyph: null, group: null });
  expect(upd.glyph).toBeUndefined();
  expect(upd.group).toBeUndefined();
});

test('removeService deletes; a corrupt file quarantines and reads as empty', async () => {
  const svc = await store.addService(spec);
  await store.removeService(svc.id);
  expect(await store.listServices()).toEqual([]);
  await fs.writeFile(path.join(dir, 'services.json'), '{nope');
  expect(await store.listServices()).toEqual([]); // fail-open per jsonFile contract
  const files = await fs.readdir(dir);
  expect(files.some((f) => f.startsWith('services.json.corrupt-'))).toBe(true);
});

test('section defaults to services, accepts infrastructure, rejects junk, survives PATCH merge', async () => {
  const svc = await store.addService(spec);
  expect(svc.section).toBe('services');
  const infra = await store.addService({ ...spec, section: 'infrastructure', group: 'DNS Filtering' });
  expect(infra.section).toBe('infrastructure');
  await expect(store.addService({ ...spec, section: 'chassis' })).rejects.toThrow(/section/);
  const upd = await store.updateService(infra.id, { name: 'AdGuard' });
  expect(upd.section).toBe('infrastructure'); // merge keeps the stored section
});

const piSpec = {
  name: 'pihole', url: 'https://pihole.example.com', group: 'DNS Filtering',
  check: { kind: 'pihole' }, password: 'app-pw',
};

test('pihole check accepts an optional target and insecure flag', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const a = await s.addService(piSpec);
  expect(a.check).toEqual({ kind: 'pihole' });
  const b = await s.addService({ ...piSpec, name: 'pihole2', check: { kind: 'pihole', target: 'http://192.168.1.5/', insecure: true } });
  expect(b.check).toEqual({ kind: 'pihole', target: 'http://192.168.1.5/', insecure: true });
  await expect(s.addService({ ...piSpec, name: 'bad', check: { kind: 'pihole', target: 'nonsense' } })).rejects.toThrow(/URL|http/);
});

test('the app password is sealed on disk, redacted on read, and openable by the store', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);
  expect(svc.hasPassword).toBe(true);
  expect(svc.secret).toBeUndefined();
  expect(JSON.stringify(await s.listServices())).not.toContain('app-pw');

  const raw = await fs.readFile(path.join(dir, 'services.json'), 'utf8');
  expect(raw).not.toContain('app-pw');
  expect(raw).toContain('pvebox.v1');

  expect(await s.getServiceSecret(svc.id)).toBe('app-pw');
});

test('updating without a password keeps it; null clears it', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);

  const renamed = await s.updateService(svc.id, { name: 'pihole-renamed' });
  expect(renamed.hasPassword).toBe(true);
  expect(await s.getServiceSecret(svc.id)).toBe('app-pw');

  const rotated = await s.updateService(svc.id, { password: 'new-pw' });
  expect(rotated.hasPassword).toBe(true);
  expect(await s.getServiceSecret(svc.id)).toBe('new-pw');

  const cleared = await s.updateService(svc.id, { password: null });
  expect(cleared.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
});

test('switching a service away from the pihole kind drops the stored password', async () => {
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const svc = await s.addService(piSpec);
  const plain = await s.updateService(svc.id, { check: { kind: 'http' } });
  expect(plain.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
  expect(await fs.readFile(path.join(dir, 'services.json'), 'utf8')).not.toContain('pvebox.v1');
});

test('a legacy record with no secret loads and reports hasPassword false', async () => {
  await fs.writeFile(path.join(dir, 'services.json'), JSON.stringify({
    version: 1,
    services: [{ id: 'svc-legacy', name: 'Grafana', url: 'https://192.168.1.20:3000/', section: 'services', check: { kind: 'http' }, createdAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const s = createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
  const [svc] = await s.listServices();
  expect(svc.hasPassword).toBe(false);
  expect(await s.getServiceSecret('svc-legacy')).toBe(null);
});

test('a password without a configured secretBox is refused rather than stored in the clear', async () => {
  const s = createServicesStore({ dataDir: dir });
  await expect(s.addService(piSpec)).rejects.toThrow(/secret/i);
});

// --- truenas ---------------------------------------------------------------
// Like the pihole cases above, these need a store with a secretBox: the shared
// `store` from beforeEach has none.
const sealed = () => createServicesStore({ dataDir: dir, secretBox: createSecretBox('k') });
const nasSpec = {
  name: 'nas',
  url: 'https://nas.example.com',
  section: 'infrastructure',
  check: { kind: 'truenas', username: 'truenas_admin' },
  password: '1-testkey',
};

test('truenas: a valid tile stores the username in the clear and seals the key', async () => {
  const s = sealed();
  const svc = await s.addService(nasSpec);
  expect(svc.check).toEqual({ kind: 'truenas', username: 'truenas_admin' });
  expect(svc.hasPassword).toBe(true);
  expect(svc.secret).toBeUndefined();
  expect(await s.getServiceSecret(svc.id)).toBe('1-testkey');
});

test('truenas: a plain-http url is refused, naming the key revocation', async () => {
  await expect(sealed().addService({ ...nasSpec, url: 'http://192.168.1.20' }))
    .rejects.toThrow(/revokes/i);
});

test('truenas: a plain-http check target is refused even when the tile url is https', async () => {
  await expect(sealed().addService({
    ...nasSpec, check: { kind: 'truenas', username: 'truenas_admin', target: 'http://192.168.1.20' },
  })).rejects.toThrow(/revokes/i);
});

test('truenas: an http tile url is still fine for an http check kind', async () => {
  const svc = await sealed().addService({ name: 'app', url: 'http://192.168.1.30:8080', check: { kind: 'http' } });
  expect(svc.url).toBe('http://192.168.1.30:8080');
});

test('truenas: a missing username is refused', async () => {
  await expect(sealed().addService({ ...nasSpec, check: { kind: 'truenas' } }))
    .rejects.toThrow(/username/i);
});

test('truenas: an untouched key survives an unrelated edit, and null clears it', async () => {
  const s = sealed();
  const svc = await s.addService(nasSpec);
  const renamed = await s.updateService(svc.id, { name: 'storage' });
  expect(renamed.hasPassword).toBe(true);
  expect(await s.getServiceSecret(svc.id)).toBe('1-testkey');

  const cleared = await s.updateService(svc.id, { password: null });
  expect(cleared.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
});

test('truenas: switching the tile to another kind drops the stored key', async () => {
  const s = sealed();
  const svc = await s.addService(nasSpec);
  const switched = await s.updateService(svc.id, { check: { kind: 'http' } });
  expect(switched.hasPassword).toBe(false);
  expect(await s.getServiceSecret(svc.id)).toBe(null);
});
