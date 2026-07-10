import { test, expect, afterEach } from 'vitest';
import { pve } from '../src/web/proxmox.ts';

// proxmox.ts calls the global fetch; stub it with a fake Response and restore after each test.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return response; };
  return calls;
}

test('pve.inspect resolves the parsed JSON body (jr must await the fetch promise)', async () => {
  const body = { reachable: true, fingerprint256: 'AB:CD', subject: 'pve', issuer: 'pve', validTo: 'x', caValid: false };
  const calls = stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => body });
  const r = await pve.inspect('pve.example.com:8006');
  expect(r).toEqual(body);
  expect(calls[0].url).toBe('/api/proxmox/inspect');
  expect(calls[0].opts.method).toBe('POST');
  expect(JSON.parse(calls[0].opts.body)).toEqual({ endpoint: 'pve.example.com:8006' });
});

test('pve.hosts resolves a GET JSON body', async () => {
  const hosts = [{ id: 'h1', name: 'lab', hasToken: true }];
  stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => hosts });
  expect(await pve.hosts()).toEqual(hosts);
});

test('a non-ok response rejects with the server error message', async () => {
  stubFetch({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'invalid endpoint' }) });
  await expect(pve.inspect('bad host')).rejects.toThrow(/invalid endpoint/);
});

test('pve.updatePreset sends the full spec as JSON with PUT', async () => {
  const updated = { id: 'P1', name: 'production', cores: 4 };
  const calls = stubFetch({ ok: true, status: 200, statusText: 'OK', json: async () => updated });
  const spec = { name: 'production', cores: 4 };

  expect(await pve.updatePreset('P1', spec)).toEqual(updated);
  expect(calls[0].url).toBe('/api/proxmox/presets/P1');
  expect(calls[0].opts).toMatchObject({
    method: 'PUT', headers: { 'content-type': 'application/json' },
  });
  expect(JSON.parse(calls[0].opts.body)).toEqual(spec);
});
