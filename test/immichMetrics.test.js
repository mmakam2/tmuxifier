import { test, expect } from 'vitest';
import { buildMetrics, buildJobRollup } from '../src/server/immichMetrics.js';
import {
  ABOUT, STORAGE, STATISTICS, JOBS_IDLE, JOBS_BUSY,
  VERSION_CHECK, VERSION_CHECK_NEWER, CONFIG, CONFIG_MAINTENANCE,
} from './helpers/immichSamples.js';

const build = (over = {}) => buildMetrics({
  about: ABOUT, storage: STORAGE, statistics: STATISTICS, jobs: JOBS_IDLE,
  versionCheck: VERSION_CHECK, config: CONFIG, denied: [], ...over,
});

test('buildJobRollup sums across every queue and names the paused ones', () => {
  const r = buildJobRollup(JOBS_BUSY);
  expect(r.active).toBe(3);
  // waiting folds in `delayed`: a delayed job is queued work the operator has
  // not seen run yet, and splitting the two would understate the backlog.
  expect(r.waiting).toBe(125);
  expect(r.failed).toBe(3);
  expect(r.paused).toEqual(['metadataExtraction']);
});

test('buildJobRollup ignores the cumulative completed counter', () => {
  const r = buildJobRollup(JOBS_BUSY);
  expect(r).not.toHaveProperty('completed');
});

test('buildJobRollup tolerates a malformed queue entry', () => {
  const r = buildJobRollup({ good: JOBS_BUSY.thumbnailGeneration, bad: null, worse: 'nope' });
  expect(r.active).toBe(2);
  expect(r.paused).toEqual([]);
});

test('buildMetrics separates library usage from disk usage', () => {
  const m = build();
  expect(m.libraryBytes).toBe(322122547200);
  expect(m.diskUsedBytes).toBe(429496729600);
  expect(m.diskSizeBytes).toBe(1099511627776);
  expect(m.diskFreeBytes).toBe(670014898176);
});

test('buildMetrics rounds the disk percentage', () => {
  expect(build().diskUsedPct).toBe(39);
});

test('buildMetrics reports no update when the versions match', () => {
  const m = build();
  expect(m.version).toBe('v3.0.3');
  expect(m.updateAvailable).toBe(false);
});

test('buildMetrics reports an update when the release version differs', () => {
  const m = build({ versionCheck: VERSION_CHECK_NEWER });
  expect(m.updateAvailable).toBe(true);
  expect(m.releaseVersion).toBe('v3.1.0');
});

test('buildMetrics ignores a v prefix mismatch rather than crying update', () => {
  const m = build({ versionCheck: { releaseVersion: '3.0.3', checkedAt: null } });
  expect(m.updateAvailable).toBe(false);
});

test('buildMetrics counts users and names the largest consumer', () => {
  const m = build();
  expect(m.users).toBe(3);
  expect(m.topUser).toEqual({ name: 'Example User', bytes: 311385128960 });
});

test('buildMetrics reads maintenance mode', () => {
  expect(build().maintenanceMode).toBe(false);
  expect(build({ config: CONFIG_MAINTENANCE }).maintenanceMode).toBe(true);
});

// The 403-degradation contract: a refused endpoint yields null readings, never
// zeroes. A zero would render as a real "0 photos" and read as data loss.
test('buildMetrics nulls the readings of a refused endpoint', () => {
  const m = build({ statistics: null, jobs: null, denied: ['server.statistics', 'job.read'] });
  expect(m.photos).toBeNull();
  expect(m.videos).toBeNull();
  expect(m.libraryBytes).toBeNull();
  expect(m.users).toBeNull();
  expect(m.topUser).toBeNull();
  expect(m.jobs).toBeNull();
  expect(m.denied).toEqual(['server.statistics', 'job.read']);
  // Storage came from a different endpoint and must survive.
  expect(m.diskUsedPct).toBe(39);
});

test('buildMetrics distinguishes a refused jobs endpoint from genuinely idle queues', () => {
  expect(build({ jobs: JOBS_IDLE }).jobs).toEqual({ active: 0, waiting: 0, failed: 0, paused: [] });
  expect(build({ jobs: null, denied: ['job.read'] }).jobs).toBeNull();
});

test('buildMetrics survives every payload being absent', () => {
  const m = buildMetrics({});
  expect(m.version).toBeNull();
  expect(m.diskUsedPct).toBeNull();
  expect(m.updateAvailable).toBe(false);
  expect(m.maintenanceMode).toBe(false);
  expect(m.denied).toEqual([]);
});
