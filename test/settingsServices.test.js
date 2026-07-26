import { test, expect } from 'vitest';
import { buildServicePayload } from '../src/web/settingsServices.ts';

test('buildServicePayload trims fields and omits empties', () => {
  expect(buildServicePayload({ name: ' Grafana ', url: ' http://192.168.1.20:3000/ ', glyph: '', group: '  ', kind: 'http', target: '' }))
    .toEqual({ name: 'Grafana', url: 'http://192.168.1.20:3000/', glyph: null, group: null, check: { kind: 'http' } });
});

test('buildServicePayload carries the target for tcp and drops it for none', () => {
  expect(buildServicePayload({ name: 'DNS', url: 'http://192.168.1.2/', glyph: '', group: '', kind: 'tcp', target: ' 192.168.1.2:53 ' }).check)
    .toEqual({ kind: 'tcp', target: '192.168.1.2:53' });
  expect(buildServicePayload({ name: 'App', url: 'http://a.example.com/', glyph: '', group: '', kind: 'none', target: 'ignored' }).check)
    .toEqual({ kind: 'none' });
});
