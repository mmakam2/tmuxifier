import { describe, it, expect } from 'vitest';
import { decideLogin } from '../src/web/loginRoute';

const pk = { enrolled: 0, rpId: null, only: false };
const ak = { id: 'authentik', label: 'authentik', legacy: false };
const goog = { id: 'google', label: 'Google', legacy: true };
const oidc = (o = {}) => ({ mode: 'oidc', providers: [ak], password: true, passkey: pk, ...o });

describe('decideLogin', () => {
  it('redirects for a single non-legacy provider', () => {
    expect(decideLogin(oidc(), '', false)).toEqual({ kind: 'redirect', href: '/api/auth/oidc/authentik/login' });
  });
  it('shows page for legacy google', () => {
    expect(decideLogin(oidc({ providers: [goog] }), '', false).kind).toBe('page');
  });
  it('legacy google href', () => {
    const d = decideLogin(oidc({ providers: [goog] }), '', false);
    expect(d.providers[0].href).toBe('/api/auth/google/login');
  });
  it('?login shows page with password', () => {
    const d = decideLogin(oidc(), '?login', false);
    expect(d.kind).toBe('page');
    expect(d.showPassword).toBe(true);
  });
  it('?error shows page with code', () => {
    const d = decideLogin(oidc(), '?error=forbidden', false);
    expect(d.kind).toBe('page');
    expect(d.errorCode).toBe('forbidden');
  });
  it('signedOut shows page', () => {
    const d = decideLogin(oidc(), '', true);
    expect(d.kind).toBe('page');
    expect(d.signedOut).toBe(true);
  });
  it('two providers in order', () => {
    const d = decideLogin(oidc({ providers: [ak, goog] }), '', false);
    expect(d.kind).toBe('page');
    expect(d.providers.map((p) => p.id)).toEqual(['authentik', 'google']);
  });
  it('passkey only hides everything', () => {
    const d = decideLogin(oidc({ passkey: { ...pk, only: true } }), '', false);
    expect(d.kind).toBe('page');
    expect(d.providers).toEqual([]);
    expect(d.showPassword).toBe(false);
  });
  it('password mode', () => {
    const d = decideLogin({ mode: 'password', passkey: pk }, '', false);
    expect(d.kind).toBe('page');
    expect(d.showPassword).toBe(true);
    expect(d.providers).toEqual([]);
  });
  it('oidc without ?login hides password', () => {
    expect(decideLogin(oidc({ providers: [ak, goog] }), '', false).showPassword).toBe(false);
  });
});
