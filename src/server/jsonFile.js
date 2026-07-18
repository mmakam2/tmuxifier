import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Shared persistence for the JSON data files under data/. Two guarantees the
// plain readFile/writeFile pattern lacked:
//
// - Writes land in a temp file that is fsync()ed and then rename()d into
//   place, so neither a process crash nor a power loss mid-write can truncate
//   the live file (without the fsync, the journal could commit the rename
//   before the data blocks — the classic delayed-allocation zero-length file).
// - A file that exists but does not parse (or fails the caller's shape check)
//   is moved aside to <file>.corrupt-<timestamp> and reported instead of being
//   silently read as empty — the old behavior let the next write permanently
//   destroy the original contents (the box list, the sealed Proxmox secrets).
//   Only a missing file (ENOENT) reads as the fallback; other read errors
//   (EACCES, EISDIR, …) are rethrown, because masking those as "empty" invites
//   the same destructive rewrite.

let seq = 0;
const tmpName = (file) => `${file}.${process.pid}.${seq++}.tmp`;
const corruptName = (file) => `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;

function parseChecked(raw, validate) {
  const v = JSON.parse(raw);
  if (validate && !validate(v)) throw new Error('unexpected shape');
  return v;
}

function corruptMessage(file, dest, err) {
  return `[tmuxifier] ${file} is unreadable (${err.message}); moved it aside to ${dest} and starting empty`;
}

export function readJsonSync(file, { fallback, validate, onCorrupt = (msg) => console.error(msg) } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return parseChecked(raw, validate);
  } catch (e) {
    const dest = corruptName(file);
    try { fs.renameSync(file, dest); } catch { /* leave the original in place */ }
    onCorrupt(corruptMessage(file, dest, e));
    return fallback;
  }
}

export async function readJson(file, { fallback, validate, onCorrupt = (msg) => console.error(msg) } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return parseChecked(raw, validate);
  } catch (e) {
    const dest = corruptName(file);
    try { await fsp.rename(file, dest); } catch { /* leave the original in place */ }
    onCorrupt(corruptMessage(file, dest, e));
    return fallback;
  }
}

export function writeFileAtomicSync(file, text, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd); // data blocks on disk BEFORE the rename is journaled
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export async function writeFileAtomic(file, text, { mode = 0o600 } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    const fh = await fsp.open(tmp, 'w', mode);
    try {
      await fh.writeFile(text);
      await fh.sync(); // data blocks on disk BEFORE the rename is journaled
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* already gone */ }
    throw e;
  }
}

export function writeJsonSync(file, value, opts) {
  writeFileAtomicSync(file, JSON.stringify(value, null, 2), opts);
}

export async function writeJson(file, value, opts) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2), opts);
}
