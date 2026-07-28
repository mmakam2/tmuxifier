import { test, expect } from 'vitest';
import {
  immichCardModel, immichLamp, deniedNote, immichException,
  DISK_WARN_PCT, DISK_CRIT_PCT,
} from '../src/web/immichCard.ts';

const svc = { id: 's1', name: 'Photos', url: 'https://immich.example.com', check: { kind: 'immich' }, createdAt: '' };

const metrics = (over = {}) => ({
  version: 'v3.0.3', releaseVersion: 'v3.0.3', updateAvailable: false, checkedAt: null,
  photos: 48300, videos: 1200, libraryBytes: 322122547200,
  users: 3, topUser: { name: 'Example User', bytes: 311385128960 },
  diskUsedBytes: 429496729600, diskSizeBytes: 1099511627776,
  diskFreeBytes: 670014898176, diskUsedPct: 39,
  jobs: { active: 0, waiting: 0, failed: 0, paused: [] },
  maintenanceMode: false, denied: [],
  ...over,
});

const snap = (result) => ({ checkedAt: null, results: { s1: result } });
const up = (over = {}) => snap({ state: 'up', latencyMs: 8, immich: metrics(over) });

test('lamp is green on a healthy server', () => {
  expect(immichLamp({ state: 'up', immich: metrics() })).toBe('green');
});

test('lamp is auth on a rejected key, outranking every metric', () => {
  expect(immichLamp({ state: 'auth', immich: metrics({ diskUsedPct: 99 }) })).toBe('auth');
});

test('lamp is red when the server is unreachable', () => {
  expect(immichLamp({ state: 'down' })).toBe('red');
});

test('lamp escalates with disk usage across the named thresholds', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_WARN_PCT - 1 }) })).toBe('green');
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_WARN_PCT }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ diskUsedPct: DISK_CRIT_PCT }) })).toBe('red');
});

test('lamp is amber on failed jobs, a paused queue, or maintenance mode', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ jobs: { active: 0, waiting: 0, failed: 2, paused: [] } }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused: ['smartSearch'] } }) })).toBe('amber');
  expect(immichLamp({ state: 'up', immich: metrics({ maintenanceMode: true }) })).toBe('amber');
});

// A dashboard that turns amber every time upstream cuts a release is one the
// operator stops reading.
test('an available update never drives the lamp', () => {
  expect(immichLamp({ state: 'up', immich: metrics({ updateAvailable: true, releaseVersion: 'v3.1.0' }) })).toBe('green');
});

// A least-privilege key is a configuration, not a fault.
test('denied permissions never drive the lamp', () => {
  const m = metrics({ denied: ['server.statistics'], photos: null, videos: null, libraryBytes: null, users: null, topUser: null });
  expect(immichLamp({ state: 'up', immich: m })).toBe('green');
});

test('deniedNote names the permissions and the readings they cost', () => {
  expect(deniedNote([])).toBe('');
  expect(deniedNote(['server.statistics'])).toBe('needs server.statistics for library counts');
  expect(deniedNote(['server.statistics', 'job.read']))
    .toBe('needs server.statistics and job.read for library counts and jobs');
});

test('exception ranks maintenance mode above failed jobs above paused queues', () => {
  const busted = { active: 0, waiting: 0, failed: 2, paused: ['smartSearch'] };
  expect(immichException(metrics({ maintenanceMode: true, jobs: busted }))).toMatch(/maintenance mode/);
  expect(immichException(metrics({ jobs: busted }))).toBe('2 failed jobs');
  expect(immichException(metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused: ['smartSearch'] } })))
    .toBe('smartSearch paused');
  expect(immichException(metrics())).toBe('');
});

test('exception counts paused queues beyond the named cap', () => {
  const paused = ['a', 'b', 'c', 'd', 'e'];
  expect(immichException(metrics({ jobs: { active: 0, waiting: 0, failed: 0, paused } })))
    .toBe('a, b, c +2 more paused');
});

test('model renders six cells with library and disk kept distinct', () => {
  const m = immichCardModel(svc, up());
  expect(m.cells.map((c) => c.label)).toEqual(['PHOTOS', 'VIDEOS', 'LIBRARY', 'DISK', 'FREE', 'VERSION']);
  expect(m.cells[0].value).toBe('48.3k');
  expect(m.cells[1].value).toBe('1,200');
  expect(m.cells[2].value).toBe('300 GB');   // library
  expect(m.cells[3].value).toBe('39%');       // disk
  expect(m.cells[4].value).toBe('624 GB');
  expect(m.cells[5].value).toBe('v3.0.3');
});

test('model dashes the cells a refused permission cannot fill', () => {
  const m = immichCardModel(svc, up({
    denied: ['server.statistics'], photos: null, videos: null, libraryBytes: null, users: null, topUser: null,
  }));
  expect(m.cells[0].value).toBe('—');
  expect(m.cells[2].value).toBe('—');
  expect(m.cells[3].value).toBe('39%'); // storage came from a different endpoint
  expect(m.note).toBe('needs server.statistics for library counts');
  expect(m.lamp).toBe('green');
});

test('model omits the jobs row when the key may not read the queues', () => {
  const m = immichCardModel(svc, up({ jobs: null, denied: ['job.read'] }));
  expect(m.rows.map((r) => r.label)).not.toContain('JOBS');
});

test('model reports idle queues rather than omitting the row', () => {
  const m = immichCardModel(svc, up());
  expect(m.rows.find((r) => r.label === 'JOBS').value).toBe('idle');
});

test('model summarises busy queues', () => {
  const m = immichCardModel(svc, up({ jobs: { active: 2, waiting: 125, failed: 3, paused: [] } }));
  expect(m.rows.find((r) => r.label === 'JOBS').value).toBe('2 active · 125 waiting · 3 failed');
});

test('model names the largest consumer on the users row', () => {
  const m = immichCardModel(svc, up());
  expect(m.rows.find((r) => r.label === 'USERS').value).toBe('3 · 290 GB largest (Example User)');
});

test('model shows the update row only when one is available', () => {
  expect(immichCardModel(svc, up()).rows.map((r) => r.label)).not.toContain('UPDATE');
  const m = immichCardModel(svc, up({ updateAvailable: true, releaseVersion: 'v3.1.0' }));
  expect(m.rows.find((r) => r.label === 'UPDATE').value).toBe('v3.1.0 available');
});

test('model chips the library size and job state', () => {
  expect(immichCardModel(svc, up()).chip).toBe('300 GB · jobs idle');
  expect(immichCardModel(svc, up({ jobs: { active: 4, waiting: 0, failed: 0, paused: [] } })).chip)
    .toBe('300 GB · 4 active');
});

test('model shows one error line rather than a grid of dashes when down', () => {
  const m = immichCardModel(svc, snap({ state: 'down', error: 'connect ECONNREFUSED' }));
  expect(m.cells).toEqual([]);
  expect(m.rows).toEqual([]);
  expect(m.error).toBe('connect ECONNREFUSED');
  expect(m.lamp).toBe('red');
});

test('model is blank before the first sweep result arrives', () => {
  const m = immichCardModel(svc, { checkedAt: null, results: {} });
  expect(m.lamp).toBe('');
  expect(m.error).toBe('');
  expect(m.cells).toEqual([]);
});
