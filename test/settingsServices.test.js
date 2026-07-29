import { test, expect } from 'vitest';
import { buildServicePayload } from '../src/web/settingsServices.ts';

test('buildServicePayload trims fields, states an empty target, and carries the section', () => {
  expect(buildServicePayload({ name: ' Grafana ', url: ' http://192.168.1.20:3000/ ', group: '  ', kind: 'http', target: '', section: 'services' }))
    .toEqual({ name: 'Grafana', url: 'http://192.168.1.20:3000/', icon: null, group: null, check: { kind: 'http', target: '' }, section: 'services' });
  expect(buildServicePayload({ name: 'AdGuard', url: 'http://192.168.1.5/', group: 'DNS Filtering', kind: 'http', target: '', section: 'infrastructure' }).section)
    .toBe('infrastructure');
});

test('buildServicePayload carries the target for tcp and drops it for none', () => {
  expect(buildServicePayload({ name: 'DNS', url: 'http://192.168.1.2/', group: '', kind: 'tcp', target: ' 192.168.1.2:53 ', section: 'services' }).check)
    .toEqual({ kind: 'tcp', target: '192.168.1.2:53' });
  expect(buildServicePayload({ name: 'App', url: 'http://a.example.com/', group: '', kind: 'none', target: 'ignored', section: 'services' }).check)
    .toEqual({ kind: 'none' });
});

test('buildServicePayload builds a pihole check with its optional target and insecure flag', () => {
  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', group: 'DNS Filtering',
    kind: 'pihole', target: '', section: 'infrastructure', password: 'app-pw',
  })).toEqual({
    name: 'pihole', url: 'https://pihole.example.com', icon: null, group: 'DNS Filtering',
    section: 'infrastructure', check: { kind: 'pihole', target: '', insecure: false }, password: 'app-pw',
  });

  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', group: '',
    kind: 'pihole', target: ' http://192.168.1.5/ ', section: 'services', insecure: true,
  }).check).toEqual({ kind: 'pihole', target: 'http://192.168.1.5/', insecure: true });
});

test('buildServicePayload omits an untouched password and sends null to clear it', () => {
  const untouched = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', group: '',
    kind: 'pihole', target: '', section: 'services', password: '   ',
  });
  expect('password' in untouched).toBe(false);

  const cleared = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', group: '',
    kind: 'pihole', target: '', section: 'services', password: '', clearPassword: true,
  });
  expect(cleared.password).toBe(null);
});

test('buildServicePayload never attaches a password to a non-pihole check', () => {
  const payload = buildServicePayload({
    name: 'web', url: 'http://192.168.1.20:3000/', group: '',
    kind: 'http', target: '', section: 'services', password: 'leftover',
  });
  expect('password' in payload).toBe(false);
});

// --- truenas ---------------------------------------------------------------
const nasBase = {
  name: 'nas', url: 'https://nas.example.com', group: 'Storage',
  section: 'infrastructure', target: '',
};

test('truenas: the username rides in the check and the key rides as password', () => {
  const p = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'truenas_admin', password: '1-key' });
  expect(p.check).toEqual({ kind: 'truenas', username: 'truenas_admin', target: '', insecure: false });
  expect(p.password).toBe('1-key');
});

test('truenas: an untouched key sends no password key at all', () => {
  const p = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'truenas_admin', password: '' });
  expect('password' in p).toBe(false);
});

test('truenas: Clear sends an explicit null', () => {
  const p = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'truenas_admin', password: '', clearPassword: true });
  expect(p.password).toBe(null);
});

test('truenas: the target is always stated, so emptying it clears the stored one', () => {
  const bare = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'u' });
  expect(bare.check).toEqual({ kind: 'truenas', username: 'u', target: '', insecure: false });
  const full = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
  expect(full.check).toEqual({ kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
});

test('an http tile still builds a plain check with no credential fields', () => {
  const p = buildServicePayload({ ...nasBase, kind: 'http', target: '' });
  expect(p.check).toEqual({ kind: 'http', target: '' });
  expect('password' in p).toBe(false);
});

const unifiBase = {
  name: 'UniFi', url: 'https://unifi.example.com', group: 'Network',
  kind: 'unifi', target: '', section: 'infrastructure',
};

test('buildServicePayload defaults a unifi tls mode to verify and states an empty site', () => {
  expect(buildServicePayload({ ...unifiBase }).check).toEqual({ kind: 'unifi', target: '', site: '', tls: 'verify' });
});

test('buildServicePayload carries the unifi site and probe target when set', () => {
  expect(buildServicePayload({ ...unifiBase, target: ' https://192.168.1.1 ', site: ' default ' }).check)
    .toEqual({ kind: 'unifi', target: 'https://192.168.1.1', site: 'default', tls: 'verify' });
});

