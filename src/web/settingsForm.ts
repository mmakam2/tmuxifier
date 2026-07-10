// Pure helpers behind the settings modal (settingsUi.ts) — DOM-free so they are
// unit-testable, mirroring the termFont.ts pattern.
import type { NetboxSettingsInput, NetboxTestResult } from './netbox';

export interface NetboxFormState {
  url: string; token: string; tlsMode: 'ca' | 'pin' | 'insecure';
  fingerprint256: string | null; hasToken: boolean;
}

export function isHttps(url: string): boolean { return /^https:\/\//i.test(url.trim()); }

export function buildSavePayload(s: NetboxFormState): { payload?: NetboxSettingsInput; error?: string } {
  const url = s.url.trim();
  if (!url) return { error: 'NetBox URL is required' };
  if (!/^https?:\/\//i.test(url)) return { error: 'URL must start with http:// or https://' };
  const token = s.token.trim();
  if (!token && !s.hasToken) return { error: 'an API token is required' };
  const payload: NetboxSettingsInput = { url };
  if (token) payload.token = token;
  if (isHttps(url)) {
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
