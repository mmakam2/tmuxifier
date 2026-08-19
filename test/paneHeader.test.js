import { test, expect } from 'vitest';
import { paneHeaderModel, paneHeaderChip, sessionOptions, isSwitchableSession, SESSION_NAME_RE } from '../src/web/paneHeader.ts';

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

test('agent chip only when the connection is quiet, and only for a hook-sourced state', () => {
  // working carries the Clawd sprite flag; waiting deliberately stays plain.
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'working' })))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'waiting' })))
    .toEqual({ kind: 'agent', text: 'waiting', cls: 'chip-agent-waiting' });
  // No marker → no `agent` on the sample → no chip (the un-hooked-box cue).
  expect(paneHeaderChip(box({ conn: { kind: 'open' } }))).toBeNull();
});

test('retrying without an attempt count defaults to ×1', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'retrying' } }))?.text).toBe('reconnecting ×1');
});

// --- sessionOptions: the session dropdown's pure option list ---------------

test('sessionOptions merges live sessions with the configured one, no duplicate', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1 }, { name: 'proj2', windows: 2 }] };
  expect(sessionOptions(status, 'web')).toEqual(['web', 'proj2']);
});

test('sessionOptions keeps the configured session listed even when tmux no longer has it', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'other', windows: 1 }] };
  expect(sessionOptions(status, 'gone')).toEqual(['gone', 'other']);
});

test('sessionOptions with no snapshot still offers the configured session', () => {
  expect(sessionOptions(undefined, 'main')).toEqual(['main']);
});

test('sessionOptions defaults a missing configured name to web (the store default)', () => {
  expect(sessionOptions(undefined, undefined)).toEqual(['web']);
});

test('sessionOptions drops empty names from the live list', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: '', windows: 1 }, { name: 'a', windows: 1 }] };
  expect(sessionOptions(status, 'a')).toEqual(['a']);
});

test('the client session-name rule is locked to the server route\'s rule', async () => {
  // Three surfaces enforce/describe one rule (the create route, the client-side
  // pre-check, the dropdown's switchable gate). The provisionTools.ts pattern:
  // one locking test so the copies cannot drift apart silently.
  const { SESSION_NAME_RE: serverRe } = await import('../src/server/sshCommand.js');
  expect(serverRe).toBeInstanceOf(RegExp); // guard: String(undefined) === String(undefined) must not pass
  expect(String(SESSION_NAME_RE)).toBe(String(serverRe));
});

test('isSwitchableSession accepts exactly what the switch path can round-trip', () => {
  expect(isSwitchableSession('proj-2_x')).toBe(true);
  // sanitizeSession would silently rewrite these on PATCH, so switching to
  // them would create a fresh mangled-name session instead of attaching.
  expect(isSwitchableSession('my proj')).toBe(false);
  expect(isSwitchableSession('box@home')).toBe(false);
  expect(isSwitchableSession('a'.repeat(65))).toBe(false);
  expect(isSwitchableSession('')).toBe(false);
});
