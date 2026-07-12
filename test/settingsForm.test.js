import { test, expect } from 'vitest';
import { splitNetboxUrl, normalizeHostInput, buildSavePayload, describeTestResult } from '../src/web/settingsForm.ts';

const state = (over = {}) => ({ scheme: 'https', host: 'netbox.example.com', token: 'tok', tlsMode: 'ca', fingerprint256: null, hasToken: false, ...over });

test('splitNetboxUrl parses stored URLs and defaults scheme-less input to https', () => {
  expect(splitNetboxUrl('https://netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
  expect(splitNetboxUrl('http://192.168.1.20:8000/netbox')).toEqual({ scheme: 'http', host: '192.168.1.20:8000/netbox' });
  expect(splitNetboxUrl('  HTTPS://x ')).toEqual({ scheme: 'https', host: 'x' });
  expect(splitNetboxUrl('')).toEqual({ scheme: 'https', host: '' });
  expect(splitNetboxUrl('netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
});

test('normalizeHostInput passes plain hosts through and adopts a pasted scheme', () => {
  expect(normalizeHostInput('https', 'netbox.example.com')).toEqual({ scheme: 'https', host: 'netbox.example.com' });
  expect(normalizeHostInput('https', 'http://192.168.1.20:8000')).toEqual({ scheme: 'http', host: '192.168.1.20:8000' });
  expect(normalizeHostInput('http', 'HTTPS://netbox.example.com/netbox')).toEqual({ scheme: 'https', host: 'netbox.example.com/netbox' });
});

test('buildSavePayload: happy path https/ca', () => {
  expect(buildSavePayload(state())).toEqual({ payload: { url: 'https://netbox.example.com', token: 'tok', tlsMode: 'ca' } });
});

test('buildSavePayload: blank token allowed only when one is already saved', () => {
  expect(buildSavePayload(state({ token: '' })).error).toMatch(/token/);
  expect(buildSavePayload(state({ token: '', hasToken: true })).payload).toEqual({ url: 'https://netbox.example.com', tlsMode: 'ca' });
});

test('buildSavePayload: pin mode requires a fingerprint and includes it', () => {
  expect(buildSavePayload(state({ tlsMode: 'pin' })).error).toMatch(/fingerprint/i);
  expect(buildSavePayload(state({ tlsMode: 'pin', fingerprint256: 'AB:CD' })).payload)
    .toEqual({ url: 'https://netbox.example.com', token: 'tok', tlsMode: 'pin', fingerprint256: 'AB:CD' });
});

test('buildSavePayload: http omits tlsMode even if one is set; empty host errors', () => {
  expect(buildSavePayload(state({ scheme: 'http', host: '192.168.1.10:8000', tlsMode: 'pin' })).payload)
    .toEqual({ url: 'http://192.168.1.10:8000', token: 'tok' });
  expect(buildSavePayload(state({ host: '  ' })).error).toMatch(/host/i);
});

test('describeTestResult: success, failure, and the pin offer', () => {
  expect(describeTestResult({ ok: true, version: '4.3.2' })).toEqual({ text: 'Connected — NetBox 4.3.2', ok: true, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'auth', error: 'no' })).toEqual({ text: 'no', ok: false, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'tls', error: 'mismatch', fingerprint256: 'AB:CD' }))
    .toEqual({ text: 'mismatch', ok: false, offerPin: 'AB:CD' });
});
