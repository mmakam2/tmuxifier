import { test, expect } from 'vitest';
import { readDefaultPublicKey } from '../src/server/defaultKey.js';

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
  };
}

test('a configured path is used exclusively (no auto-detect fallback)', () => {
  const fs = fakeFs({ '/custom/key.pub': 'ssh-ed25519 AAACustom you@host\n', '/home/u/.ssh/id_ed25519.pub': 'ssh-ed25519 AAAauto a' });
  expect(readDefaultPublicKey({ configuredPath: '/custom/key.pub', home: '/home/u', ...fs })).toBe('ssh-ed25519 AAACustom you@host');
  expect(readDefaultPublicKey({ configuredPath: '/missing.pub', home: '/home/u', ...fakeFs({}) })).toBeNull();
});

test('auto-detects ~/.ssh in id_ed25519 > id_rsa > id_ecdsa order', () => {
  expect(readDefaultPublicKey({ home: '/h', ...fakeFs({ '/h/.ssh/id_rsa.pub': 'ssh-rsa RSA a', '/h/.ssh/id_ed25519.pub': 'ssh-ed25519 ED a' }) })).toBe('ssh-ed25519 ED a');
  expect(readDefaultPublicKey({ home: '/h', ...fakeFs({ '/h/.ssh/id_rsa.pub': 'ssh-rsa RSA a' }) })).toBe('ssh-rsa RSA a');
});

test('returns null when no key is found', () => {
  expect(readDefaultPublicKey({ home: '/h', ...fakeFs({}) })).toBeNull();
  expect(readDefaultPublicKey({})).toBeNull();
});
