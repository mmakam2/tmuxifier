import { test, expect } from 'vitest';
import { parseNetboxUrl, assertSettingsInput } from '../src/server/netboxValidate.js';

test('parseNetboxUrl normalizes scheme/host/path and strips trailing slash and /api', () => {
  expect(parseNetboxUrl('https://netbox.example.com')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('https://netbox.example.com/')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('https://netbox.example.com/api/')).toBe('https://netbox.example.com');
  expect(parseNetboxUrl('http://192.168.1.10:8000')).toBe('http://192.168.1.10:8000');
  expect(parseNetboxUrl('https://example.com/netbox')).toBe('https://example.com/netbox');
});

test('parseNetboxUrl rejects junk', () => {
  expect(() => parseNetboxUrl('')).toThrow(/required/);
  expect(() => parseNetboxUrl('netbox.example.com')).toThrow(/http/);
  expect(() => parseNetboxUrl('ftp://x')).toThrow(/http/);
  expect(() => parseNetboxUrl('https://user:pw@x.example.com')).toThrow(/credentials/);
  expect(() => parseNetboxUrl('https://x.example.com/?a=1')).toThrow(/query/);
});

test('assertSettingsInput returns normalized fields for https + ca (default mode)', () => {
  expect(assertSettingsInput({ url: 'https://netbox.example.com/', token: 'abc123' }))
    .toEqual({ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null });
});

test('assertSettingsInput: http URLs carry no tlsMode', () => {
  expect(assertSettingsInput({ url: 'http://192.168.1.10:8000', token: 't', tlsMode: 'pin' }))
    .toEqual({ url: 'http://192.168.1.10:8000', tlsMode: null, fingerprint256: null });
});

test('assertSettingsInput: pin mode requires a fingerprint', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'pin' }))
    .toThrow(/fingerprint/);
  expect(assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'pin', fingerprint256: 'AB:CD:12' }))
    .toEqual({ url: 'https://x.example.com', tlsMode: 'pin', fingerprint256: 'AB:CD:12' });
});

test('assertSettingsInput: token rules', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com' })).toThrow(/token/);
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: '  ' })).toThrow(/token/);
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 'has space' })).toThrow(/token/);
  // requireToken:false skips the presence check (used for keep-existing-token saves)
  expect(assertSettingsInput({ url: 'https://x.example.com' }, { requireToken: false }).url)
    .toBe('https://x.example.com');
});

test('assertSettingsInput rejects unknown tlsMode', () => {
  expect(() => assertSettingsInput({ url: 'https://x.example.com', token: 't', tlsMode: 'yolo' })).toThrow(/tlsMode/);
});
