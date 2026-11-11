import type { AuthInfo } from './api';

export const SIGNED_OUT_KEY = 'tmuxifier.signedOut';

export type LoginProvider = { id: string; label: string; href: string };
export type LoginDecision =
  | { kind: 'redirect'; href: string }
  | { kind: 'page'; providers: LoginProvider[]; showPassword: boolean; signedOut: boolean; errorCode: string | null };

function providerHref(p: { id: string; legacy: boolean }): string {
  return p.legacy && p.id === 'google'
    ? '/api/auth/google/login'
    : `/api/auth/oidc/${encodeURIComponent(p.id)}/login`;
}

export function decideLogin(info: AuthInfo, search: string, signedOut: boolean): LoginDecision {
  const q = new URLSearchParams(search);
  const errorCode = q.get('error') || null;
  const forcedLogin = q.has('login');
  const passkeyOnly = !!info.passkey?.only;
  const providers: LoginProvider[] = info.mode === 'oidc' && !passkeyOnly
    ? (info.providers ?? []).map((p) => ({ id: p.id, label: p.label, href: providerHref(p) }))
    : [];
  const showPassword = !passkeyOnly && (info.mode === 'password' || (forcedLogin && !!info.password));

  const only = info.mode === 'oidc' ? (info.providers ?? []) : [];
  if (
    only.length === 1 && !only[0].legacy && providers.length === 1 &&
    !forcedLogin && !errorCode && !signedOut
  ) return { kind: 'redirect', href: providers[0].href };

  return { kind: 'page', providers, showPassword, signedOut, errorCode };
}
