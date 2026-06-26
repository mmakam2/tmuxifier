import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Versioned scheme tag so the store can recognise (and one day migrate) sealed values.
const SCHEME = 'pvebox.v1';
// Distinct HKDF info label keeps this key disjoint from cookie signing even though both
// derive from cookieSecret.
const INFO = 'tmuxifier-pve-token-v1';

function deriveKey(cookieSecret) {
  if (!cookieSecret) throw new Error('secretBox requires a cookieSecret');
  // HKDF-SHA256 -> 32 bytes for AES-256. hkdfSync returns an ArrayBuffer.
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(cookieSecret)), Buffer.alloc(0), Buffer.from(INFO), 32));
}

export function createSecretBox(cookieSecret) {
  const key = deriveKey(cookieSecret);
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return `${SCHEME}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
    },
    open(sealed) {
      const parts = String(sealed).split(':');
      if (parts.length !== 4 || parts[0] !== SCHEME) throw new Error('unrecognized sealed secret');
      const [, ivb, ctb, tagb] = parts;
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
      d.setAuthTag(Buffer.from(tagb, 'base64'));
      return d.update(Buffer.from(ctb, 'base64'), undefined, 'utf8') + d.final('utf8');
    },
    isSealed(v) {
      return typeof v === 'string' && v.startsWith(`${SCHEME}:`);
    },
  };
}
