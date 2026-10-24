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

// The spellings real pages use, pinned so making the scan linear cannot quietly
// change what it reads: case, quoting styles, spaces around `=`, attributes
// butted against a closing quote, hyphenated names, `name=value` text inside a
// quoted value, and a final tag the 64 KiB prefix cut off before its `>`.
test('parseIconLinks reads real-world attribute spellings', () => {
  const html = [
    '<LINK REL="Shortcut Icon" HREF="/upper.ico">',
    "<link rel='icon' href='/single.png' sizes='16x16 48x48'>",
    '<link rel=icon href=/bare.png sizes=64x64>',
    '<link rel = "icon" href = "/spaced.png" sizes = "96x96">',
    '<link data-n-head="ssr" rel="icon" type="image/svg+xml" href="/nuxt.svg">',
    '<link href="/tight.png"rel="icon"sizes="128x128"/>',
    '<link title="rel=icon" rel="stylesheet" href="/app.css">',
    '<link\n  rel="apple-touch-icon"\n  href="/multiline.png"\n  sizes="180x180"\n>',
    '<link rel="mask-icon" href="/mask.svg" color="#5bbad5">',
    '<link rel="icon" href="/cut.png" sizes="512x512"',
  ].join('\n');
  expect(parseIconLinks(html, 'https://app.example.com/')).toEqual([
    'https://app.example.com/nuxt.svg',
    'https://app.example.com/mask.svg',
    'https://app.example.com/multiline.png',
    'https://app.example.com/tight.png',
    'https://app.example.com/spaced.png',
    'https://app.example.com/bare.png',
    'https://app.example.com/single.png',
    'https://app.example.com/upper.ico',
  ]);
});

// The page is whatever the tile's URL (or a redirect) serves, and the scan runs
// synchronously on the server's only thread, so a super-linear pattern is a
// remote stall of every terminal. Inputs are 4x the 64 KiB prefix iconStore
// passes: a quadratic scan takes seconds on them, a linear one milliseconds.
const HOSTILE = 256 * 1024;
function timedParse(html) {
  const start = performance.now();
  const urls = parseIconLinks(html, 'https://app.example.com/');
  return { urls, ms: performance.now() - start };
}

test('parseIconLinks stays linear on a long run of attribute-name characters', () => {
  for (const html of [
    `<link ${'a'.repeat(HOSTILE)}>`,
    `<link ${'a-'.repeat(HOSTILE / 2)}>`,
    `<link ${'a'.repeat(HOSTILE)}="${'b'.repeat(HOSTILE)}>`,
  ]) {
    const { urls, ms } = timedParse(html);
    expect(urls).toEqual([]);
    expect(ms).toBeLessThan(250);
  }
});

test('parseIconLinks stays linear on many <link openings that never close', () => {
  for (const tail of ['<link'.repeat(HOSTILE / 5), '<link rel="icon" '.repeat(HOSTILE / 17)]) {
    const { urls, ms } = timedParse(`<link rel="icon" href="/ok.png">${tail}`);
    expect(urls).toEqual(['https://app.example.com/ok.png']);
    expect(ms).toBeLessThan(250);
  }
});

// The kind declares the slug rather than the name guessing it, and an IP
// literal contributes no candidate — an address is not a product.
test('slugCandidates leads with immich for an immich check', () => {
  expect(slugCandidates({ name: 'Photos', url: 'https://192.168.1.10:2283', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
  expect(slugCandidates({ name: 'Photos', url: 'https://photos.example.com/', check: { kind: 'immich' } }))
    .toEqual(['immich', 'photos']);
});
