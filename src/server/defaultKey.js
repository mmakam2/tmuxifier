import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Reads the Tmuxifier host's own SSH public key to inject as the always-on default management
// key, so Tmuxifier can SSH into the containers it provisions. Pure/injectable: tests pass fake
// fs + derivePub. A configured path is used exclusively; otherwise a standard `.pub` file is read,
// and if only the private key exists (no `.pub`), the public key is derived from it via
// `ssh-keygen -y`. Async because that derive shells out — a synchronous child (up to its 5s
// timeout) would stall the event loop and freeze every open terminal. Resolves to the trimmed
// public key line, or null if none is found.
const PUB_CANDIDATES = ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub'];
const PRIV_CANDIDATES = ['id_ed25519', 'id_rsa', 'id_ecdsa'];

// Caches the read as a PROMISE so concurrent first calls share one ssh-keygen
// child instead of racing separate ones. A null result or a rejection is not
// cached — a key added later is still picked up without a restart.
export function createDefaultKeyProvider({ read }) {
  let cached = null;
  return () => {
    cached ??= read().then(
      (key) => { if (!key) cached = null; return key; },
      (err) => { cached = null; throw err; },
    );
    return cached;
  };
}

async function defaultDerivePub(privPath) {
  // -y prints the public key for a private key. Non-interactive (stdin is a pipe, so no TTY
  // passphrase prompt) and time-bounded so an encrypted key can't hang provisioning.
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', privPath], { timeout: 5000 });
    return String(stdout).split(/\r?\n/)[0].trim();
  } catch { return null; }
}

function firstLine(s) { return String(s).split(/\r?\n/)[0].trim(); }

export async function readDefaultPublicKey({ configuredPath, home, readFileSync = fs.readFileSync, existsSync = fs.existsSync, derivePub = defaultDerivePub } = {}) {
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
    if (existsSync(p)) { const k = await derivePub(p); if (k) return firstLine(k); }
  }
  return null;
}
