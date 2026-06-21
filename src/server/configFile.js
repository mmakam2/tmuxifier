import fs from 'node:fs';

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
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}
