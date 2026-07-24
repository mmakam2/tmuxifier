// Pure helpers behind the settings modal (settingsUi.ts) — DOM-free so they are
// unit-testable, mirroring the termFont.ts pattern.
import type { NetboxSettingsInput, NetboxTestResult } from './netbox';

export interface NetboxFormState {
  scheme: 'http' | 'https'; host: string; token: string; tlsMode: 'ca' | 'pin' | 'insecure';
  fingerprint256: string | null; hasToken: boolean; dnsSuffix: string;
}

// Parse a stored canonical URL into the selector + host controls. Scheme-less
// or empty input (fresh form) defaults to https.
export function splitNetboxUrl(url: string): { scheme: 'http' | 'https'; host: string } {
  const m = /^\s*(https?):\/\/(.*?)\s*$/i.exec(url ?? '');
  if (m) return { scheme: m[1].toLowerCase() as 'http' | 'https', host: m[2] };
  return { scheme: 'https', host: (url ?? '').trim() };
}

// Pasting a full URL into the host field is the common case (browser tab):
// the pasted scheme wins and the prefix moves out of the host text.
export function normalizeHostInput(scheme: 'http' | 'https', raw: string): { scheme: 'http' | 'https'; host: string } {
  return /^\s*https?:\/\//i.test(raw) ? splitNetboxUrl(raw) : { scheme, host: raw };
}

export function buildSavePayload(s: NetboxFormState): { payload?: NetboxSettingsInput; error?: string } {
  const host = s.host.trim();
  if (!host) return { error: 'NetBox host is required' };
  const token = s.token.trim();
  if (!token && !s.hasToken) return { error: 'an API token is required' };
  const payload: NetboxSettingsInput = { url: `${s.scheme}://${host}` };
  if (token) payload.token = token;
  // Blank omits the key: the server rebuilds settings from the payload, so an
  // absent dnsSuffix clears a stored one — which is what an emptied field means.
  const dnsSuffix = s.dnsSuffix.trim();
  if (dnsSuffix) payload.dnsSuffix = dnsSuffix;
  if (s.scheme === 'https') {
    payload.tlsMode = s.tlsMode;
    if (s.tlsMode === 'pin') {
      if (!s.fingerprint256) return { error: 'pin mode needs a certificate fingerprint — run Test Connection to fetch it' };
      payload.fingerprint256 = s.fingerprint256;
    }
  }
  return { payload };
}

export function describeTestResult(r: NetboxTestResult): { text: string; ok: boolean; offerPin: string | null } {
  if (r.ok) return { text: `Connected — NetBox ${r.version}`, ok: true, offerPin: null };
  return { text: r.error, ok: false, offerPin: r.kind === 'tls' && r.fingerprint256 ? r.fingerprint256 : null };
}
