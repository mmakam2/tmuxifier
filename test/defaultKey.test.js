import { test, expect } from 'vitest';
import { readDefaultPublicKey } from '../src/server/defaultKey.js';

// readDefaultPublicKey is async: deriving from a private key shells out to
// ssh-keygen, and a synchronous child process (up to its 5s timeout) would
// stall the event loop — freezing every open terminal (review L22).

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
  };
}

test('a configured path is used exclusively (no auto-detect fallback)', async () => {
  const fs = fakeFs({ '/custom/key.pub': 'ssh-ed25519 AAACustom you@host\n', '/home/u/.ssh/id_ed25519.pub': 'ssh-ed25519 AAAauto a' });
  await expect(readDefaultPublicKey({ configuredPath: '/custom/key.pub', home: '/home/u', ...fs })).resolves.toBe('ssh-ed25519 AAACustom you@host');
  await expect(readDefaultPublicKey({ configuredPath: '/missing.pub', home: '/home/u', ...fakeFs({}) })).resolves.toBeNull();
});

test('auto-detects ~/.ssh in id_ed25519 > id_rsa > id_ecdsa order', async () => {
  await expect(readDefaultPublicKey({ home: '/h', ...fakeFs({ '/h/.ssh/id_rsa.pub': 'ssh-rsa RSA a', '/h/.ssh/id_ed25519.pub': 'ssh-ed25519 ED a' }) })).resolves.toBe('ssh-ed25519 ED a');
  await expect(readDefaultPublicKey({ home: '/h', ...fakeFs({ '/h/.ssh/id_rsa.pub': 'ssh-rsa RSA a' }) })).resolves.toBe('ssh-rsa RSA a');
});

test('derives the public key from a private key when no .pub exists (async derive)', async () => {
  const fs = { existsSync: (p) => p === '/h/.ssh/id_ed25519', readFileSync: () => { throw new Error('ENOENT'); } };
  const derivePub = async (p) => (p === '/h/.ssh/id_ed25519' ? 'ssh-ed25519 DERIVED host\n' : null);
  await expect(readDefaultPublicKey({ home: '/h', ...fs, derivePub })).resolves.toBe('ssh-ed25519 DERIVED host');
});

test('returns null when no key is found', async () => {
  await expect(readDefaultPublicKey({ home: '/h', ...fakeFs({}), derivePub: async () => null })).resolves.toBeNull();
  await expect(readDefaultPublicKey({})).resolves.toBeNull();
});

test('provider caches the in-flight promise: concurrent first calls share one read', async () => {
  const { createDefaultKeyProvider } = await import('../src/server/defaultKey.js');
  let reads = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const provider = createDefaultKeyProvider({ read: async () => { reads += 1; await gate; return 'ssh-ed25519 K'; } });
  const [a, b] = [provider(), provider()];
  release();
  expect(await a).toBe('ssh-ed25519 K');
  expect(await b).toBe('ssh-ed25519 K');
  await provider();
  expect(reads).toBe(1);
});

test('provider does not cache a null result or a rejection', async () => {
  const { createDefaultKeyProvider } = await import('../src/server/defaultKey.js');
  let n = 0;
  const p1 = createDefaultKeyProvider({ read: async () => (++n === 1 ? null : 'ssh-rsa X') });
  expect(await p1()).toBeNull();
  expect(await p1()).toBe('ssh-rsa X');
  let m = 0;
  const p2 = createDefaultKeyProvider({ read: async () => { if (++m === 1) throw new Error('boom'); return 'k'; } });
  await expect(p2()).rejects.toThrow('boom');
  expect(await p2()).toBe('k');
});
