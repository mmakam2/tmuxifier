import tls from 'node:tls';

// Shared TLS fingerprint-pinning helpers (TOFU, like ssh accept-new) used by the
// Proxmox and NetBox API clients.
export function tlsProbe({ host, port, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    // SNI is only valid for hostnames, not IP literals (RFC 6066); omit it for IPs.
    const servername = /[A-Za-z]/.test(host) && !host.includes(':') ? host : undefined;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized === true;
      socket.end();
      if (!cert || !cert.raw) { reject(new Error('no peer certificate presented')); return; }
      resolve({ fingerprint256: cert.fingerprint256 || null, raw: cert.raw, authorized, subject: cert.subject, issuer: cert.issuer, valid_to: cert.valid_to });
    });
    socket.on('timeout', () => socket.destroy(new Error('TLS connection timed out')));
    socket.on('error', reject);
  });
}

// Pin-mode transport: connect, verify the peer leaf's fingerprint against the
// pin BEFORE http writes anything (the API token), then hand the socket over
// via the request's createConnection. OpenSSL chain verification is skipped
// deliberately — the pin IS the trust anchor, and a served chain that never
// reaches a self-signed cert (Caddy's local CA serves leaf+intermediate,
// never the root) can never satisfy a CA store rebuilt from it.
export function pinnedSocket({ host, port, fingerprint256, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const servername = /[A-Za-z]/.test(host) && !host.includes(':') ? host : undefined;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const fp = socket.getPeerCertificate()?.fingerprint256 || '';
      const want = normFp(fingerprint256);
      if (!want || normFp(fp) !== want) {
        socket.destroy();
        reject(new Error('TLS fingerprint mismatch — the certificate changed; re-pin to accept the new one'));
        return;
      }
      socket.setTimeout(0); // http's own timeout handling takes over from here
      resolve(socket);
    });
    socket.on('timeout', () => socket.destroy(new Error('TLS connection timed out')));
    socket.on('error', reject);
  });
}

export function normFp(s) { return String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }
