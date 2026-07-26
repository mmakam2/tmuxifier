import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServicesStore } from '../src/server/servicesStore.js';

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
