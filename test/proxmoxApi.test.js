import { test, expect } from 'vitest';
import { createProxmoxClient, inspectEndpoint } from '../src/server/proxmoxApi.js';

const HOST = { endpoint: 'pve.example.com:8006', tokenId: 'user@pam!tmuxifier', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB:CD:EF' };

function fakeRequest(script) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return script(opts, calls.length - 1); };
  fn.calls = calls;
  return fn;
}
// Fake token-less TLS pre-flight: returns a peer cert whose fingerprint matches HOST by default.
function fakeConnect(fingerprint256 = 'ab:cd:ef') {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return { fingerprint256, raw: Buffer.from('genuine-cert-der'), authorized: false, subject: { CN: 'pve' }, issuer: { CN: 'pve' }, valid_to: 'Jan 1 2030' }; };
  fn.calls = calls;
  return fn;
}

test('GET sends the token auth header to the right URL (pin pre-flight matches)', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: [{ node: 'pve' }] } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  const nodes = await client.nodes();
  expect(nodes).toEqual([{ node: 'pve' }]);
  expect(request.calls[0].url).toBe('https://pve.example.com:8006/api2/json/nodes');
  expect(request.calls[0].headers.Authorization).toBe('PVEAPIToken=user@pam!tmuxifier=sek');
});

test('createLxc form-encodes params and POSTs', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:pve:001' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
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
  const c401 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 401, json: null })), connect: fakeConnect() });
  await expect(c401.version()).rejects.toThrow(/rejected|401/);
  const c403 = createProxmoxClient({ host: HOST, request: fakeRequest(() => ({ status: 403, json: null })), connect: fakeConnect() });
  await expect(c403.version()).rejects.toThrow(/permission|403/);
});

test('surfaces the PVE status message (and body) so errors like 501 are not opaque', async () => {
  const c = createProxmoxClient({ host: HOST, connect: fakeConnect(), request: fakeRequest(() => ({ status: 501, statusMessage: "Method 'POST /nodes/x/lxc' not implemented", json: null })) });
  await expect(c.version()).rejects.toThrow(/501.*not implemented/i);
  const cb = createProxmoxClient({ host: HOST, connect: fakeConnect(), request: fakeRequest(() => ({ status: 500, json: { errors: { vmid: 'already exists' } } })) });
  await expect(cb.version()).rejects.toThrow(/already exists/);
});

test('pin mode: a fingerprint mismatch rejects BEFORE the token-bearing request is sent', async () => {
  // match -> the real request carries the pin for the transport to verify on
  // its own connection (pinnedSocket)
  const reqOk = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: HOST, request: reqOk, connect: fakeConnect('AB:CD:EF') }).version();
  expect(reqOk.calls[0].tls).toEqual({ pin: HOST.fingerprint256 });
  // mismatch -> throws, and the token-bearing request is NEVER made (no token leak)
  const reqBad = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await expect(createProxmoxClient({ host: HOST, request: reqBad, connect: fakeConnect('00:11:22') }).version()).rejects.toThrow(/fingerprint/);
  expect(reqBad.calls).toHaveLength(0);
});

test('ca mode verifies normally (no checkServerIdentity, no ca pin) and does not pre-flight; insecure disables verification', async () => {
  const reqCa = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  const caConnect = fakeConnect();
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'ca' }, request: reqCa, connect: caConnect }).version();
  expect(reqCa.calls[0].tls.rejectUnauthorized).toBe(true);
  expect(reqCa.calls[0].tls.checkServerIdentity).toBeUndefined();
  expect(reqCa.calls[0].tls.ca).toBeUndefined();
  expect(caConnect.calls).toHaveLength(0);
  const reqIns = fakeRequest(() => ({ status: 200, json: { data: {} } }));
  await createProxmoxClient({ host: { ...HOST, verifyMode: 'insecure' }, request: reqIns, connect: fakeConnect() }).version();
  expect(reqIns.calls[0].tls.rejectUnauthorized).toBe(false);
});

test('inspectEndpoint returns the cert fingerprint and caValid; unreachable on throw', async () => {
  const ok = await inspectEndpoint('pve.example.com:8006', { connect: async () => ({ fingerprint256: 'AB:CD', raw: Buffer.from('x'), authorized: false, subject: { CN: 'pve' }, issuer: { CN: 'pve' }, valid_to: 'Jan 1 2030' }) });
  expect(ok).toMatchObject({ reachable: true, fingerprint256: 'AB:CD', subject: 'pve', caValid: false });
  const bad = await inspectEndpoint('down.example.com', { connect: async () => { throw new Error('ECONNREFUSED'); } });
  expect(bad.reachable).toBe(false);
  expect(bad.error).toMatch(/ECONNREFUSED/);
});

test('listLxc and lifecycle methods encode node/vmid into exact PVE paths', async () => {
  const request = fakeRequest((opts, index) => ({
    status: 200,
    json: { data: index === 0 ? [{ vmid: 131, name: 'dev-01', status: 'running' }] : `UPID:${index}` },
  }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });

  expect(await client.listLxc('pve/a')).toEqual([{ vmid: 131, name: 'dev-01', status: 'running' }]);
  await client.startLxc('pve/a', 131);
  await client.shutdownLxc('pve/a', 131);
  await client.stopLxc('pve/a', 131);
  await client.rebootLxc('pve/a', 131);
  await client.destroyLxc('pve/a', 131);

  expect(request.calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['GET', '/api2/json/nodes/pve%2Fa/lxc'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/start'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/shutdown'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/stop'],
    ['POST', '/api2/json/nodes/pve%2Fa/lxc/131/status/reboot'],
    ['DELETE', '/api2/json/nodes/pve%2Fa/lxc/131'],
  ]);
  // DELETE params ride the query string (pveproxy 501s a DELETE with a body);
  // POST params stay in the form body.
  const destroyQuery = new URL(request.calls[5].url).search;
  expect(destroyQuery).toContain('purge=1');
  expect(destroyQuery).toContain('destroy-unreferenced-disks=1');
  expect(destroyQuery).not.toContain('force=1');
  expect(request.calls[5].body).toBeUndefined();
  expect(request.calls[2].body).toContain('forceStop=0');
});

test('clusterResources lists cluster-wide guests with their current node', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: [
    { vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'mcmcreativedev01' },
    { vmid: 200, node: 'proxmox02', type: 'qemu', status: 'running', name: 'a-vm' },
  ] } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  const list = await client.clusterResources();
  expect(request.calls[0].url).toBe('https://pve.example.com:8006/api2/json/cluster/resources?type=vm');
  expect(request.calls[0].method).toBe('GET');
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ vmid: 165, node: 'proxmox03', type: 'lxc' });
});

test('destroyLxc puts purge params in the query string — pveproxy 501s any DELETE with a body', async () => {
  const request = fakeRequest(() => ({ status: 200, json: { data: 'UPID:pve:002' } }));
  const client = createProxmoxClient({ host: HOST, request, connect: fakeConnect() });
  const upid = await client.destroyLxc('pve', 132);
  expect(upid).toBe('UPID:pve:002');
  const call = request.calls[0];
  expect(call.method).toBe('DELETE');
  expect(call.url).toBe('https://pve.example.com:8006/api2/json/nodes/pve/lxc/132?purge=1&destroy-unreferenced-disks=1');
  expect(call.body).toBeUndefined();
  expect(call.headers['Content-Type']).toBeUndefined();
});
