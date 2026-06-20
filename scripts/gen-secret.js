import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnvFile, upsertEnvFile } from '../src/server/envFile.js';

// Google auth mode still needs TMUXIFIER_COOKIE_SECRET to sign the session and
// oauth cookies, but set-password also writes a password hash. This seeds only
// the cookie secret, and leaves an existing value untouched.
export function ensureCookieSecret(file, { makeSecret = () => randomBytes(32).toString('hex') } = {}) {
  if (readEnvFile(file).TMUXIFIER_COOKIE_SECRET) return { wrote: false };
  upsertEnvFile(file, { TMUXIFIER_COOKIE_SECRET: makeSecret() });
  return { wrote: true };
}

async function main() {
  const file = path.join(process.cwd(), '.env');
  const { wrote } = ensureCookieSecret(file);
  console.log(wrote ? 'Wrote a new cookie secret to .env.' : '.env already has a cookie secret; left it unchanged.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
