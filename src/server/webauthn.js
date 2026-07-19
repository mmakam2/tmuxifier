// Dependency-free WebAuthn verification, in the spirit of googleAuth.js. Scope
// is deliberately bounded: we request attestation "none", so no attestation
// statement is ever parsed — which is what keeps this small enough to own.
//
// CBOR appears ONLY in registration (the attestation object). The login
// assertion path below touches none of it.

// Only the subset authenticators actually emit: unsigned ints, negative ints,
// byte strings, text strings, arrays, maps. Indefinite lengths, tags, floats
// and simple values are refused rather than guessed at.
function readUint(buf, pos, ai) {
  if (ai < 24) return [ai, pos];
  if (ai === 24) { if (pos + 1 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt8(pos), pos + 1]; }
  if (ai === 25) { if (pos + 2 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt16BE(pos), pos + 2]; }
  if (ai === 26) { if (pos + 4 > buf.length) throw new Error('cbor: truncated'); return [buf.readUInt32BE(pos), pos + 4]; }
  if (ai === 27) {
    if (pos + 8 > buf.length) throw new Error('cbor: truncated');
    const n = buf.readBigUInt64BE(pos);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large');
    return [Number(n), pos + 8];
  }
  throw new Error(`cbor: unsupported additional info ${ai}`);
}

function readItem(buf, pos) {
  if (pos >= buf.length) throw new Error('cbor: truncated');
  const initial = buf[pos];
  const major = initial >> 5;
  const ai = initial & 0x1f;
  if (ai === 31) throw new Error('cbor: indefinite length not supported');
  const start = pos + 1;
  if (major === 0) { const [n, p] = readUint(buf, start, ai); return [n, p]; }
  if (major === 1) { const [n, p] = readUint(buf, start, ai); return [-1 - n, p]; }
  if (major === 2 || major === 3) {
    const [len, p] = readUint(buf, start, ai);
    if (p + len > buf.length) throw new Error('cbor: truncated');
    const slice = buf.subarray(p, p + len);
    return [major === 2 ? slice : slice.toString('utf8'), p + len];
  }
  if (major === 4) {
    const [len, p0] = readUint(buf, start, ai);
    const arr = [];
    let p = p0;
    for (let i = 0; i < len; i++) { const [v, np] = readItem(buf, p); arr.push(v); p = np; }
    return [arr, p];
  }
  if (major === 5) {
    const [len, p0] = readUint(buf, start, ai);
    const map = new Map();
    let p = p0;
    for (let i = 0; i < len; i++) {
      const [k, kp] = readItem(buf, p);
      const [v, vp] = readItem(buf, kp);
      if (map.has(k)) throw new Error('cbor: duplicate map key');
      map.set(k, v);
      p = vp;
    }
    return [map, p];
  }
  throw new Error(`cbor: unsupported major type ${major}`);
}

// `end` lets callers trim trailing bytes — the COSE public key inside attested
// credential data is followed by extension data when the ED flag is set.
export function cborDecodeFirst(buf) {
  const [value, end] = readItem(Buffer.from(buf), 0);
  return { value, end };
}
