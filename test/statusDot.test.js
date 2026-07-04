import { test, expect } from 'vitest';
import {
  dotClassFor, dotTitleFor, classifyError, metaSegmentsFor, CPU_ICON,
  cpuLoadPct, cpuLevel,
} from '../src/web/statusDot.ts';

// Local plain-text join of the segments (value + icon, ' · ' separated) — the
// production metaLineFor export was dead code and removed; the formatting
// assertions below still cover metaSegmentsFor through the same join.
const metaLine = (st) => metaSegmentsFor(st).map((s) => (s.icon ? `${s.text} ${s.icon}` : s.text)).join(' · ');

test('dotClassFor: unknown status is gray', () => {
  expect(dotClassFor(undefined)).toBe('gray');
});

test('dotClassFor: reachable with tmux is green', () => {
  expect(dotClassFor({ reachable: true, tmux: true })).toBe('green');
});

test('dotClassFor: reachable without tmux is amber', () => {
  expect(dotClassFor({ reachable: true, tmux: false })).toBe('amber');
});

test('dotClassFor: unreachable is red', () => {
  expect(dotClassFor({ reachable: false })).toBe('red');
});

test('dotClassFor: needsAuth wins over reachable=false (distinct from a dead box)', () => {
  expect(dotClassFor({ reachable: false, needsAuth: true })).toBe('auth');
});

test('dotTitleFor: needsAuth explains how to recover', () => {
  expect(dotTitleFor({ reachable: false, needsAuth: true })).toMatch(/reconnect/i);
});

test('dotTitleFor: paused unreachable explains the 5m retry and how to force one', () => {
  const title = dotTitleFor({ reachable: false, paused: true });
  expect(title).toMatch(/5m/);
  expect(title).toMatch(/retry/i);
});

test('dotTitleFor: plain (non-paused) unreachable stays terse', () => {
  expect(dotTitleFor({ reachable: false })).toBe('Unreachable');
});

test('dotTitleFor: includes the classified reason when the probe captured an error', () => {
  const title = dotTitleFor({ reachable: false, error: 'kex_exchange_identification: read: Connection reset by peer' });
  expect(title).toMatch(/Unreachable/);
  expect(title).toMatch(/banned|fail2ban/i);
});

test('classifyError: fail2ban / port-22 ban signature', () => {
  expect(classifyError('kex_exchange_identification: Connection closed by remote host')).toMatch(/banned|fail2ban/i);
  expect(classifyError('Connection reset by peer')).toMatch(/banned|fail2ban/i);
});

test('classifyError: connection refused means sshd down / wrong port', () => {
  expect(classifyError('ssh: connect to host h port 22: Connection refused')).toMatch(/sshd|port/i);
});

test('classifyError: timeouts / no route mean the host is offline', () => {
  expect(classifyError('ssh: connect to host h port 22: Connection timed out')).toMatch(/offline|network/i);
  expect(classifyError('No route to host')).toMatch(/offline|network/i);
});

test('classifyError: host key change is called out', () => {
  expect(classifyError('REMOTE HOST IDENTIFICATION HAS CHANGED!')).toMatch(/host key/i);
});

test('classifyError: an unrecognized error passes through trimmed; empty is generic', () => {
  expect(classifyError('  weird boom  ')).toBe('weird boom');
  expect(classifyError(undefined)).toBe('Unreachable');
});

test('meta line: formats present metrics as load · mem% · disk% (raw load when cpus unknown)', () => {
  const st = { reachable: true, tmux: true, metrics: { load1: 0.42, memTotalKb: 1000, memAvailKb: 620, diskPct: 61 } };
  expect(metaLine(st)).toBe(`0.42 ${CPU_ICON} · 38% 🧠 · 61% 💾`);
});

test('cpuLoadPct: normalizes load by core count to a percent', () => {
  expect(cpuLoadPct({ load1: 4.25, cpus: 4 })).toBe(106);
  expect(cpuLoadPct({ load1: 0.72, cpus: 4 })).toBe(18);
  expect(cpuLoadPct({ load1: 2, cpus: 0 })).toBeUndefined();   // no usable core count
  expect(cpuLoadPct({ cpus: 4 })).toBeUndefined();             // no load
  expect(cpuLoadPct(undefined)).toBeUndefined();
});

test('cpuLevel: <70 ok, 70..100 warn, >100 crit', () => {
  expect(cpuLevel(18)).toBe('ok');
  expect(cpuLevel(69)).toBe('ok');
  expect(cpuLevel(70)).toBe('warn');
  expect(cpuLevel(100)).toBe('warn');
  expect(cpuLevel(106)).toBe('crit');
});

