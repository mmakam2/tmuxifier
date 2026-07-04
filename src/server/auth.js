import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const COOKIE_NAME = 'tmuxifier_session';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

// Strict full-string hex: Buffer.from(hex) silently stops at the first invalid
// character, so without this a corrupted digest decoded to a ZERO-LENGTH buffer
// — scrypt then derived a zero-length key and timingSafeEqual(empty, empty)
// accepted any password. A corrupt hash must fail closed, never open.
const HEX_RE = /^(?:[0-9a-f]{2})+$/i;

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    if (!HEX_RE.test(saltHex) || !HEX_RE.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length < 32) return false; // hashPassword always writes 32 bytes
    const salt = Buffer.from(saltHex, 'hex');
    const dk = await scryptAsync(String(password), salt, expected.length);
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

export function cookieOptions(secure) {
  return { httpOnly: true, sameSite: 'lax', secure: !!secure, path: '/', signed: true, maxAge: 60 * 60 * 24 * 7 };
}
