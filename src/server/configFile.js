import fs from 'node:fs';
import path from 'node:path';

export function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function upsertConfigFile(file, patch) {
  const current = readConfigFile(file);
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
