import fs from 'node:fs';

// Minimal, dependency-free .env support. Tmuxifier keeps configuration inside
// the repo folder, so the server parses <cwd>/.env on startup and the
// set-password script writes to it. We parse directly (rather than mutating
// global process.env) so loadConfig stays pure and testable.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Rewrite only the given keys, preserving every other line (including comments).
// Existing keys are replaced in place; new keys are appended.
export function upsertEnvFile(file, updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
  } catch {
    lines = [];
  }
  const remaining = { ...updates };
  const next = lines.map((line) => {
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      const key = m[1];
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) {
    next.push(`${key}=${value}`);
  }
  const body = next.filter((l, i) => !(i === 0 && l === '')).join('\n');
  // .env holds the password hash and cookie secret, so keep it owner-only. The
  // mode option only applies when creating the file; chmod afterwards also
  // tightens a pre-existing file that may have looser permissions.
  fs.writeFileSync(file, body + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
