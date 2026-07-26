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