test('meta line: shows "% cpu" (load ÷ cores) when the core count is known', () => {
  const st = { reachable: true, tmux: true, metrics: { load1: 4.25, cpus: 4, memTotalKb: 1000, memAvailKb: 920, diskPct: 58 } };
  expect(metaLine(st)).toBe(`106% ${CPU_ICON} · 8% 🧠 · 58% 💾`);
});

test('metaSegmentsFor: colors only the cpu segment by severity, leaves mem/disk plain', () => {
  const st = { reachable: true, tmux: true, metrics: { load1: 4.25, cpus: 4, memTotalKb: 1000, memAvailKb: 920, diskPct: 58 } };
  const segs = metaSegmentsFor(st);
  expect(segs.map((s) => s.text)).toEqual(['106%', '8%', '58%']);
  expect(segs.map((s) => s.icon)).toEqual([CPU_ICON, '🧠', '💾']);
  expect(segs[0].iconClass).toBe('nf');          // CPU icon renders in the Nerd Font
  expect(segs[0].level).toBe('crit');
  expect(segs[0].title).toMatch(/4\.25.*4 core/);
  expect(segs[1].level).toBeUndefined();
  expect(segs[2].level).toBeUndefined();
});

test('metaSegmentsFor: prefers true cgroup cpuPct over load-derived', () => {
  const st = { reachable: true, tmux: true, metrics: { cpuPct: 12, load1: 4.25, cpus: 4, memTotalKb: 1000, memAvailKb: 920 } };
  const segs = metaSegmentsFor(st);
  expect(segs[0].text).toBe('12%');              // not 106% from the misleading load
  expect(segs[0].icon).toBe(CPU_ICON);
  expect(segs[0].level).toBe('ok');
  expect(segs[0].title).toMatch(/utilization/i);
});

test('metaSegmentsFor: cgroup host still warming up (counter but no rate yet) omits the cpu segment', () => {
  const st = { reachable: true, tmux: true, metrics: { cpuUsageUsec: 123, cpus: 4, load1: 4.25, memTotalKb: 1000, memAvailKb: 900 } };
  const segs = metaSegmentsFor(st);
  expect(segs.map((s) => s.text)).toEqual(['10%']);      // no cpu segment; load is NOT shown
  expect(segs[0].icon).toBe('🧠');
});

test('metaSegmentsFor: falls back to load-normalized only when there is no cgroup counter at all', () => {
  const st = { reachable: true, tmux: true, metrics: { load1: 4.25, cpus: 4 } };
  expect(metaSegmentsFor(st)[0].text).toBe('106%');
  expect(metaSegmentsFor(st)[0].icon).toBe(CPU_ICON);
});

test('metaSegmentsFor: a down box is a single crit segment with the reason', () => {
  const segs = metaSegmentsFor({ reachable: false, error: 'Connection refused' });
  expect(segs).toHaveLength(1);
  expect(segs[0].level).toBe('crit');
  expect(segs[0].text).toMatch(/sshd|port/i);
});

test('meta line: omits segments whose metric is missing', () => {
  expect(metaLine({ reachable: true, tmux: true, metrics: { diskPct: 9 } })).toBe('9% 💾');
});

test('meta line: reachable with no metrics is empty (row shows just the name)', () => {
  expect(metaLine({ reachable: true, tmux: true })).toBe('');
});

test('meta line: unreachable shows the classified reason; needsAuth says needs login', () => {
  expect(metaLine({ reachable: false, error: 'Connection refused' })).toMatch(/sshd|port/i);
  expect(metaLine({ reachable: false, needsAuth: true })).toMatch(/login/i);
});

test('metaSegmentsFor: tags each metric segment so the sparkline can highlight its source', () => {
  const st = { reachable: true, tmux: true, metrics: { cpuPct: 12, memTotalKb: 1000, memAvailKb: 920, diskPct: 58 } };
  expect(metaSegmentsFor(st).map((s) => s.metric)).toEqual(['cpu', 'mem', 'disk']);
  // every cpu branch carries the tag: load-normalized fallback and raw load too
  expect(metaSegmentsFor({ reachable: true, metrics: { load1: 4.25, cpus: 4 } })[0].metric).toBe('cpu');
  expect(metaSegmentsFor({ reachable: true, metrics: { load1: 4.25 } })[0].metric).toBe('cpu');
  // non-metric segments (down reason, needs login) carry none
  expect(metaSegmentsFor({ reachable: false, error: 'Connection refused' })[0].metric).toBeUndefined();
  expect(metaSegmentsFor({ reachable: false, needsAuth: true })[0].metric).toBeUndefined();
});

// (activity badge removed — session_activity bumps on any output, so the "unseen"
// signal was on for essentially every busy box; the helpers were deleted.)
