import { test, expect } from 'vitest';
import { importSummary, exportStats, exportSizeBytes, exportFilename } from '../src/web/settingsBoxes.ts';

test('importSummary: singular vs plural box count', () => {
  expect(importSummary(1, 0)).toBe('Imported 1 box');
  expect(importSummary(3, 0)).toBe('Imported 3 boxes');
  expect(importSummary(0, 0)).toBe('Imported 0 boxes');
});

test('importSummary: the skipped clause appears only when something was skipped', () => {
  expect(importSummary(3, 1)).toBe('Imported 3 boxes, 1 skipped');
  expect(importSummary(1, 2)).toBe('Imported 1 box, 2 skipped');
  expect(importSummary(0, 4)).toBe('Imported 0 boxes, 4 skipped');
  expect(importSummary(2, 0)).toBe('Imported 2 boxes');
});

test('exportStats: counts totals, source split, and optional-field usage', () => {
  const payload = {
    type: 'tmuxifier-boxes', version: 1, exportedAt: '2026-08-01T10:00:00.000Z',
    boxes: [
      // manual box using every optional field
      { id: 'a', label: 'one', host: '192.168.1.10', user: 'ops', port: 2222,
        proxyJump: 'jump.example.com', sessionName: 'web', startupCommand: 'htop',
        tags: ['lab'], source: 'manual' },
      // proxmox-linked box using none of them
      { id: 'b', label: 'two', host: '192.168.1.11', sessionName: 'web',
        tags: [], source: 'proxmox',
        proxmox: { hostId: 'h', node: 'n', vmid: 101, kind: 'lxc' } },
      // manual box with only a tag
      { id: 'c', label: 'three', host: '192.168.1.12', sessionName: 'web',
        tags: ['lab'], source: 'manual' },
    ],
  };
  expect(exportStats(payload)).toEqual({
    total: 3, manual: 2, proxmox: 1, tagged: 2,
    proxyJump: 1, startupCommand: 1, customPort: 1, customUser: 1,
  });
});

test('exportStats: a malformed payload yields zeroed counts, not a throw', () => {
  const zero = { total: 0, manual: 0, proxmox: 0, tagged: 0, proxyJump: 0, startupCommand: 0, customPort: 0, customUser: 0 };
  expect(exportStats(null)).toEqual(zero);
  expect(exportStats({})).toEqual(zero);
  expect(exportStats({ boxes: 'not an array' })).toEqual(zero);
  expect(exportStats([])).toEqual(zero); // a bare array is not the wrapped payload
});

test('exportStats: empty strings do not count as field usage; any present port does', () => {
  const payload = { boxes: [
    { host: 'h1', sessionName: 'web', tags: [], source: 'manual', user: '  ', proxyJump: '', startupCommand: '' },
    { host: 'h2', sessionName: 'web', tags: [], source: 'manual', port: 22 },
    null, // a junk row is skipped-as-empty, not fatal
  ] };
  const s = exportStats(payload);
  expect(s.total).toBe(3);
  expect(s.customUser).toBe(0);
  expect(s.proxyJump).toBe(0);
  expect(s.startupCommand).toBe(0);
  expect(s.customPort).toBe(1); // present = custom, even the default 22
});

test('exportSizeBytes: UTF-8 bytes, not string length', () => {
  expect(exportSizeBytes('abc')).toBe(3);
  expect(exportSizeBytes('ü')).toBe(2);
  expect(exportSizeBytes('')).toBe(0);
});

test('exportFilename: mirrors the server Content-Disposition date stamp', () => {
  expect(exportFilename('2026-08-01T10:00:00.000Z')).toBe('tmuxifier-boxes-2026-08-01.json');
  expect(exportFilename('garbage')).toBe('tmuxifier-boxes.json');
});
