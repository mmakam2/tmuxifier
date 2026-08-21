import { test, expect } from 'vitest';
import { paneHeaderModel, paneHeaderChip, sessionTargets, sessionTargetList, WINDOW_INDENT, isSwitchableSession, SESSION_NAME_RE } from '../src/web/paneHeader.ts';

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

// --- sessionTargets: the dropdown's pure, hierarchical option list ----------

const win = (id, index, name, active = false) => ({ id, index, name, active });

test('sessionTargets lists the configured session first, its windows indented beneath it', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'proj2', windows: 1, windowList: [win('@5', 1, 'zsh')] },
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
  ] };
  expect(sessionTargets(status, 'web').map((t) => [t.kind, t.value, t.label])).toEqual([
    ['session', 's:web', 'web'],
    ['window', 'w:@0', `${WINDOW_INDENT}1: zsh`],
    ['window', 'w:@1', `${WINDOW_INDENT}2: claude`],
    ['session', 's:proj2', 'proj2'],
    ['window', 'w:@5', `${WINDOW_INDENT}1: zsh`],
  ]);
});

test('sessionTargets keeps the configured session offered when tmux no longer lists it', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'other', windows: 1 }] };
  expect(sessionTargets(status, 'gone').map((t) => t.value)).toEqual(['s:gone', 's:other']);
});

test('sessionTargets with no snapshot still offers the configured session, defaulting to web', () => {
  expect(sessionTargets(undefined, 'main').map((t) => t.value)).toEqual(['s:main']);
  expect(sessionTargets(undefined, undefined).map((t) => t.value)).toEqual(['s:web']);
});

test('sessionTargets drops empty session names from the live list', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: '', windows: 1 }, { name: 'a', windows: 1 }] };
  expect(sessionTargets(status, 'a').map((t) => t.value)).toEqual(['s:a']);
});

test('sessionTargets names an unnamed window rather than rendering a bare index', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1, windowList: [win('@0', 3, '')] }] };
  expect(sessionTargets(status, 'web')[1].label).toBe(`${WINDOW_INDENT}3: window`);
});

test('sessionTargets disables an unswitchable session AND its windows', () => {
  // store.js's sanitizeSession would rewrite a PATCHed 'my session' and the
  // reattach would create a fresh mangled-name session instead of attaching.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 1 },
    { name: 'my session', windows: 1, windowList: [win('@4', 1, 'vim')] },
  ] };
  const t = sessionTargets(status, 'web');
  expect(t.find((x) => x.value === 's:my session').disabled).toBe(true);
  expect(t.find((x) => x.value === 'w:@4').disabled).toBe(true);
});

test('sessionTargets leaves the CURRENT session\'s windows selectable whatever its name', () => {
  // A window inside the session the box is already attached to needs no PATCH,
  // so the session-name charset rule does not bind it.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'my session', windows: 1, windowList: [win('@4', 1, 'vim')] },
  ] };
  const t = sessionTargets(status, 'my session');
  expect(t.find((x) => x.value === 'w:@4').disabled).toBeUndefined();
});

test('sessionTargetList selects the current session\'s active window', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
  ] };
  expect(sessionTargetList(status, 'web').value).toBe('w:@1');
});

test('sessionTargetList falls back to the session row when no active window is known', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 2 }] };
  expect(sessionTargetList(status, 'web').value).toBe('s:web');
  expect(sessionTargetList(undefined, 'web').value).toBe('s:web');
});

test('paneHeaderModel exposes the target list only for a live terminal pane on a real box', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1 }] };
  expect(paneHeaderModel(box({ status, sessionName: 'web' })).targets.options.length).toBe(1);
  expect(paneHeaderModel(box({ status, state: 'stopped' })).targets).toBeNull();
  expect(paneHeaderModel({ local: true, label: 'Host Shell', state: 'terminal' }).targets).toBeNull();
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
