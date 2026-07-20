// Real keypairs and real signatures — no mocks. A fixture authenticator behaves
// like the genuine article, so a verifier bug shows up as a failing test rather
// than a passing one against a hand-waved stub.
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { enc } from './cbor.js';

export const b64u = (b) => Buffer.from(b).toString('base64url');

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export function makeAuthenticator({ credentialId = Buffer.from('cred-0001') } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = enc(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  return { credentialId, privateKey, publicKey, cose, id: b64u(credentialId) };
}

export function buildAuthData({ rpId, flags, signCount = 0, attested = null }) {
  const head = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(signCount, 33);
  if (!attested) return head;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(attested.credentialId.length, 0);
  return Buffer.concat([head, Buffer.alloc(16), idLen, attested.credentialId, attested.cose]);
}

export function buildClientData({ type, challenge, origin }) {
  return Buffer.from(JSON.stringify({ type, challenge: b64u(challenge), origin, crossOrigin: false }), 'utf8');
}

function esSign(privateKey, data) {
  return createSign('sha256').update(data).sign(privateKey);
}

export function makeAssertion({
  authenticator, challenge, origin, rpId,
  signCount = 1, flags = FLAG_UP | FLAG_UV, tamper = null,
}) {
  const authData = buildAuthData({ rpId, flags, signCount });
  const clientDataJSON = buildClientData({ type: 'webauthn.get', challenge, origin });
  const signature = esSign(authenticator.privateKey, Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]));
  if (tamper === 'signature') signature[signature.length - 1] ^= 0xff;
  return {
    id: authenticator.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      userHandle: null,
    },
  };
}
