import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const COOKIE_NAME = 'tmuxifier_session';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = await scryptAsync(String(password), salt, expected.length);
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

export function cookieOptions(secure) {
  return { httpOnly: true, sameSite: 'lax', secure: !!secure, path: '/', signed: true, maxAge: 60 * 60 * 24 * 7 };
}
