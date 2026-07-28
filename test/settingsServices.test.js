import { test, expect } from 'vitest';
import { buildServicePayload } from '../src/web/settingsServices.ts';

test('buildServicePayload trims fields, omits empties, and carries the section', () => {
  expect(buildServicePayload({ name: ' Grafana ', url: ' http://192.168.1.20:3000/ ', group: '  ', kind: 'http', target: '', section: 'services' }))
    .toEqual({ name: 'Grafana', url: 'http://192.168.1.20:3000/', icon: null, group: null, check: { kind: 'http' }, section: 'services' });
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
    section: 'infrastructure', check: { kind: 'pihole' }, password: 'app-pw',
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
  expect(p.check).toEqual({ kind: 'truenas', username: 'truenas_admin' });
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

test('truenas: target and insecure are carried only when set', () => {
  const bare = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'u' });
  expect(bare.check).toEqual({ kind: 'truenas', username: 'u' });
  const full = buildServicePayload({ ...nasBase, kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
  expect(full.check).toEqual({ kind: 'truenas', username: 'u', target: 'https://192.168.1.20', insecure: true });
});

test('an http tile still builds a plain check with no credential fields', () => {
  const p = buildServicePayload({ ...nasBase, kind: 'http', target: '' });
  expect(p.check).toEqual({ kind: 'http' });
  expect('password' in p).toBe(false);
});

const unifiBase = {
  name: 'UniFi', url: 'https://unifi.example.com', group: 'Network',
  kind: 'unifi', target: '', section: 'infrastructure',
};

test('buildServicePayload defaults a unifi tls mode to verify and omits an empty site', () => {
  expect(buildServicePayload({ ...unifiBase }).check).toEqual({ kind: 'unifi', tls: 'verify' });
});

test('buildServicePayload carries the unifi site and probe target when set', () => {
  expect(buildServicePayload({ ...unifiBase, target: ' https://192.168.1.1 ', site: ' default ' }).check)
    .toEqual({ kind: 'unifi', target: 'https://192.168.1.1', site: 'default', tls: 'verify' });
});

test('buildServicePayload sends a unifi fingerprint only in pin mode', () => {
  expect(buildServicePayload({ ...unifiBase, tls: 'pin', fingerprint: 'AA:BB' }).check)
    .toEqual({ kind: 'unifi', tls: 'pin', fingerprint: 'AA:BB' });
  expect(buildServicePayload({ ...unifiBase, tls: 'insecure', fingerprint: 'AA:BB' }).check)
    .toEqual({ kind: 'unifi', tls: 'insecure' });
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
