// Pure half of the Settings → Proxmox tab: every word the operator reads and every
// decision the forms make before they call the server. settingsProxmox.ts is the
// DOM half and only paints what this returns (vitest has no DOM, so the logic that
// can be wrong lives here where it is tested).
//
// Text that came from the network (a PVE version, a connection error, a public key)
// is untrusted: it is shaped here and rendered with textContent only.
import type { InspectResult } from './proxmox';

export type VerifyMode = 'pin' | 'ca' | 'insecure';
export type Tone = 'plain' | 'warn';

// --- TLS mode legend --------------------------------------------------------

export interface VerifyFace { label: string; tone: Tone; title: string }

export function verifyFace(mode: string): VerifyFace {
  switch (mode) {
    case 'ca':
      return { label: 'CA verified', tone: 'plain', title: 'The certificate is checked against the system CA store.' };
    case 'pin':
      return { label: 'pinned', tone: 'plain', title: 'A self-signed certificate: only the pinned fingerprint is trusted.' };
    case 'insecure':
      return { label: 'not verified', tone: 'warn', title: 'TLS verification is off. The API token is sent to whatever answers at this address.' };
    default:
      // A mode this build does not know came from a store written by something else.
      // Never present it as safe.
      return { label: 'not verified', tone: 'warn', title: 'Unrecognised TLS mode. Treat this host as unverified.' };
  }
}

// --- Host state -------------------------------------------------------------

export type HostCheck =
  | { phase: 'checking' }
  | { phase: 'ok'; version: unknown }
  | { phase: 'error'; message: string };

export interface HostState { lamp: 'off' | 'green' | 'red'; text: string; tone: 'plain' | 'err' }

export function hostStateOf(check: HostCheck): HostState {
  if (check.phase === 'checking') return { lamp: 'off', text: 'Checking…', tone: 'plain' };
  if (check.phase === 'ok') {
    const v = formatVersion(check.version);
    return { lamp: 'green', text: v ? `Reachable · ${v}` : 'Reachable', tone: 'plain' };
  }
  return { lamp: 'red', text: check.message.trim() || 'Test failed', tone: 'err' };
}

// `GET /version` answers { version, release, repoid }. Only a short, plain version
// string is shown; anything else is dropped rather than echoed.
const VERSION_RE = /^[0-9A-Za-z.+~-]{1,24}$/;
export function formatVersion(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const raw = (v as { version?: unknown }).version;
  return typeof raw === 'string' && VERSION_RE.test(raw) ? `PVE ${raw}` : null;
}

// --- Public key display -----------------------------------------------------

export interface KeyParts { type: string; body: string; comment: string }

// OpenSSH's algorithm names: ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, sk-ssh-ed25519@openssh.com, …
const KEY_TYPE_RE = /^(?:ssh|ecdsa-sha2|sk-ssh|sk-ecdsa-sha2)-[a-z0-9@.-]{1,40}$/;
const KEY_BODY_RE = /^[A-Za-z0-9+/=]+$/;
const KEY_HEAD = 12;
const KEY_TAIL = 8;

// "<type> <base64> [comment]" → the three parts, the body shortened to its two
// ends (enough to recognise a key by eye). Null when it is not that shape.
export function splitPublicKey(raw: unknown): KeyParts | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!m || !KEY_TYPE_RE.test(m[1]) || !KEY_BODY_RE.test(m[2])) return null;
  const body = m[2].length > KEY_HEAD + KEY_TAIL + 4 ? `${m[2].slice(0, KEY_HEAD)}…${m[2].slice(-KEY_TAIL)}` : m[2];
  return { type: m[1], body, comment: (m[3] ?? '').trim() };
}

// --- Inspect result ---------------------------------------------------------

export interface CertFace { tone: 'ok' | 'pin' | 'err'; mode: 'ca' | 'pin' | null; fingerprint: string | null; text: string }

export function certFace(r: Pick<InspectResult, 'reachable' | 'caValid' | 'fingerprint256'> & { error?: string }): CertFace {
  if (!r.reachable) return { tone: 'err', mode: null, fingerprint: null, text: r.error?.trim() || 'Endpoint unreachable.' };
  if (r.caValid) return { tone: 'ok', mode: 'ca', fingerprint: r.fingerprint256 ?? null, text: 'Certificate is CA-valid, so it verifies normally.' };
  // Self-signed. With no fingerprint there is nothing to pin, and saving 'pin' anyway
  // would create a host that can never connect.
  if (!r.fingerprint256) return { tone: 'err', mode: null, fingerprint: null, text: 'The endpoint answered but gave no certificate fingerprint to pin.' };
  return { tone: 'pin', mode: 'pin', fingerprint: r.fingerprint256, text: 'Self-signed certificate. Adding the host pins this fingerprint.' };
}

// --- Forms ------------------------------------------------------------------

export interface Invalid<F extends string> { field: F; message: string }

export interface AddHostDraft {
  name: string; endpoint: string; tokenId: string; tokenSecret: string;
  // The outcome of the last Inspect for THIS endpoint; null when none has run (or the
  // endpoint was edited since — the caller clears it, a fingerprint belongs to one address).
  mode: 'ca' | 'pin' | null;
  fingerprint256?: string | null;
}

export type AddHostField = 'name' | 'endpoint' | 'tokenId' | 'tokenSecret' | 'inspect';

// Presence checks and the Inspect gate only: the format rules live in the server
// (proxmoxValidate.js) and its message is shown if it refuses.
export function validateAddHost(d: AddHostDraft): Invalid<AddHostField> | null {
  if (!d.endpoint.trim()) return { field: 'endpoint', message: 'Enter the endpoint, like pve.example.com:8006.' };
  if (!d.name.trim()) return { field: 'name', message: 'Give the host a name.' };
  if (!d.tokenId.trim()) return { field: 'tokenId', message: 'Enter the API token id, like user@pam!tmuxifier.' };
  if (!d.tokenSecret) return { field: 'tokenSecret', message: 'Enter the API token secret.' };
  if (d.mode === null || (d.mode === 'pin' && !d.fingerprint256)) {
    return { field: 'inspect', message: 'Inspect the endpoint first. Its certificate decides how Tmuxifier verifies it.' };
  }
  return null;
}

export function validateAddKey(d: { name: string; publicKey: string }): Invalid<'name' | 'publicKey'> | null {
  if (!d.name.trim()) return { field: 'name', message: 'Name the key so you can tell it apart later.' };
  if (!d.publicKey.trim()) return { field: 'publicKey', message: 'Paste the public key (the one ending in .pub).' };
  return null;
}

// Mirrors assertRootPassword() in proxmoxValidate.js.
export const ROOT_PASSWORD_MIN = 5;

export function validatePassword(password: string, confirm: string): Invalid<'password' | 'confirm'> | null {
  if (!password) return { field: 'password', message: `Enter a password of at least ${ROOT_PASSWORD_MIN} characters.` };
  if (password.length < ROOT_PASSWORD_MIN) return { field: 'password', message: `Use at least ${ROOT_PASSWORD_MIN} characters.` };
  if (password !== confirm) return { field: 'confirm', message: 'The two passwords do not match.' };
  return null;
}
