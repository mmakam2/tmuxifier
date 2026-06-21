import fs from 'node:fs';
import path from 'node:path';

export function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // File exists but is not valid JSON — throw so callers don't silently
    // overwrite a broken file with partial data.
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

export function upsertConfigFile(file, patch) {
  const current = readConfigFile(file);
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
