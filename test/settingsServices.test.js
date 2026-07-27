import { test, expect } from 'vitest';
import { buildServicePayload } from '../src/web/settingsServices.ts';

test('buildServicePayload trims fields, omits empties, and carries the section', () => {
  expect(buildServicePayload({ name: ' Grafana ', url: ' http://192.168.1.20:3000/ ', glyph: '', group: '  ', kind: 'http', target: '', section: 'services' }))
    .toEqual({ name: 'Grafana', url: 'http://192.168.1.20:3000/', glyph: null, group: null, check: { kind: 'http' }, section: 'services' });
  expect(buildServicePayload({ name: 'AdGuard', url: 'http://192.168.1.5/', glyph: '', group: 'DNS Filtering', kind: 'http', target: '', section: 'infrastructure' }).section)
    .toBe('infrastructure');
});

test('buildServicePayload carries the target for tcp and drops it for none', () => {
  expect(buildServicePayload({ name: 'DNS', url: 'http://192.168.1.2/', glyph: '', group: '', kind: 'tcp', target: ' 192.168.1.2:53 ', section: 'services' }).check)
    .toEqual({ kind: 'tcp', target: '192.168.1.2:53' });
  expect(buildServicePayload({ name: 'App', url: 'http://a.example.com/', glyph: '', group: '', kind: 'none', target: 'ignored', section: 'services' }).check)
    .toEqual({ kind: 'none' });
});

test('buildServicePayload builds a pihole check with its optional target and insecure flag', () => {
  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: 'DNS Filtering',
    kind: 'pihole', target: '', section: 'infrastructure', password: 'app-pw',
  })).toEqual({
    name: 'pihole', url: 'https://pihole.example.com', glyph: null, group: 'DNS Filtering',
    section: 'infrastructure', check: { kind: 'pihole' }, password: 'app-pw',
  });

  expect(buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: ' http://192.168.1.5/ ', section: 'services', insecure: true,
  }).check).toEqual({ kind: 'pihole', target: 'http://192.168.1.5/', insecure: true });
});

test('buildServicePayload omits an untouched password and sends null to clear it', () => {
  const untouched = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: '', section: 'services', password: '   ',
  });
  expect('password' in untouched).toBe(false);

  const cleared = buildServicePayload({
    name: 'pihole', url: 'https://pihole.example.com', glyph: '', group: '',
    kind: 'pihole', target: '', section: 'services', password: '', clearPassword: true,
  });
  expect(cleared.password).toBe(null);
});

test('buildServicePayload never attaches a password to a non-pihole check', () => {
  const payload = buildServicePayload({
    name: 'web', url: 'http://192.168.1.20:3000/', glyph: '', group: '',
    kind: 'http', target: '', section: 'services', password: 'leftover',
  });
  expect('password' in payload).toBe(false);
});
