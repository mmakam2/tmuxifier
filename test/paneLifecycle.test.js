import { test, expect } from 'vitest';
import { lifecycleKeysFor, armReduce, chipFor, IDLE } from '../src/web/paneLifecycle.ts';

const actions = (keys) => keys.map((k) => k.action);
const keyFor = (paneState, pveState, action) =>
  lifecycleKeysFor(paneState, pveState).find((k) => k.action === action);

test('a running container offers shutdown, reboot and force stop', () => {
  expect(actions(lifecycleKeysFor('terminal', 'running'))).toEqual(['shutdown', 'reboot', 'stop']);
});

test('only force stop is marked danger', () => {
  const keys = lifecycleKeysFor('terminal', 'running');
  expect(keys.filter((k) => k.danger).map((k) => k.action)).toEqual(['stop']);
});

test('a stopped pane offers start', () => {
  expect(actions(lifecycleKeysFor('stopped', 'stopped'))).toEqual(['start']);
});

// paneState is sticky through a failed PVE read (see paneState in main.ts): a
// stopped pane must not lose its Start key just because the probe went blind.
test('a stopped pane keeps start when the PVE read is unknown', () => {
  expect(actions(lifecycleKeysFor('stopped', 'unknown'))).toEqual(['start']);
});

test('missing, unknown and absent PVE state offer nothing', () => {
  expect(lifecycleKeysFor('terminal', 'missing')).toEqual([]);
  expect(lifecycleKeysFor('terminal', 'unknown')).toEqual([]);
  expect(lifecycleKeysFor('terminal', undefined)).toEqual([]);
});

// A mismatch means the guest at this vmid may not be ours (a different guest
// reused the number), so it offers nothing — same treatment as 'unknown',
// matching proxmoxGuests.ts's actionsForState('mismatch').
test('a kind mismatch offers no lifecycle key even for an otherwise-running pane', () => {
  expect(lifecycleKeysFor('terminal', 'mismatch')).toEqual([]);
});

// A box mid-setup is running, but every one of these actions would interrupt
// the setup job that just provisioned it.
test('a setting-up pane offers nothing even while the guest runs', () => {
  expect(lifecycleKeysFor('setup', 'running')).toEqual([]);
});

// mergeProxmoxStatus (proxmoxInventory.js) now carries the template flag into
// the status snapshot specifically so this can be enforced here too: a
// template must never offer Start just because paneState reads 'stopped'.
test('a template guest offers no lifecycle key even for an otherwise-startable stopped pane', () => {
  expect(lifecycleKeysFor('stopped', 'stopped', true)).toEqual([]);
});

test('deprovision is never offered', () => {
  const everyKey = ['terminal', 'stopped', 'setup'].flatMap((pane) =>
    ['running', 'stopped', 'missing', 'unknown', 'mismatch'].flatMap((pve) => lifecycleKeysFor(pane, pve)));
  expect(everyKey.some((k) => k.action === 'deprovision')).toBe(false);
});

// Every key carries two faces: the word it draws when the header has room, and
// the glyph it collapses to when it does not (style.css swaps them on a
// container query — the DOM always holds both, so no JS reads a width).
const ALL_KEYS = ['terminal', 'stopped'].flatMap((pane) =>
  ['running', 'stopped'].flatMap((pve) => lifecycleKeysFor(pane, pve)));

test('every key carries both a word face and a single-glyph icon', () => {
  expect(ALL_KEYS.length).toBeGreaterThan(0);
  for (const k of ALL_KEYS) {
    expect(k.face, k.action).toMatch(/^[A-Z]+$/);
    expect([...k.icon], `${k.action} icon is one glyph`).toHaveLength(1);
  }
});

// The collapsed marks must all come from ONE icon family, because style.css
// sizes them with a single rule and no per-glyph correction. The Nerd Font
// Private Use Area is where that family lives (the bundled Meslo faces' Font
// Awesome set); a mark from outside it would be a Unicode glyph drawn by an
// unrelated hand, which is what made the first two attempts at this need four
// hand-tuned font-sizes that still did not match.
test('every collapsed mark comes from the Nerd Font PUA', () => {
  for (const k of ALL_KEYS) {
    const cp = k.icon.codePointAt(0);
    expect(cp, `${k.action} (U+${cp.toString(16).toUpperCase()})`).toBeGreaterThanOrEqual(0xe000);
    expect(cp, `${k.action} (U+${cp.toString(16).toUpperCase()})`).toBeLessThanOrEqual(0xf8ff);
  }
});

test('the stop key is nf-fa-stop', () => {
  expect(keyFor('terminal', 'running', 'stop').icon).toBe('\uf04d');
});

test('no two keys collapse to the same glyph', () => {
  const icons = ALL_KEYS.map((k) => k.icon);
  expect(new Set(icons).size).toBe(new Set(ALL_KEYS.map((k) => k.action)).size);
});

// The Reconnect cap (main.ts) draws U+21BB idle and U+26A0 armed in this same
// header. The reboot key is its mirror U+21BA by deliberate choice — the two
// are told apart by separation, tooltip, and the armed form expanding back to
// a word — but a key that drew Reconnect's OWN glyph would be indefensible.
test('no lifecycle glyph is one of the Reconnect cap\'s own faces', () => {
  for (const k of ALL_KEYS) expect(['\u21bb', '\u26a0']).not.toContain(k.icon);
});

test('start fires on the first click and never arms', () => {
  const start = keyFor('stopped', 'stopped', 'start');
  expect(start.armLegend).toBeNull();
  expect(armReduce(IDLE, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('a destructive key arms on the first click and fires on the second', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown });
  expect(armed).toEqual({ state: { armed: 'shutdown' }, fire: null });
  expect(armReduce(armed.state, { type: 'click', key: shutdown })).toEqual({ state: { armed: null }, fire: 'shutdown' });
});

test('clicking a different key moves the arm rather than firing', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const reboot = keyFor('terminal', 'running', 'reboot');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: reboot })).toEqual({ state: { armed: 'reboot' }, fire: null });
});

test('start clears an arm without firing the armed action', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const start = keyFor('stopped', 'stopped', 'start');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('timeout, dismissal and a key-set change all disarm without firing', () => {
  const stop = keyFor('terminal', 'running', 'stop');
  const armed = armReduce(IDLE, { type: 'click', key: stop }).state;
  for (const type of ['timeout', 'dismiss', 'keysChanged']) {
    expect(armReduce(armed, { type })).toEqual({ state: { armed: null }, fire: null });
  }
});

test('chipFor reads the action in progress', () => {
  expect(chipFor('shutdown', 'running')).toEqual({ text: 'shutting down…', cls: 'chip-state', settled: false });
  expect(chipFor('reboot', 'running').text).toBe('rebooting…');
  expect(chipFor('stop', 'running').text).toBe('stopping…');
  expect(chipFor('start', 'running').text).toBe('starting…');
});

test('a done job clears the chip', () => {
  expect(chipFor('shutdown', 'done')).toBeNull();
});

test('error and interrupted settle red', () => {
  expect(chipFor('shutdown', 'error')).toEqual({ text: 'shutdown failed', cls: 'chip-error', settled: true });
  expect(chipFor('reboot', 'interrupted')).toEqual({ text: 'reboot failed', cls: 'chip-error', settled: true });
});

test('a job we lost track of settles red with its own wording', () => {
  expect(chipFor('stop', 'lost')).toEqual({ text: 'lost track of job', cls: 'chip-error', settled: true });
});
