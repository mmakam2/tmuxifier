import { test, expect } from 'vitest';
import { isHttps, buildSavePayload, describeTestResult } from '../src/web/settingsForm.ts';

const state = (over = {}) => ({ url: 'https://netbox.example.com', token: 'tok', tlsMode: 'ca', fingerprint256: null, hasToken: false, ...over });

test('isHttps', () => {
  expect(isHttps('https://x.example.com')).toBe(true);
  expect(isHttps('  HTTPS://x')).toBe(true);
  expect(isHttps('http://x.example.com')).toBe(false);
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

test('buildSavePayload: http URL omits tlsMode; junk URL errors', () => {
  expect(buildSavePayload(state({ url: 'http://192.168.1.10:8000' })).payload)
    .toEqual({ url: 'http://192.168.1.10:8000', token: 'tok' });
  expect(buildSavePayload(state({ url: '' })).error).toMatch(/URL/);
  expect(buildSavePayload(state({ url: 'netbox.example.com' })).error).toMatch(/http/);
});

test('describeTestResult: success, failure, and the pin offer', () => {
  expect(describeTestResult({ ok: true, version: '4.3.2' })).toEqual({ text: 'Connected — NetBox 4.3.2', ok: true, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'auth', error: 'no' })).toEqual({ text: 'no', ok: false, offerPin: null });
  expect(describeTestResult({ ok: false, kind: 'tls', error: 'mismatch', fingerprint256: 'AB:CD' }))
    .toEqual({ text: 'mismatch', ok: false, offerPin: 'AB:CD' });
});
