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

// Prompt without echoing: raw-mode TTY reads keep the password off the screen
// (the plain readline prompt echoed it). Non-TTY stdin (pipes, CI) falls back
// to a normal line read.
async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const value = await rl.question(question);
    rl.close();
    return value;
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '') { // Ctrl-C
        stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  let password = process.argv[2];
  if (password) {
    console.error('Warning: passing the password as an argument exposes it in shell history and `ps`; run without arguments to be prompted instead.');
  } else {
    password = await promptHidden('New Tmuxifier password: ');
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