test('buildServicePayload sends a unifi fingerprint only in pin mode', () => {
  expect(buildServicePayload({ ...unifiBase, tls: 'pin', fingerprint: 'AA:BB' }).check)
    .toEqual({ kind: 'unifi', target: '', site: '', tls: 'pin', fingerprint: 'AA:BB' });
  expect(buildServicePayload({ ...unifiBase, tls: 'insecure', fingerprint: 'AA:BB' }).check)
    .toEqual({ kind: 'unifi', target: '', site: '', tls: 'insecure' });
});

test('buildServicePayload sends the unifi api key through the shared password field', () => {
  expect(buildServicePayload({ ...unifiBase, password: 'the-key' }).password).toBe('the-key');
  expect(buildServicePayload({ ...unifiBase, clearPassword: true }).password).toBeNull();
});

test('buildServicePayload maps the three icon states', () => {
  const base = { name: 'Grafana', url: 'http://192.168.1.20:3000/', group: '', kind: 'http', target: '', section: 'services' };
  // Auto: absent from the form, cleared on the server, which is what "resolve
  // automatically" is stored as.
  expect(buildServicePayload(base).icon).toBe(null);
  expect(buildServicePayload({ ...base, icon: 'none' }).icon).toBe('none');
  expect(buildServicePayload({ ...base, icon: 'grafana' }).icon).toBe('grafana');
});

// Unchecking a box must send `false`, not omit the key. The server's PATCH
// merge is {...base, ...raw}, so an omitted key means "keep what is stored" —
// which made unchecking "allow self-signed certificates" silently revert. The
// same applies to clearing a UniFi site override back to the first site.
test('buildServicePayload always states insecure, so unchecking it actually clears', () => {
  const pihole = { name: 'P', url: 'https://pihole.example.com', group: '', kind: 'pihole', target: '', section: 'services' };
  expect(buildServicePayload({ ...pihole, insecure: true }).check).toEqual({ kind: 'pihole', target: '', insecure: true });
  expect(buildServicePayload({ ...pihole, insecure: false }).check).toEqual({ kind: 'pihole', target: '', insecure: false });
  expect(buildServicePayload(pihole).check).toEqual({ kind: 'pihole', target: '', insecure: false });

  const truenas = { name: 'N', url: 'https://nas.example.com', group: '', kind: 'truenas', target: '', section: 'services', username: 'admin' };
  expect(buildServicePayload({ ...truenas, insecure: false }).check).toEqual({ kind: 'truenas', username: 'admin', target: '', insecure: false });
});

test('buildServicePayload always states the unifi site, so clearing it reverts to the first site', () => {
  const unifi = { name: 'U', url: 'https://unifi.example.com', group: '', kind: 'unifi', target: '', section: 'services', tls: 'verify' };
  expect(buildServicePayload({ ...unifi, site: 'Office' }).check).toEqual({ kind: 'unifi', target: '', site: 'Office', tls: 'verify' });
  expect(buildServicePayload({ ...unifi, site: '  ' }).check).toEqual({ kind: 'unifi', target: '', site: '', tls: 'verify' });
});

test('buildServicePayload builds an immich check', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: 'Media',
    kind: 'immich', target: '', section: 'services', password: 'key-1',
  });
  expect(p.check).toEqual({ kind: 'immich', target: '', insecure: false });
  expect(p.password).toBe('key-1');
});

test('buildServicePayload carries an immich probe target when given one', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: 'http://192.168.1.10:2283', section: 'services',
  });
  expect(p.check).toEqual({ kind: 'immich', target: 'http://192.168.1.10:2283', insecure: false });
});

// The PATCH-merge trap from the spec: `insecure` must be stated outright, never
// omitted when false, or an unchecked box can never turn a stored true off.
test('buildServicePayload states an unchecked immich insecure box outright', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: '', section: 'services', insecure: false,
  });
  expect(p.check).toHaveProperty('insecure', false);
});

test('buildServicePayload sends an explicit null to clear an immich key', () => {
  const p = buildServicePayload({
    name: 'Photos', url: 'https://immich.example.com', group: '',
    kind: 'immich', target: '', section: 'services', clearPassword: true,
  });
  expect(p.password).toBeNull();
});

// B4 (2026-07-29 review): `target` was the last field still omitted when empty,
// so emptying the Probe URL field could never clear a stored one — the server's
// PATCH merge kept probing the old address. Only kind 'none', which has no
// target field at all, omits it.
test('buildServicePayload states an empty target for every probing kind, so clearing it works', () => {
  const base = { name: 'S', url: 'https://s.example.com', group: '', target: '', section: 'services' };
  for (const kind of ['http', 'pihole', 'immich', 'unifi', 'truenas']) {
    const check = buildServicePayload({ ...base, kind, username: 'u' }).check;
    expect(check).toHaveProperty('target', '');
  }
  expect(buildServicePayload({ ...base, kind: 'none' }).check).toEqual({ kind: 'none' });
});
