import type { AuthInfo } from './api';

export const SIGNED_OUT_KEY = 'tmuxifier.signedOut';

export type LoginProvider = { id: string; label: string; href: string; google: boolean };
export type LoginDecision =
  | { kind: 'redirect'; href: string }
  | { kind: 'page'; providers: LoginProvider[]; showPassword: boolean; signedOut: boolean; errorCode: string | null };

function providerHref(p: { id: string; legacy: boolean }): string {
  return p.legacy && p.id === 'google'
    ? '/api/auth/google/login'
    : `/api/auth/oidc/${encodeURIComponent(p.id)}/login`;
}

// Only a fresh page load may bounce to the provider. A 401 mid-session and a
// logout must render the page, or an expired session would loop through the IdP.
export type LoginReason = 'boot' | 'expired' | 'logout';

export function decideLogin(info: AuthInfo, search: string, signedOut: boolean, reason: LoginReason = 'boot'): LoginDecision {
  const q = new URLSearchParams(search);
  const errorCode = q.get('error') || null;
  const forcedLogin = q.has('login');
  const passkeyOnly = !!info.passkey?.only;
  const providers: LoginProvider[] = info.mode === 'oidc' && !passkeyOnly
    ? (info.providers ?? []).map((p) => ({ id: p.id, label: p.label, href: providerHref(p), google: !!p.google }))
    : [];
  const showPassword = !passkeyOnly && info.mode === 'password';

  const only = info.mode === 'oidc' ? (info.providers ?? []) : [];
  if (
    only.length === 1 && !only[0].legacy && providers.length === 1 &&
    reason === 'boot' && !forcedLogin && !errorCode && !signedOut
  ) return { kind: 'redirect', href: providers[0].href };

  // The stored flag exists to stop the redirect, so only OIDC mode shows it as
  // a note; password mode shows "signed out" only right after a logout.
  const note = reason === 'logout' || (info.mode === 'oidc' && signedOut);
  return { kind: 'page', providers, showPassword, signedOut: note, errorCode };
}
