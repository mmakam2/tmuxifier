import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { shSingleQuote } from './sshCommand.js';

// Terminal file uploads (paste/drag-drop) land in this dir under the target's
// $HOME — a box over ssh (buildUploadRemote) or the Tmuxifier host itself
// (saveLocalUpload). Every upload opportunistically prunes files older than
// UPLOAD_PRUNE_MINUTES, so the dir is self-cleaning with no tracked state.
export const UPLOAD_DIR_NAME = '.tmuxifier-uploads';
export const UPLOAD_PRUNE_MINUTES = 1440; // 24h

// Basename only, no leading '-' (option injection) or '.' (hidden/traversal),
// conservative charset, capped length. The client sanitizes toward this rule;
// the server enforces it. The stored name (epoch-hex-name) matches it too.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

export function validUploadName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function storedUploadName(name, { now = Date.now(), rand = () => randomBytes(4).toString('hex') } = {}) {
  if (!validUploadName(name)) throw new Error('invalid upload filename');
  return `${now}-${rand()}-${name}`;
}

// sh script run on the box (stdin = file bytes): ensure the dir, prune, write,
// echo the absolute destination so the caller never guesses the remote $HOME.
// The name is validated above AND single-quoted, belt and braces.
export function buildUploadRemote(storedName) {
  if (!validUploadName(storedName)) throw new Error('invalid upload filename');
  const q = shSingleQuote(storedName);
  return [
    'set -eu',
    `dir="$HOME/${UPLOAD_DIR_NAME}"`,
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    `find "$dir" -type f -mmin +${UPLOAD_PRUNE_MINUTES} -delete 2>/dev/null || true`,
    `cat > "$dir/"${q}`,
    `printf '%s\\n' "$dir/"${q}`,
  ].join('\n');
}

// Same contract for the __local__ terminal: write under the Tmuxifier host's
// own $HOME, prune, return the absolute path.
export async function saveLocalUpload(storedName, buffer, { home = os.homedir(), now = Date.now() } = {}) {
  if (!validUploadName(storedName)) throw new Error('invalid upload filename');
  const dir = path.join(home, UPLOAD_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const cutoff = now - UPLOAD_PRUNE_MINUTES * 60000;
  for (const entry of await fs.readdir(dir)) {
    const p = path.join(dir, entry);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) await fs.unlink(p);
    } catch {}
  }
  const dest = path.join(dir, storedName);
  await fs.writeFile(dest, buffer, { mode: 0o600 });
  return dest;
}
