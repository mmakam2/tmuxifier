import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../src/server/auth.js';
import { readEnvFile, upsertEnvFile } from '../src/server/envFile.js';

// Upsert credentials into the repo-local .env so the app is configured without
// touching the shell environment. The password hash is always (re)written; a
// cookie secret is generated only when one is not already present, so changing
// the password does not silently rotate the secret and log everyone out.
export function writeCredentials(file, hash, { makeSecret = () => randomBytes(32).toString('hex') } = {}) {
  const existing = readEnvFile(file);
  const updates = { TMUXIFIER_PASSWORD_HASH: hash };
  const wroteSecret = !existing.TMUXIFIER_COOKIE_SECRET;
  if (wroteSecret) updates.TMUXIFIER_COOKIE_SECRET = makeSecret();
  upsertEnvFile(file, updates);
  return { wroteSecret };
}

async function main() {
  let password = process.argv[2];
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('New Tmuxifier password: ');
    rl.close();
  }
  const hash = await hashPassword(password);
  const envFile = path.join(process.cwd(), '.env');
  const { wroteSecret } = writeCredentials(envFile, hash);
  const rel = path.relative(process.cwd(), envFile) || '.env';
  console.log(
    wroteSecret
      ? `\nWrote password hash and a new cookie secret to ${rel}.`
      : `\nUpdated password hash in ${rel} (kept existing cookie secret).`,
  );
  console.log('Start the server with: npm start');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
