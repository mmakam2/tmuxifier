import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Reads the Tmuxifier host's own SSH public key to inject as the always-on default management
// key, so Tmuxifier can SSH into the containers it provisions. Pure/injectable: tests pass fake
// fs + derivePub. A configured path is used exclusively; otherwise a standard `.pub` file is read,
// and if only the private key exists (no `.pub`), the public key is derived from it via
// `ssh-keygen -y`. Returns the trimmed public key line, or null if none is found.
const PUB_CANDIDATES = ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub'];
const PRIV_CANDIDATES = ['id_ed25519', 'id_rsa', 'id_ecdsa'];

function defaultDerivePub(privPath) {
  // -y prints the public key for a private key. Non-interactive (no TTY for a passphrase prompt)
  // and time-bounded so an encrypted key can't hang provisioning.
  try {
    return String(execFileSync('ssh-keygen', ['-y', '-f', privPath], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }))
      .split(/\r?\n/)[0].trim();
  } catch { return null; }
}

function firstLine(s) { return String(s).split(/\r?\n/)[0].trim(); }

export function readDefaultPublicKey({ configuredPath, home, readFileSync = fs.readFileSync, existsSync = fs.existsSync, derivePub = defaultDerivePub } = {}) {
  if (configuredPath) {
    try { const k = firstLine(readFileSync(configuredPath, 'utf8')); if (k) return k; } catch { /* */ }
    return null; // a configured path is exclusive — no auto-detect fallback
  }
  if (!home) return null;
  for (const name of PUB_CANDIDATES) {
    const p = path.join(home, '.ssh', name);
    try { if (existsSync(p)) { const k = firstLine(readFileSync(p, 'utf8')); if (k) return k; } } catch { /* try next */ }
  }
  // No `.pub` present — derive it from the private key (the common case).
  for (const name of PRIV_CANDIDATES) {
    const p = path.join(home, '.ssh', name);
    if (existsSync(p)) { const k = derivePub(p); if (k) return firstLine(k); }
  }
  return null;
}
