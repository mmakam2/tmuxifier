import { test, expect } from 'vitest';
import {
  truenasLamp, truenasCardModel, POOL_WARN_PCT, POOL_CRIT_PCT, MAX_POOL_ROWS,
} from '../src/web/truenasCard.ts';
import { fmtBytes } from '../src/web/fmt.ts';

const pool = (over = {}) => ({
  name: 'tank', size: 1000, allocated: 100, free: 900,
  usedPct: 10, healthy: true, status: 'ONLINE', scanning: false, ...over,
});
const metrics = (over = {}) => ({
  pools: [pool()], alerts: { critical: 0, warning: 0 },
  version: '25.10.5', hostname: 'nas', uptimeSec: 3563000, ...over,
});
const up = (over = {}) => ({ state: 'up', latencyMs: 12, truenas: metrics(over) });
const svc = { id: 'svc-1', name: 'nas', url: 'https://nas.example.com', check: { kind: 'truenas', username: 'truenas_admin' }, createdAt: '' };
const snap = (result) => ({ checkedAt: 'now', results: { 'svc-1': result } });

test('fmtBytes: binary units, one decimal below 100, none above', () => {
  expect(fmtBytes(null)).toBe('—');
  expect(fmtBytes(512)).toBe('512 B');
  expect(fmtBytes(1536)).toBe('1.5 KB');
  expect(fmtBytes(7037143449600)).toBe('6.4 TB');
});

test('lamp: green when every pool is online, under the warn mark, with no alerts', () => {
  expect(truenasLamp(up())).toBe('green');
});

test('lamp: amber for a degraded pool, a warning alert, or a pool at the warn mark', () => {
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'DEGRADED' })] }))).toBe('amber');
  expect(truenasLamp(up({ alerts: { critical: 0, warning: 1 } }))).toBe('amber');
  expect(truenasLamp(up({ pools: [pool({ usedPct: POOL_WARN_PCT })] }))).toBe('amber');
});

test('lamp: red for a faulted pool, a critical alert, or a pool at the crit mark', () => {
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'FAULTED' })] }))).toBe('red');
  expect(truenasLamp(up({ pools: [pool({ healthy: false, status: 'UNAVAIL' })] }))).toBe('red');
  expect(truenasLamp(up({ alerts: { critical: 1, warning: 0 } }))).toBe('red');
  expect(truenasLamp(up({ pools: [pool({ usedPct: POOL_CRIT_PCT })] }))).toBe('red');
});

test('lamp: red outranks amber, and auth outranks both', () => {
  expect(truenasLamp(up({ pools: [pool({ usedPct: 95 })], alerts: { critical: 0, warning: 3 } }))).toBe('red');
  expect(truenasLamp({ state: 'auth', error: 'API key rejected' })).toBe('auth');
});

test('lamp: down is red, and no result at all is blank', () => {
  expect(truenasLamp({ state: 'down', error: 'refused' })).toBe('red');
  expect(truenasLamp(undefined)).toBe('');
});

test('model: one row per pool, used percent and free space formatted', () => {
  const m = truenasCardModel(svc, snap(up({
    pools: [pool({ name: 'tank', usedPct: 68.02, free: 7037143449600 })],
  })));
  expect(m.rows).toEqual([{ name: 'tank', used: '68%', free: '6.4 TB free', scanning: false, level: '' }]);
  expect(m.error).toBe('');
});

test('model: a pool at or over the warn and crit marks is levelled for styling', () => {
  const m = truenasCardModel(svc, snap(up({
    pools: [pool({ name: 'a', usedPct: 85 }), pool({ name: 'b', usedPct: 95 })],
  })));
  expect(m.rows.map((r) => r.level)).toEqual(['warn', 'crit']);
});

test('model: rows are capped and the overflow is counted, not dropped silently', () => {
  const many = Array.from({ length: MAX_POOL_ROWS + 2 }, (_, i) => pool({ name: `p${i}` }));
  const m = truenasCardModel(svc, snap(up({ pools: many })));
  expect(m.rows).toHaveLength(MAX_POOL_ROWS);
  expect(m.more).toBe('+2 more pools');
});

test('model: the chip carries the worst pool state and the active alert count', () => {
  expect(truenasCardModel(svc, snap(up())).chip).toBe('healthy');
  expect(truenasCardModel(svc, snap(up({ alerts: { critical: 1, warning: 1 } }))).chip).toBe('healthy · 2 alerts');
  expect(truenasCardModel(svc, snap(up({
    pools: [pool(), pool({ name: 'b', healthy: false, status: 'DEGRADED' })],
  }))).chip).toBe('degraded');
  expect(truenasCardModel(svc, snap(up({ alerts: { critical: 0, warning: 1 } }))).chip).toBe('healthy · 1 alert');
});

test('model: a scrubbing pool is marked on its own row, not in the chip', () => {
  const m = truenasCardModel(svc, snap(up({ pools: [pool({ scanning: true })] })));
  expect(m.rows[0].scanning).toBe(true);
  expect(m.chip).toBe('healthy');
});

test('model: the footer is version and uptime', () => {
  expect(truenasCardModel(svc, snap(up())).footer).toBe('25.10.5 · up 41d 5h');
});

test('model: a null-capacity pool shows dashes rather than NaN', () => {
  const m = truenasCardModel(svc, snap(up({ pools: [pool({ size: null, allocated: null, free: null, usedPct: null })] })));
  expect(m.rows[0]).toMatchObject({ used: '—', free: '— free' });
});

test('model: a failed check is one error line, not a grid of dashes', () => {
  const auth = truenasCardModel(svc, snap({ state: 'auth', error: 'API key rejected' }));
  expect(auth).toMatchObject({ lamp: 'auth', rows: [], chip: '', footer: '', error: 'API key rejected' });

  const down = truenasCardModel(svc, snap({ state: 'down', error: 'connection refused' }));
  expect(down).toMatchObject({ lamp: 'red', rows: [], error: 'connection refused' });
});

test('model: before the first sweep there is no lamp and no error', () => {
  expect(truenasCardModel(svc, null)).toMatchObject({ lamp: '', rows: [], error: '' });
});
