import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A real HTTPS server standing in for a Proxmox API, so e2e drives the actual add-host
// and test paths (no mocks — the repo convention). Its certificate is ephemeral and
// self-signed, the default-Proxmox shape: Inspect reports it as not CA-valid and the UI
// pins it. Every request is answered with a PVE data envelope carrying `version`.
// close() is how a spec turns a healthy host into one that stopped answering.
//
// Needs openssl to mint the certificate; a missing one fails loudly rather than skipping.
export async function startFakePve({ version = '8.2.4' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pve-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=fake-pve'], { stdio: 'ignore' });

  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { version, release: version.split('.').slice(0, 2).join('.'), repoid: 'fake' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  let closed = false;
  return {
    endpoint: `127.0.0.1:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
