import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/server/auth.js';

const arg = process.argv[2];
let password = arg;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('New Tmuxifier password: ');
  rl.close();
}
const hash = await hashPassword(password);
const secret = randomBytes(32).toString('hex');
console.log('\nAdd these to config.json or your environment:\n');
console.log(`TMUXIFIER_PASSWORD_HASH=${hash}`);
console.log(`TMUXIFIER_COOKIE_SECRET=${secret}`);
