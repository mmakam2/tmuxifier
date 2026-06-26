import { test, expect, beforeAll, afterAll, describe } from 'vitest';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProxmoxClient, inspectEndpoint } from '../src/server/proxmoxApi.js';

// Requires openssl to mint an ephemeral self-signed cert (a default-Proxmox stand-in).
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

describe.runIf(opensslOk)('proxmoxApi TLS pinning (real node:https transport)', () => {
  let server, port, dir, gotAuth, gotHeaders;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-tls-'));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile, '-days', '1', '-nodes', '-subj', '/CN=pve-test'], { stdio: 'ignore' });
    server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
      gotAuth = req.headers.authorization || null;
      gotHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { version: '8.2' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => { server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('pin mode connects when the presented cert matches the pinned fingerprint', async () => {
    const insp = await inspectEndpoint(`127.0.0.1:${port}`);
    expect(insp.reachable).toBe(true);
    expect(insp.caValid).toBe(false); // self-signed
    const client = createProxmoxClient({ host: { endpoint: `127.0.0.1:${port}`, tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: insp.fingerprint256 } });
    expect(await client.version()).toEqual({ version: '8.2' });
  });

  test('pin mode rejects a changed cert and never sends the token', async () => {
    gotAuth = null;
    const client = createProxmoxClient({ host: { endpoint: `127.0.0.1:${port}`, tokenId: 'user@pam!t', tokenSecret: 'SUPER-SECRET', verifyMode: 'pin', fingerprint256: 'DE:AD:BE:EF:00:11' } });
    await expect(client.version()).rejects.toThrow(/fingerprint/);
    expect(gotAuth).toBeNull(); // the token-bearing request was never sent to the impostor
  });

  test('ca mode rejects a self-signed cert cleanly (no ERR_INTERNAL_ASSERTION crash)', async () => {
    const client = createProxmoxClient({ host: { endpoint: `127.0.0.1:${port}`, tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'ca' } });
    const err = await client.version().then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(String(err.code || err.message)).not.toContain('ERR_INTERNAL_ASSERTION');
    expect(String(err.code || err.message)).toMatch(/SELF_SIGNED|DEPTH_ZERO|certificate/i);
  });

  test('POST sends a Content-Length, not chunked transfer-encoding (PVE rejects chunked bodies)', async () => {
    const insp = await inspectEndpoint(`127.0.0.1:${port}`);
    const client = createProxmoxClient({ host: { endpoint: `127.0.0.1:${port}`, tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: insp.fingerprint256 } });
    await client.createLxc('pve', { vmid: 123, hostname: 'dev-01', net0: 'name=eth0,bridge=vmbr0,ip=dhcp' });
    expect(gotHeaders['content-length']).toBeDefined();
    expect(gotHeaders['transfer-encoding']).toBeUndefined();
  });
});
