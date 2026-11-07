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
  expect(paneHeaderChip(box({ state: 'stopped', conn: { kind: 'retrying', attempt: 3 }, agents: AG })))
    .toEqual({ kind: 'state', text: 'stopped', cls: 'chip-state' });
  expect(paneHeaderChip(box({ state: 'setup' })))
    .toEqual({ kind: 'state', text: 'setting up', cls: 'chip-state' });
  expect(paneHeaderChip(box({ conn: { kind: 'retrying', attempt: 3 }, agents: AG })))
    .toEqual({ kind: 'conn', text: 'reconnecting ×3', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'connecting' } })))
    .toEqual({ kind: 'conn', text: 'connecting…', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'setup' } })))
    .toEqual({ kind: 'conn', text: 'setting up…', cls: 'chip-conn' });
});

const E = (state, cause) => ({ present: true, attached: false, state, cause, ts: 1 });
const AG = { web: E('done'), 'web-2': E('blocked', 'permission'), idler: E('idle') };

test('agent chip reads the pane\'s own session; working carries the sprite', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: 'web-2', agents: AG })))
    .toEqual({ kind: 'agent', text: 'blocked · permission', cls: 'chip-agent-blocked' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: 'web', agents: AG })))
    .toEqual({ kind: 'agent', text: 'done', cls: 'chip-agent-done' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: undefined, agents: AG })))
    .toEqual({ kind: 'agent', text: 'done', cls: 'chip-agent-done' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: 'idler', agents: AG })))
    .toEqual({ kind: 'agent', text: 'idle', cls: 'chip-agent-idle' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: 'web', agents: { web: E('working') } })))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
  // No entry (or no state) for the session -> no chip.
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, sessionName: 'other', agents: AG }))).toBeNull();
  expect(paneHeaderChip(box({ conn: { kind: 'open' } }))).toBeNull();
});

test('sessionTargets: session rows carry agent state, window rows do not', () => {
  const status = { sessions: [{ name: 'web', windows: 1, windowList: [{ id: '@1', index: 0, name: 'sh', active: true }] }, { name: 'web-2', windows: 0 }] };
  const rows = sessionTargets(status, 'web', AG);
  expect(rows.find((r) => r.value === 's:web')).toMatchObject({ agent: 'done' });
  expect(rows.find((r) => r.value === 's:web-2')).toMatchObject({ agent: 'blocked', agentCause: 'permission' });
  const win = rows.find((r) => r.kind === 'window');
  expect(win.agent).toBeUndefined();
  expect(win.agentCause).toBeUndefined();
  expect(sessionTargetList(status, 'web', AG).options.find((r) => r.value === 's:web-2').agent).toBe('blocked');
});

test('retrying without an attempt count defaults to ×1', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'retrying' } }))?.text).toBe('reconnecting ×1');
});

// --- sessionTargets: the dropdown's pure, hierarchical option list ----------

const win = (id, index, name, active = false) => ({ id, index, name, active });

test('sessionTargets lists sessions by name, each with its windows indented beneath it', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
    { name: 'proj2', windows: 1, windowList: [win('@5', 1, 'zsh')] },
  ] };
  expect(sessionTargets(status, 'web').map((t) => [t.kind, t.value, t.label])).toEqual([
    ['session', 's:proj2', 'proj2'],
    ['window', 'w:proj2:@5', `${WINDOW_INDENT}1: zsh`],
    ['session', 's:web', 'web'],
    ['window', 'w:web:@0', `${WINDOW_INDENT}1: zsh`],
    ['window', 'w:web:@1', `${WINDOW_INDENT}2: claude`],
  ]);
});

test('sessionTargets keeps one order whichever session the pane is on', () => {
  // The pane's own session used to be hoisted to the top, so every pane (and
  // every pane moved onto another session) showed the list in a different
  // order and the operator had to re-scan it to find the row they wanted.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'alpha', windows: 1 }, { name: 'web', windows: 1 }, { name: 'web-2', windows: 1 },
  ] };
  const order = ['s:alpha', 's:web', 's:web-2'];
  for (const current of ['alpha', 'web', 'web-2']) {
    expect(sessionTargets(status, current).map((t) => t.value)).toEqual(order);
  }
});

test('sessionTargets keeps the configured session offered, in name order, when tmux no longer lists it', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'alpha', windows: 1 }, { name: 'other', windows: 1 }] };
  expect(sessionTargets(status, 'gone').map((t) => t.value)).toEqual(['s:alpha', 's:gone', 's:other']);
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
  expect(t.find((x) => x.value === 'w:my session:@4').disabled).toBe(true);
});

test('sessionTargets leaves the CURRENT session\'s windows selectable whatever its name', () => {
  // A window inside the session the box is already attached to needs no PATCH,
  // so the session-name charset rule does not bind it.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'my session', windows: 1, windowList: [win('@4', 1, 'vim')] },
  ] };
  const t = sessionTargets(status, 'my session');
  expect(t.find((x) => x.value === 'w:my session:@4').disabled).toBeUndefined();
});

test('sessionTargets gives a shared window a DISTINCT value under each session', () => {
  // A grouped session (`tmux new-session -t web -s webclone`) shares its window
  // objects, so the same @id legitimately appears under two session names —
  // verified on tmux 3.5a, where `list-windows -a` reported `web:1:@0` and
  // `webclone:1:@0`. Two <option>s with one value would make the second row
  // unclickable in practice: resolving a pick by value hands back the first,
  // which acts on the wrong session (and can fire a session PATCH nobody asked
  // for). The session therefore rides in the value, not only in the row.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 1, windowList: [win('@0', 1, 'zsh', true)] },
    { name: 'webclone', windows: 1, windowList: [win('@0', 1, 'zsh')] },
  ] };
  const t = sessionTargets(status, 'web');
  const values = t.map((x) => x.value);
  expect(values).toEqual(['s:web', 'w:web:@0', 's:webclone', 'w:webclone:@0']);
  expect(new Set(values).size).toBe(values.length);
  // And each row still resolves to its own session, which is what the caller
  // sends to POST /api/boxes/:id/window.
  expect(t.find((x) => x.value === 'w:webclone:@0').session).toBe('webclone');
  expect(t.find((x) => x.value === 'w:webclone:@0').windowId).toBe('@0');
});

test('sessionTargetList selects the current session\'s active window', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
  ] };
  expect(sessionTargetList(status, 'web').value).toBe('w:web:@1');
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

test('phone mode renders no session control at all', () => {
  // The header row is the most contested real estate in the app, and the
  // operator's phone use is the Android app rather than the browser under
  // 720px. Dropping it also means the picker popup never has to open into a
  // 344px viewport (the Z Fold 6 cover screen).
  const withTargets = paneHeaderModel(box({ sessionName: 'web' }));
  expect(withTargets.targets).not.toBeNull();
  expect(paneHeaderModel(box({ sessionName: 'web', phone: true })).targets).toBeNull();
});

test('phone mode changes nothing else about the header', () => {
  const desktop = paneHeaderModel(box({ sessionName: 'web', conn: { kind: 'open' } }));
  const phone = paneHeaderModel(box({ sessionName: 'web', conn: { kind: 'open' }, phone: true }));
  expect(phone.title).toBe(desktop.title);
  expect(phone.target).toBe(desktop.target);
  expect(phone.dotClass).toBe(desktop.dotClass);
  expect(phone.chip).toEqual(desktop.chip);
});

test('the dropdown lists from the ATTACHED session as current', () => {
  const status = { sessions: [{ name: 'web' }, { name: 'dev-2' }] };
  const m = paneHeaderModel({ local: false, label: 'b', state: 'terminal', status, sessionName: 'dev-2' });
  expect(m.targets.options[0]).toMatchObject({ kind: 'session', session: 'dev-2' });
  expect(m.targets.value).toBe('s:dev-2');
});
