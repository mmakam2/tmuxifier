import tls from 'node:tls';

// Shared TLS fingerprint-pinning helpers (TOFU, like ssh accept-new) used by the
// Proxmox and NetBox API clients.
export function tlsProbe({ host, port, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    // SNI is only valid for hostnames, not IP literals (RFC 6066); omit it for IPs.
    const servername = /[A-Za-z]/.test(host) && !host.includes(':') ? host : undefined;
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate(true);
      const authorized = socket.authorized === true;
      socket.end();
      if (!cert || !cert.raw) { reject(new Error('no peer certificate presented')); return; }
      // Collect the whole presented chain, not just the leaf: a default PVE cert
      // (pve-ssl.pem) is signed by the node's cluster CA, and OpenSSL only anchors
      // trust at a self-signed cert — pinning the leaf alone can never verify the
      // stock Proxmox cert shape. issuerCertificate is self-referential on a
      // self-signed cert, so guard against the cycle.
      const chain = [];
      const seen = new Set();
      for (let c = cert; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        chain.push(c.raw);
      }
      resolve({ fingerprint256: cert.fingerprint256 || null, raw: cert.raw, chain, authorized, subject: cert.subject, issuer: cert.issuer, valid_to: cert.valid_to });
    });
    socket.on('timeout', () => socket.destroy(new Error('TLS connection timed out')));
    socket.on('error', reject);
  });
}

export function derToPem(der) { const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n'); return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`; }

export function normFp(s) { return String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }
