import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { spawnMcp } from './helpers/mcpStdio.js';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { createPairingCodes } from '../src/server/pairingCodes.js';
import { createHealthHistory } from '../src/server/healthHistory.js';
import { createFleetManager } from '../src/server/fleet.js';
import { createFleetScriptsStore } from '../src/server/fleetScriptsStore.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { sshRun, sshRunStdin } from '../src/server/sshRun.js';
import { hashPassword } from '../src/server/auth.js';
import { enroll } from '../scripts/mcp-enroll.js';

let lb, app, dir, box, boxActions, mcp, deviceId, scriptId;

beforeAll(async () => {
  lb = await setupLocalBox();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-mcpint-'));
  const store = createStore({ dataDir: dir });
  box = await store.addBox({ host: lb.box.host, label: 'local', sessionName: lb.session });
  boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    hostKeyPolicy: 'accept-new', sshConfigFile: lb.sshConfigFile,
  });
  // A predictable pane in the box's configured session: cat echoes what we type.
  // The marker carries real SGR (red, then reset) so read_pane's SGR-stripping
  // is exercised end-to-end, not just unit-tested against a synthetic string.
  const mk = await boxActions.execCommand(box, `tmux new-session -d -s ${lb.session} 'printf "\\\\033[31mmcp-marker\\\\033[0m\\\\n"; exec cat'`);
  expect(mk.code).toBe(0);

  const fleetScriptsStore = createFleetScriptsStore({ dataDir: dir });
  scriptId = (await fleetScriptsStore.addScript({ name: 'Say hi', description: '', script: 'echo hi-from-script' })).id;
  const fleetManager = createFleetManager({ store, execCommand: (b, c, o) => boxActions.execCommand(b, c, o), timeoutMs: 12000 });
  const history = createHealthHistory();
  const snapshot = { [box.id]: { reachable: true, tmux: true, sessions: [{ name: lb.session, windows: 1, attached: false, paneCmd: 'cat' }], metrics: { osId: 'debian' } } };
  history.record(snapshot, [box]);
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {}, ensureSizedViewer() {} };
  app = buildServer({
    config, store, sessions, boxActions, fleetManager, fleetScriptsStore, history,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    statusPoller: { getSnapshot: () => snapshot, probeOne: async () => null },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore: createDeviceStore({ dataDir: dir }), pairingCodes: createPairingCodes(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const { code } = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: { cookie: `${c.name}=${c.value}` } })).json();
  const enrolled = await enroll({ baseUrl, code, name: 'mcp-test' });
  deviceId = enrolled.id;

  mcp = spawnMcp({ env: { TMUXIFIER_MCP_URL: baseUrl, TMUXIFIER_MCP_TOKEN: enrolled.token } });
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } });
  expect(init.result.protocolVersion).toBe('2025-06-18');
  mcp.notify('notifications/initialized');
}, 90_000);

afterAll(async () => {
  try {
    if (mcp) await mcp.close();
  } finally {
    try { if (app) await app.close(); }
    finally {
      try { if (boxActions && lb) await boxActions.execCommand(box, `tmux kill-session -t =${lb.session}`).catch(() => {}); }
      finally { if (lb) await lb.cleanup(); }
    }
  }
});

test('list_boxes shows the real box with its status and sample', async () => {
  const r = await mcp.call('list_boxes');
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toBe(`1 boxes\nlocal [${box.id}] ${lb.box.host} — up · tmux: ${lb.session}(1w) · os: debian`);
});

