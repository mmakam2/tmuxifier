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

const win = (id, index, name, active = false) => ({ id, index, name, active });

// One agent pane of a box's latest health sample, keyed in the map by pane id.
const e = (over = {}) => ({
  session: 'web', windowId: '@0', windowIndex: 1, windowName: 'api', paneIndex: 1,
  agent: 'claude', ts: 1, visible: true, focused: true, attached: false, ...over,
});
const AG = { '%1': e({ state: 'done' }) };
const open = { conn: { kind: 'open' } };
const chipOf = (agents, over = {}) => paneHeaderChip(box({ ...open, agents, ...over }));

test('the chip is the worst state among the agents visible in the pane\'s session', () => {
  const agents = {
    '%1': e({ state: 'working' }),
    // Worse, but on a window nobody is looking at: not in the chip.
    '%2': e({ paneIndex: 2, state: 'blocked', cause: 'permission', visible: false }),
    // Worse, but another session's agent.
    '%3': e({ session: 'other', state: 'blocked' }),
  };
  expect(chipOf(agents, { sessionName: 'main' })).toBeNull(); // nothing of 'main' at all
  expect(chipOf(agents, { sessionName: 'web' }))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
  expect(chipOf({ ...agents, '%1': e({ session: 'main', state: 'working' }) }, { sessionName: 'main' }))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
});

test('the chip folds the visible agents by precedence: blocked, done, working, idle', () => {
  const at = (...states) => Object.fromEntries(states.map((state, i) => [`%${i + 1}`, e({ paneIndex: i + 1, state })]));
  expect(chipOf(at('idle', 'working', 'done', 'blocked'))?.cls).toBe('chip-agent-blocked');
  expect(chipOf(at('idle', 'working', 'done'))?.cls).toBe('chip-agent-done');
  expect(chipOf(at('idle', 'working'))?.cls).toBe('chip-agent-working');
  expect(chipOf(at('idle'))?.cls).toBe('chip-agent-idle');
});

test('a blocked chip carries its cause; the sprite rides working only', () => {
  const blocked = chipOf({ '%1': e({ state: 'blocked', cause: 'permission' }), '%2': e({ paneIndex: 2, state: 'working' }) });
  expect(blocked).toEqual({ kind: 'agent', text: 'blocked · permission', cls: 'chip-agent-blocked' });
  expect(blocked).not.toHaveProperty('sprite');
  // A working agent beside a done one: the worst is done, so no sprite.
  expect(chipOf({ '%1': e({ state: 'done' }), '%2': e({ paneIndex: 2, state: 'working' }) }))
    .toEqual({ kind: 'agent', text: 'done', cls: 'chip-agent-done' });
  expect(chipOf({ '%1': e({ state: 'idle' }) })).toEqual({ kind: 'agent', text: 'idle', cls: 'chip-agent-idle' });
});

test('the cause belongs to the worst agent, not to another visible one', () => {
  // A working agent's own cause ('prompt') is never printed on a blocked chip.
  const chip = chipOf({ '%1': e({ state: 'working', cause: 'prompt' }), '%2': e({ paneIndex: 2, state: 'blocked', cause: 'question' }) });
  expect(chip?.text).toBe('blocked · question');
});

test('no visible agent with a state means no agent chip', () => {
  // Every agent is on another window.
  expect(chipOf({ '%1': e({ state: 'blocked', cause: 'permission', visible: false }) })).toBeNull();
  // Visible, but no marker yet: stateless, so nothing to say.
  expect(chipOf({ '%1': e() })).toBeNull();
  // A stateless visible agent does not hide behind a stateful one that is not visible.
  expect(chipOf({ '%1': e(), '%2': e({ paneIndex: 2, state: 'done', visible: false }) })).toBeNull();
  // Another session's agents only, no agents, no map.
  expect(chipOf({ '%1': e({ session: 'other', state: 'done' }) })).toBeNull();
  expect(chipOf({})).toBeNull();
  expect(paneHeaderChip(box(open))).toBeNull();
});

test('the chip reads the pane\'s own session, which defaults to web', () => {
  const agents = { '%1': e({ session: 'web-2', state: 'blocked', cause: 'permission' }), '%2': e({ session: 'web', state: 'done' }), '%3': e({ session: 'idler', state: 'idle' }) };
  expect(chipOf(agents, { sessionName: 'web-2' })).toEqual({ kind: 'agent', text: 'blocked · permission', cls: 'chip-agent-blocked' });
  expect(chipOf(agents, { sessionName: 'web' })?.text).toBe('done');
  expect(chipOf(agents, { sessionName: undefined })?.text).toBe('done');
  expect(chipOf(agents, { sessionName: 'idler' })?.text).toBe('idle');
  expect(chipOf(agents, { sessionName: 'nobody' })).toBeNull();
});

