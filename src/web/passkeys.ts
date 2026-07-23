// Passkey fetch layer plus the pure helpers around the WebAuthn browser API.
// Everything that can be a pure function is one, so the five readiness states
// and the byte conversions are testable without a browser.

export interface PasskeyCredential {
  id: string; label: string; created: number | null; lastUsed: number | null; transports: string[];
}
export interface PasskeyState {
  credentials: PasskeyCredential[];
  rpId: string | null;
  storedRpId: string | null;
  passkeyOnly: boolean;
  killSwitch: boolean;
}
export interface OriginVerdict { ok: boolean; reason: string; hint: string }

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + (b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Ordered most-fundamental first: a browser that cannot do WebAuthn makes every
// later check moot, and a store pinned elsewhere explains a hostname mismatch
// better than the generic message would.
export function evaluateOrigin(
  { rpId, storedRpId, hostname, protocol, hasWebAuthn }:
  { rpId: string | null; storedRpId: string | null; hostname: string; protocol: string; hasWebAuthn: boolean },
): OriginVerdict {
  const host = hostname.toLowerCase();
  const normalizedRpId = rpId ? rpId.toLowerCase() : null;
  const normalizedStoredRpId = storedRpId ? storedRpId.toLowerCase() : null;

  if (!hasWebAuthn) {
    return { ok: false, reason: 'This browser does not support passkeys.', hint: 'Use a current version of Chrome, Safari, Firefox or Edge.' };
  }
  if (!normalizedRpId) {
    return {
      ok: false,
      reason: 'Passkeys need a domain name, and this server is reached by IP address.',
      hint: 'Set TMUXIFIER_RP_ID in .env (or point TMUXIFIER_BASE_EXTERNAL_URL at a hostname) and restart.',
    };
  }
  if (normalizedStoredRpId && normalizedStoredRpId !== normalizedRpId) {
    return {
      ok: false,
      reason: `The enrolled passkeys belong to ${storedRpId}, but this server is configured for ${rpId}.`,
      hint: `Reach Tmuxifier at ${storedRpId}, or remove every passkey here and enroll again.`,
    };
  }
  if (host !== normalizedRpId) {
    return {
      ok: false,
      reason: `Passkeys are bound to ${rpId}, but you are on ${hostname}.`,
      // Two independent remedies, not one: reaching Tmuxifier at the bound
      // hostname is right for a legitimate localhost-over-SSH-tunnel setup,
      // but on the far more common default-upgrade path — an existing
      // password-mode deployment behind a reverse proxy, where rpId derived
      // to "localhost" because TMUXIFIER_BASE_EXTERNAL_URL was never set —
      // the actual fix is pointing TMUXIFIER_RP_ID at the hostname already
      // in use. Naming only the first left that operator with no visible fix.
      hint: `Open Tmuxifier at https://${rpId}, or set TMUXIFIER_RP_ID to ${hostname} in .env and restart.`,
    };
  }
  if (protocol !== 'https:' && host !== 'localhost') {
    return { ok: false, reason: 'Passkeys require a secure connection.', hint: `Open Tmuxifier at https://${rpId}.` };
  }
  return { ok: true, reason: `Passkeys are bound to ${rpId}.`, hint: '' };
}

export function toRequestOptions(o: { challenge: string; rpId: string; timeout: number; userVerification: string }): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64uToBytes(o.challenge) as BufferSource,
    rpId: o.rpId,
    timeout: o.timeout,
    userVerification: o.userVerification as UserVerificationRequirement,
    allowCredentials: [],
  };
}

interface CreationOptionsJson {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  timeout: number;
  excludeCredentials: { id: string; transports?: string[] }[];
}

export function toCreationOptions(o: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    challenge: b64uToBytes(o.challenge) as BufferSource,
    rp: o.rp,
    user: { id: b64uToBytes(o.user.id) as BufferSource, name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    authenticatorSelection: o.authenticatorSelection,
    attestation: o.attestation,
    timeout: o.timeout,
    excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
      type: 'public-key' as const,
      id: b64uToBytes(c.id) as BufferSource,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

export function serializeRegistration(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    type: c.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      attestationObject: bytesToB64u(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

export function serializeAssertion(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    type: c.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      authenticatorData: bytesToB64u(r.authenticatorData),
      signature: bytesToB64u(r.signature),
      userHandle: r.userHandle ? bytesToB64u(r.userHandle) : null,
    },
  };
}

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const jsonBody = (method: string, v: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

interface SerializedRegistration {
  id: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
}

interface SerializedAssertion {
  id: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
}

export const pk = {
  state() { return jr<PasskeyState>(fetch('/api/passkeys')); },
  registerBegin() { return jr<CreationOptionsJson>(fetch('/api/passkeys/register/begin', { method: 'POST' })); },
  /** registerFinish accepts the full serialized credential from serializeRegistration and sends it to the server. */
  registerFinish(label: string, credential: SerializedRegistration) {
    return jr<{ credential: PasskeyCredential }>(fetch('/api/passkeys/register/finish', jsonBody('POST', { label, response: credential.response })));
  },
  remove(id: string) { return jr<{ ok: boolean; disarmed: boolean }>(fetch(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' })); },
  setOnly(enabled: boolean, assertion?: SerializedAssertion) {
    return jr<{ passkeyOnly: boolean }>(fetch('/api/passkeys/only', jsonBody('POST',
      assertion ? { enabled, id: assertion.id, response: assertion.response } : { enabled })));
  },
  onlyBegin() {
    return jr<{ challenge: string; rpId: string; timeout: number; userVerification: string }>(
      fetch('/api/passkeys/only/begin', { method: 'POST' }));
  },
  loginBegin() {
    return jr<{ challenge: string; rpId: string; timeout: number; userVerification: string }>(
      fetch('/api/auth/passkey/login/begin', { method: 'POST' }));
  },
  /** loginFinish accepts the full serialized assertion from serializeAssertion and sends it to the server. */
  loginFinish(assertion: SerializedAssertion) { return jr<{ ok: boolean }>(fetch('/api/auth/passkey/login/finish', jsonBody('POST', assertion))); },
};

// Thin wrappers so callers never touch navigator.credentials directly.
export async function createPasskey(options: CreationOptionsJson): Promise<PublicKeyCredential> {
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
  if (!cred) throw new Error('passkey creation was cancelled');
  return cred as PublicKeyCredential;
}

export async function getPasskey(options: { challenge: string; rpId: string; timeout: number; userVerification: string }): Promise<PublicKeyCredential> {
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
  if (!cred) throw new Error('passkey sign-in was cancelled');
  return cred as PublicKeyCredential;
}

export const hasWebAuthn = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
