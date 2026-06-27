import fs from 'node:fs';
import path from 'node:path';

// Reads the Tmuxifier host's own SSH public key to inject as the always-on default management
// key, so Tmuxifier can SSH into the containers it provisions. Pure/injectable: tests pass a fake
// fs. A configured path is used exclusively (no auto-detect fallback); otherwise the standard key
// names are tried in order. Returns the trimmed first line, or null if none is found/readable.
const CANDIDATES = ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub'];

export function readDefaultPublicKey({ configuredPath, home, readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  const paths = configuredPath ? [configuredPath] : (home ? CANDIDATES.map((n) => path.join(home, '.ssh', n)) : []);
  for (const p of paths) {
    try {
      if (existsSync && !existsSync(p)) continue;
      const first = String(readFileSync(p, 'utf8')).split(/\r?\n/)[0].trim();
      if (first) return first;
    } catch { /* unreadable — try the next candidate */ }
  }
  return null;
}