test('the header model carries the chip and the picker rows from the same pane map', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 2, windowList: [win('@0', 1, 'api', true), win('@1', 2, 'front')] }] };
  const agents = { '%1': e({ state: 'working' }), '%2': e({ windowId: '@1', windowIndex: 2, state: 'blocked', cause: 'question', visible: false }) };
  const m = paneHeaderModel(box({ ...open, status, sessionName: 'web', agents }));
  expect(m.chip).toMatchObject({ kind: 'agent', text: 'working' });
  expect(m.targets.options.find((r) => r.value === 'w:web:@1')).toMatchObject({ agent: 'blocked', agentCause: 'question' });
  expect(m.targets.options.find((r) => r.value === 's:web')).toMatchObject({ agent: 'blocked', agentCause: 'question' });
});

test('a window row carries the worst of its panes and a session row the worst of the session', () => {
  const status = { sessions: [
    { name: 'main', windows: 4, windowList: [win('@0', 1, 'api', true), win('@1', 2, 'front'), win('@2', 3, 'logs'), win('@3', 4, 'idle')] },
    { name: 'web', windows: 1, windowList: [win('@9', 1, 'zsh', true)] },
  ] };
  const agents = {
    '%1': e({ session: 'main', windowId: '@0', paneIndex: 1, state: 'blocked', cause: 'permission' }),
    '%2': e({ session: 'main', windowId: '@0', paneIndex: 2, state: 'working', visible: false }),
    '%3': e({ session: 'main', windowId: '@1', windowIndex: 2, state: 'working', visible: false }),
    // An agent with no marker yet: no state, so no chip for its window.
    '%4': e({ session: 'main', windowId: '@2', windowIndex: 3 }),
    // Another session's agent never reaches main's rows.
    '%5': e({ session: 'web', windowId: '@9', state: 'done' }),
  };
  const rows = Object.fromEntries(sessionTargets(status, 'main', agents).map((r) => [r.value, r]));
  expect(rows['s:main']).toMatchObject({ agent: 'blocked', agentCause: 'permission' });
  expect(rows['w:main:@0']).toMatchObject({ agent: 'blocked', agentCause: 'permission' });
  expect(rows['w:main:@1']).toMatchObject({ agent: 'working' });
  expect(rows['w:main:@1']).not.toHaveProperty('agentCause');
  // No stateful agent in the window: the chip fields are absent, not undefined.
  for (const v of ['w:main:@2', 'w:main:@3']) {
    expect(rows[v]).not.toHaveProperty('agent');
    expect(rows[v]).not.toHaveProperty('agentCause');
  }
  expect(rows['s:web']).toMatchObject({ agent: 'done' });
  expect(rows['w:web:@9']).toMatchObject({ agent: 'done' });
  expect(rows['s:web']).not.toHaveProperty('agentCause');
});

test('a session row folds in every window, visible or not', () => {
  // Unlike the header chip, the picker answers "what is every window doing".
  const status = { sessions: [{ name: 'main', windows: 2, windowList: [win('@0', 1, 'api', true), win('@1', 2, 'front')] }] };
  const agents = {
    '%1': e({ session: 'main', windowId: '@0', state: 'idle' }),
    '%2': e({ session: 'main', windowId: '@1', windowIndex: 2, state: 'blocked', cause: 'elicitation', visible: false }),
  };
  const rows = Object.fromEntries(sessionTargets(status, 'main', agents).map((r) => [r.value, r]));
  expect(rows['s:main']).toMatchObject({ agent: 'blocked', agentCause: 'elicitation' });
  expect(rows['w:main:@0']).toMatchObject({ agent: 'idle' });
  expect(rows['w:main:@1']).toMatchObject({ agent: 'blocked', agentCause: 'elicitation' });
});

test('a grouped session\'s shared window carries only that session\'s agents', () => {
  const status = { sessions: [
    { name: 'web', windows: 1, windowList: [win('@0', 1, 'zsh', true)] },
    { name: 'webclone', windows: 1, windowList: [win('@0', 1, 'zsh', true)] },
  ] };
  const agents = { '%1': e({ session: 'webclone', windowId: '@0', state: 'working' }) };
  const rows = Object.fromEntries(sessionTargets(status, 'web', agents).map((r) => [r.value, r]));
  expect(rows['w:webclone:@0']).toMatchObject({ agent: 'working' });
  expect(rows['s:webclone']).toMatchObject({ agent: 'working' });
  expect(rows['w:web:@0']).not.toHaveProperty('agent');
  expect(rows['s:web']).not.toHaveProperty('agent');
});

test('sessionTargetList passes the pane map through to its rows', () => {
  const status = { sessions: [{ name: 'web', windows: 1, windowList: [win('@1', 1, 'sh', true)] }, { name: 'web-2', windows: 0 }] };
  const agents = { '%1': e({ session: 'web-2', windowId: '@5', state: 'blocked', cause: 'permission' }) };
  const list = sessionTargetList(status, 'web', agents);
  expect(list.options.find((r) => r.value === 's:web-2')).toMatchObject({ agent: 'blocked', agentCause: 'permission' });
  expect(list.options.find((r) => r.value === 'w:web:@1')).not.toHaveProperty('agent');
});

test('retrying without an attempt count defaults to ×1', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'retrying' } }))?.text).toBe('reconnecting ×1');
});

// --- sessionTargets: the dropdown's pure, hierarchical option list ----------

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
