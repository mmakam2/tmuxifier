import { test, expect } from 'vitest';
import { isSafeSlug, normalizeSlug, hostLabel, slugCandidates, parseIconLinks } from '../src/server/iconResolve.js';

test('isSafeSlug accepts lowercase slugs and refuses everything that could escape a directory', () => {
  expect(isSafeSlug('unifi')).toBe(true);
  expect(isSafeSlug('pi-hole')).toBe(true);
  expect(isSafeSlug('a')).toBe(true);
  expect(isSafeSlug('none')).toBe(true);
  for (const bad of ['', '../etc/passwd', '/abs', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', 'sp ace', 'uni.fi', 'ünifi', 'a'.repeat(65), null, undefined, 42, {}]) {
    expect(isSafeSlug(bad)).toBe(false);
  }
});

test('normalizeSlug lowercases, collapses punctuation to single hyphens, and trims', () => {
  expect(normalizeSlug('Grafana')).toBe('grafana');
  expect(normalizeSlug('Home Assistant')).toBe('home-assistant');
  expect(normalizeSlug('  Nginx__Proxy  Manager ')).toBe('nginx-proxy-manager');
  expect(normalizeSlug('Pi-Hole!')).toBe('pi-hole');
  expect(normalizeSlug('   ')).toBe('');
  expect(normalizeSlug('!!!')).toBe('');
  expect(normalizeSlug(null)).toBe('');
});

test('hostLabel takes the first label and refuses IP literals', () => {
  expect(hostLabel('https://jellyfin.example.com/')).toBe('jellyfin');
  expect(hostLabel('http://grafana.example.com:3000/d/abc')).toBe('grafana');
  expect(hostLabel('https://192.168.1.10:8006/')).toBe('');
  expect(hostLabel('http://[2001:db8::1]/')).toBe('');
  expect(hostLabel('not a url')).toBe('');
});

test('slugCandidates leads with the check kind, then the name, then the hostname', () => {
  expect(slugCandidates({ name: 'Controller', url: 'https://unifi.example.com/', check: { kind: 'unifi' } }))
    .toEqual(['unifi', 'controller']);
  expect(slugCandidates({ name: 'Blocky', url: 'https://dns.example.com/', check: { kind: 'pihole' } }))
    .toEqual(['pi-hole', 'blocky', 'dns']);
  expect(slugCandidates({ name: 'Media Box', url: 'https://jellyfin.example.com/', check: { kind: 'http' } }))
    .toEqual(['media-box', 'jellyfin']);
});

test('slugCandidates dedupes and drops candidates that cannot be slugs', () => {
  expect(slugCandidates({ name: 'Grafana', url: 'https://grafana.example.com/', check: { kind: 'http' } }))
    .toEqual(['grafana']);
  expect(slugCandidates({ name: '!!!', url: 'https://192.168.1.10/', check: { kind: 'none' } }))
    .toEqual([]);
  expect(slugCandidates({ name: 'NAS', url: 'https://192.168.1.20/', check: { kind: 'truenas' } }))
    .toEqual(['truenas', 'nas']);
});

test('parseIconLinks prefers SVG, then the largest declared size, and resolves relative hrefs', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="touch.png" sizes="180x180">
    <link rel="icon" type="image/svg+xml" href="https://cdn.example.com/logo.svg">
  </head></html>`;
  expect(parseIconLinks(html, 'https://app.example.com/dash/')).toEqual([
    'https://cdn.example.com/logo.svg',
    'https://app.example.com/dash/touch.png',
    'https://app.example.com/favicon-32.png',
  ]);
});

test('parseIconLinks ignores non-icon links and non-http schemes', () => {
  const html = `<link rel="canonical" href="/x"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AA">`;
  expect(parseIconLinks(html, 'https://app.example.com/')).toEqual([]);
});

// The kind declares the slug rather than the name guessing it, and an IP
// literal contributes no candidate — an address is not a product.
test('slugCandidates leads with immich for an immich check', () => {
  expect(slugCandidates({ name: 'Photos', url: 'https://192.168.1.10:2283', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
  expect(slugCandidates({ name: 'Photos', url: 'https://photos.example.com/', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
});
