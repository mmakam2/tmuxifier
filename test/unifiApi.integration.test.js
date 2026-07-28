import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUnifiClient } from '../src/server/unifiApi.js';
import { tlsProbe } from '../src/server/tlsPin.js';
import { SITES } from './helpers/unifiSamples.js';

// Real TLS over the real node:https transport. The pinning path cannot be
// exercised through an injected request function, because the pin is enforced
// by the socket factory rather than by the client's own code.
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

describe.runIf(opensslOk)('unifiApi TLS pinning (self-signed controller certificate)', () => {
  let server, baseUrl, fingerprint, sawKey;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unifi-tls-'));
    const p = (n) => path.join(dir, n);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', p('key.pem'), '-out', p('cert.pem'),
      '-days', '1', '-nodes', '-subj', '/CN=unifi-test',
    ], { stdio: 'ignore' });
    server = https.createServer(
      { cert: fs.readFileSync(p('cert.pem')), key: fs.readFileSync(p('key.pem')) },
      (req, res) => {
        sawKey = req.headers['x-api-key'] || null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SITES));
      },
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `https://127.0.0.1:${server.address().port}`;
    fingerprint = (await tlsProbe({ host: '127.0.0.1', port: server.address().port })).fingerprint256;
  });

  afterAll(async () => { await new Promise((r) => server.close(r)); });

  test('a self-signed certificate is rejected in verify mode', async () => {
    const res = await createUnifiClient({ baseUrl, apiKey: 'k' }).probe();
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unreachable');
  });

  test('it is accepted in insecure mode', async () => {
    const res = await createUnifiClient({ baseUrl, apiKey: 'k', tls: 'insecure' }).probe();
    expect(res.ok).toBe(true);
  });

  test('it is accepted in pin mode with the matching fingerprint', async () => {
    sawKey = null;
    const res = await createUnifiClient({ baseUrl, apiKey: 'the-key', tls: 'pin', fingerprint }).probe();
    expect(res.ok).toBe(true);
    expect(sawKey).toBe('the-key');
  });

  test('the key is never sent when the pin does not match', async () => {
    sawKey = null;
    const res = await createUnifiClient({
      baseUrl, apiKey: 'the-key', tls: 'pin',
      fingerprint: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    }).probe();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fingerprint mismatch/i);
    expect(sawKey).toBeNull();
  });
});
