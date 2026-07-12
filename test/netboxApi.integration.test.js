import { test, expect, beforeAll, afterAll, describe } from 'vitest';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { testNetbox, createNetboxClient } from '../src/server/netboxApi.js';

// Requires openssl to mint an ephemeral chain (a Caddy-local-authority stand-in).
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

// The bug this covers: NetBox behind Caddy's internal CA serves leaf +
// intermediate and never the self-signed root, so the presented chain has no
// self-signed anchor and a CA store rebuilt from it fails with
// UNABLE_TO_GET_ISSUER_CERT even though the pinned fingerprint matched. Pin
// mode must verify the fingerprint on the request's own connection instead.
describe.runIf(opensslOk)('netboxApi TLS pinning (real node:https transport, Caddy chain shape)', () => {
  let server, port, dir, gotAuth;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbx-tls-'));
    const p = (name) => path.join(dir, name);
    fs.writeFileSync(p('ca.ext'), 'basicConstraints=critical,CA:TRUE\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', p('root-key.pem'), '-out', p('root-cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=test-root-ca'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-keyout', p('int-key.pem'), '-out', p('int.csr'), '-nodes', '-subj', '/CN=test-intermediate'], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-in', p('int.csr'), '-CA', p('root-cert.pem'), '-CAkey', p('root-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', p('ca.ext'), '-out', p('int-cert.pem')], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-keyout', p('leaf-key.pem'), '-out', p('leaf.csr'), '-nodes', '-subj', '/CN=netbox-test'], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-in', p('leaf.csr'), '-CA', p('int-cert.pem'), '-CAkey', p('int-key.pem'), '-CAcreateserial', '-days', '1', '-out', p('leaf-cert.pem')], { stdio: 'ignore' });
    server = https.createServer({
      cert: fs.readFileSync(p('leaf-cert.pem'), 'utf8') + fs.readFileSync(p('int-cert.pem'), 'utf8'), // root withheld
      key: fs.readFileSync(p('leaf-key.pem')),
    }, (req, res) => {
      gotAuth = req.headers.authorization || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/api/status/')) { res.end(JSON.stringify({ 'netbox-version': '4.3.2' })); return; }
      res.end(JSON.stringify({ count: 1, results: [{ id: 7, address: '192.168.1.10/24' }] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => { server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  // The stored settings pin the leaf's fingerprint, discovered like the UI
  // does (a token-less probe via testNetbox's no-pin failure shape).
  async function pinnedSettings() {
    const probe = await testNetbox({ url: `https://127.0.0.1:${port}`, tlsMode: 'pin', fingerprint256: null, token: 't' });
    expect(probe.ok).toBe(false); // no pin yet — but it reports the observed fingerprint
    return { url: `https://127.0.0.1:${port}`, tlsMode: 'pin', fingerprint256: probe.fingerprint256, token: 'tok123' };
  }

  test('pin mode test connection succeeds when the served chain never reaches a self-signed cert', async () => {
    const res = await testNetbox(await pinnedSettings());
    expect(res).toEqual({ ok: true, version: '4.3.2' });
  });

  test('pin mode client calls work against the intermediate-signed cert', async () => {
    const client = createNetboxClient(await pinnedSettings());
    expect(await client.findIpsByAddress('192.168.1.10')).toEqual([{ id: 7, address: '192.168.1.10/24' }]);
  });

  test('pin mode rejects a wrong fingerprint and never sends the token', async () => {
    gotAuth = null;
    const client = createNetboxClient({ url: `https://127.0.0.1:${port}`, tlsMode: 'pin', fingerprint256: 'DE:AD:BE:EF:00:11', token: 'SUPER-SECRET' });
    await expect(client.findIpsByAddress('192.168.1.10')).rejects.toThrow(/fingerprint/);
    expect(gotAuth).toBeNull();
  });
});
