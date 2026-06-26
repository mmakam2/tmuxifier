import { test, expect } from 'vitest';
import { createProxmoxClient, inspectEndpoint } from '../src/server/proxmoxApi.js';

const HOST = { endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB:CD:EF' };

function fakeRequest(script) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return script(opts, calls.length - 1); };
  fn.calls = calls;
  return fn;
}

test('GET sends the token auth header to the right URL', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: [{ node: 'pve' }] } }));
  const client = createProxmoxClient({ host: HOST, request });
  const nodes = await client.nodes();
  expect(nodes).toEqual([{ node: 'pve' }]);
  expect(request.calls[0].url).toBe('https://pve.example.com:8006/api2/json/nodes');
  expect(request.calls[0].headers.Authorization).toBe('PVEAPIToken=user@pam!tmuxifier=sek');
});

test('createLxc form-encodes params and POSTs', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:pve:001' } }));
  const client = createProxmoxClient({ host: HOST, request });
  const upid = await client.createLxc('pve', { vmid: 123, hostname: 'dev-01', cores: 2, net0: 'name=eth0,bridge=vmbr0,ip=dhcp' });
  expect(upid).toBe('UPID:pve:001');
  const call = request.calls[0];
  expect(call.method).toBe('POST');
  expect(call.url).toBe('https://pve.example.com:8006/api2/json/nodes/pve/lxc');
  expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(call.body).toContain('vmid=123');
  expect(call.body).toContain('hostname=dev-01');
  expect(call.body).toContain('net0=name%3Deth0%2Cbridge%3Dvmbr0%2Cip%3Ddhcp');
});

test('maps 401 and 403 to clear errors', async () => {
  const c401 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 401, json: null })) });
  await expect(c401.version()).rejects.toThrow(/rejected|401/);
  const c403 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 403, json: null })) });
  await expect(c403.version()).rejects.toThrow(/permission|403/);
});

test('pin mode rejects a fingerprint mismatch and accepts a match', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  const client = createProxmoxClient({ host: HOST, request });
  await client.version();
  const check = request.calls[0].tls.checkServerIdentity;
  expect(request.calls[0].tls.rejectUnauthorized).toBe(false);
  expect(check('h', { fingerprint256: 'ab:cd:ef' })).toBeUndefined();          // case-insensitive match
  expect(check('h', { fingerprint256: '00:11' })).toBeInstanceOf(Error);
});

test('ca mode verifies normally; insecure disables verification', async () => {
  const reqCa = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'ca' }, request: reqCa }).version();
  expect(reqCa.calls[0].tls.rejectUnauthorized).toBe(true);
  const reqIns = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'insecure' }, request: reqIns }).version();
  expect(reqIns.calls[0].tls.rejectUnauthorized).toBe(false);
  expect(reqIns.calls[0].tls.checkServerIdentity).toBeUndefined();
});

test('inspectEndpoint returns the cert fingerprint and caValid; unreachable on throw', async () => {
  const ok = await inspectEndpoint('pve.example.com:8006', { request: fakeRequest(() => ({
    status: 200, json: { data: {} }, authorized: false,
    cert: { fingerprint256: 'AB:CD', subject: { CN: 'pve' }, issuer: { CN: 'pve' }, valid_to: 'Jan 1 2030' },
  })) });
  expect(ok).toMatchObject({ reachable: true, fingerprint256: 'AB:CD', subject: 'pve', caValid: false });
  const bad = await inspectEndpoint('down.example.com', { request: async () => { throw new Error('ECONNREFUSED'); } });
  expect(bad.reachable).toBe(false);
  expect(bad.error).toMatch(/ECONNREFUSED/);
});