test('read_pane sees real tmux output and send_text round-trips through the pane', async () => {
  const before = await mcp.call('read_pane', { box_id: box.id, lines: 20 });
  expect(before.content[0].text).toMatch(new RegExp(`^pane local session ${lb.session} \\d+x\\d+ cursor \\d+,\\d+ alt:false mouse:false agent:gone\\n---\\n`));
  expect(before.content[0].text).toContain('mcp-marker');
  // The fixture pane emits real SGR (see beforeAll); read_pane must strip it.
  expect(before.content[0].text).not.toContain('\x1b');
  const sent = await mcp.call('send_text', { box_id: box.id, text: 'typed-via-mcp', submit: true });
  expect(sent.content[0].text).toBe('sent 13 chars + Enter');
  const deadline = Date.now() + 5000;
  let after;
  do {
    after = await mcp.call('read_pane', { box_id: box.id, lines: 20 });
    if (after.content[0].text.includes('typed-via-mcp')) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  expect(after.content[0].text).toContain('typed-via-mcp');
});

test('send_key refuses a key outside the server allowlist without a round trip', async () => {
  const r = await mcp.call('send_key', { box_id: box.id, key: 'F13' });
  expect(r).toEqual({ content: [{ type: 'text', text: 'key must be one of Enter, Escape, Tab, BSpace, Up, Down, Left, Right, C-c' }], isError: true });
});

test('run_fleet_command → wait_for_job → job_status over a real ssh command', async () => {
  const started = await mcp.call('run_fleet_command', { box_ids: [box.id], command: 'echo fleet-via-mcp' });
  const id = /^fleet (\S+) running/.exec(started.content[0].text)[1];
  const waited = await mcp.call('wait_for_job', { kind: 'fleet', id, timeout_sec: 30 });
  expect(waited.content[0].text).toMatch(new RegExp(`^fleet ${id} done 1/1 ok, 0 failed — echo fleet-via-mcp · .*\\ntimed_out: false\\nwaited_sec: \\d+$`));
  const status = await mcp.call('job_status', { kind: 'fleet', id });
  expect(status.content[0].text).toContain('--- local (ok, exit 0)\nfleet-via-mcp');
  const jobs = await mcp.call('list_jobs', { kind: 'fleet' });
  expect(jobs.content[0].text.split('\n')[0]).toMatch(new RegExp(`^fleet ${id} done`));
}, 60_000);

test('run_fleet_command by script_id sends the saved body under its frozen name', async () => {
  const started = await mcp.call('run_fleet_command', { box_ids: [box.id], script_id: scriptId });
  expect(started.content[0].text).toMatch(/^fleet \S+ running 0\/1 ok, 0 failed — Say hi/);
  const id = /^fleet (\S+) running/.exec(started.content[0].text)[1];
  const waited = await mcp.call('wait_for_job', { kind: 'fleet', id, timeout_sec: 30 });
  expect(waited.content[0].text).toMatch(/done 1\/1 ok/);
  expect((await mcp.call('job_status', { kind: 'fleet', id })).content[0].text).toContain('hi-from-script');
}, 60_000);

test('wait_for_agent returns immediately for the gone state and box_health lists the sample', async () => {
  const r = await mcp.call('wait_for_agent', { box_id: box.id, until: ['gone'], timeout_sec: 5 });
  // A slow first round trip could round waited_sec up to 1.
  expect(r.content[0].text).toMatch(/^state: gone\ntimed_out: false\nwaited_sec: [01]$/);
  const h = await mcp.call('box_health', { box_id: box.id });
  expect(h.content[0].text).toMatch(/^latest: up\nevents \(\d+\):/);
});

test('unwired subsystems relay the server\'s error as a readable line, never a crash', async () => {
  const jobs = await mcp.call('list_jobs');
  expect(jobs.content[0].text).toMatch(/fleet \S+ done/);
  const guests = await mcp.call('list_guests');
  // no proxmox store wired in this harness → the route's 502 is relayed as text
  expect(guests.isError).toBe(true);
  expect(guests.content[0].text).toMatch(/^502 \/api\/proxmox\/guests: /);
});

// Must remain the last test: it revokes the shared device token.
test('revoking the device turns every call into the re-enroll message', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}`, headers: { cookie: `${c.name}=${c.value}` } })).json()).toEqual({ removed: true });
  const r = await mcp.call('list_boxes');
  expect(r).toEqual({ content: [{ type: 'text', text: 'token invalid or revoked — re-run `npm run mcp-enroll`' }], isError: true });
});
