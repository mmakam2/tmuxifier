import { test, expect } from 'vitest';
import { paneHeaderModel, paneHeaderChip } from '../src/web/paneHeader.ts';

const box = (over = {}) => ({
  local: false, label: 'db-primary', user: 'ops', host: '192.168.1.10',
  status: { reachable: true, tmux: true }, state: 'terminal', ...over,
});

test('identity: label, user@host target, green dot for a reachable box', () => {
  const m = paneHeaderModel(box({ conn: { kind: 'open' } }));
  expect(m.title).toBe('db-primary');
  expect(m.target).toBe('ops@192.168.1.10');
  expect(m.dotClass).toBe('green');
  expect(m.chip).toBeNull();
});

test('a box without a user shows the bare host', () => {
  expect(paneHeaderModel(box({ user: undefined })).target).toBe('192.168.1.10');
});

test('local shell: fixed target text, dot tracks the connection', () => {
  const local = { local: true, label: 'Host Shell', state: 'terminal' };
  expect(paneHeaderModel({ ...local, conn: { kind: 'open' } }).target).toBe('this host');
  expect(paneHeaderModel({ ...local, conn: { kind: 'open' } }).dotClass).toBe('green');
  expect(paneHeaderModel({ ...local, conn: { kind: 'connecting' } }).dotClass).toBe('gray');
});

test('status delegation: unreachable box gets the red dot', () => {
  expect(paneHeaderModel(box({ status: { reachable: false } })).dotClass).toBe('red');
});

test('chip precedence: pane state beats connection beats agent', () => {
  expect(paneHeaderChip(box({ state: 'stopped', conn: { kind: 'retrying', attempt: 3 }, agent: 'waiting' })))
    .toEqual({ kind: 'state', text: 'stopped', cls: 'chip-state' });
  expect(paneHeaderChip(box({ state: 'setup' })))
    .toEqual({ kind: 'state', text: 'setting up', cls: 'chip-state' });
  expect(paneHeaderChip(box({ conn: { kind: 'retrying', attempt: 3 }, agent: 'waiting' })))
    .toEqual({ kind: 'conn', text: 'reconnecting ×3', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'connecting' } })))
    .toEqual({ kind: 'conn', text: 'connecting…', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'setup' } })))
    .toEqual({ kind: 'conn', text: 'setting up…', cls: 'chip-conn' });
});

test('agent chip only when the connection is quiet, never for unknown', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'working' })))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'waiting' })))
    .toEqual({ kind: 'agent', text: 'waiting', cls: 'chip-agent-waiting' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'unknown' }))).toBeNull();
  expect(paneHeaderChip(box({ conn: { kind: 'open' } }))).toBeNull();
});

test('retrying without an attempt count defaults to ×1', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'retrying' } }))?.text).toBe('reconnecting ×1');
});
