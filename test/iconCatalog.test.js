import { test, expect } from 'vitest';
import { CATALOG_EXTS, CATALOG_SLUGS, ICON_CDN, iconUrl } from '../src/server/iconCatalog.js';
import { ICON_SLUG } from '../src/server/iconResolve.js';

test('every catalog slug is a valid slug and appears once', () => {
  for (const slug of CATALOG_SLUGS) expect(slug).toMatch(ICON_SLUG);
  expect(new Set(CATALOG_SLUGS).size).toBe(CATALOG_SLUGS.length);
});

test('the catalog covers the four check kinds and never reserves "none"', () => {
  for (const slug of ['unifi', 'truenas', 'pi-hole', 'proxmox']) expect(CATALOG_SLUGS).toContain(slug);
  expect(CATALOG_SLUGS).not.toContain('none');
});

test('iconUrl is a closed allowlist, not a URL builder', () => {
  expect(iconUrl('proxmox')).toBe(`${ICON_CDN}svg/proxmox.svg`);
  expect(iconUrl('proxmox', 'png')).toBe(`${ICON_CDN}png/proxmox.png`);
  for (const bad of ['../../etc/passwd', 'not-in-the-catalog', 'constructor', 'toString', '', null, undefined]) {
    expect(iconUrl(bad)).toBe(null);
  }
});

test('iconUrl closes the extension too, so neither half of the path is caller-steered', () => {
  expect(CATALOG_EXTS).toEqual(['svg', 'png']);
  for (const bad of ['../../etc/passwd', 'svg/../..', 'gif', '', null]) {
    expect(iconUrl('proxmox', bad)).toBe(null);
  }
  // undefined is not a bad value — it is how the one-argument call selects the
  // SVG default, so it must keep resolving.
  expect(iconUrl('proxmox', undefined)).toBe(`${ICON_CDN}svg/proxmox.svg`);
});
