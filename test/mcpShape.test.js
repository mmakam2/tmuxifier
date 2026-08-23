import { test, expect } from 'vitest';
import { stripSgr, agentOf, boxLine, fleetOverview, paneText, healthText, fleetCounts, jobLine, jobDetail, scriptsText, presetsText, guestsText, errorText, clip } from '../src/mcp/shape.js';

const box = { id: 'b1', label: 'web', host: '192.168.1.10', sessionName: 'web' };

test('stripSgr removes SGR/CSI/OSC and trailing blank lines', () => {
  const raw = '\x1b[1;32m$ \x1b[0mls\x1b[K   \n\x1b]0;title\x07plain\n\n\n';
  expect(stripSgr(raw)).toBe('$ ls\nplain');
});

test('agentOf maps a missing agent to gone', () => {
  expect(agentOf({ agent: 'working' })).toBe('working');
  expect(agentOf({})).toBe('gone');
  expect(agentOf(null)).toBe('gone');
});

test('boxLine folds reachability, metrics, sessions and agent into one line', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 2, attached: true, paneCmd: 'claude' }, { name: 'other', windows: 1, attached: false, paneCmd: 'zsh' }], metrics: { osId: 'debian', osVer: '12' } };
  const sample = { up: true, cpuPct: 12, memPct: 40, diskPct: 70, agent: 'waiting' };
  expect(boxLine(box, status, sample)).toBe('web [b1] 192.168.1.10 — up · cpu 12% mem 40% disk 70% · tmux: web*(2w), other(1w) · agent: waiting · os: debian 12');
});

test('boxLine reports down boxes with their error and omits absent segments', () => {
  expect(boxLine(box, { reachable: false, error: 'connection refused' }, { up: false })).toBe('web [b1] 192.168.1.10 — down · connection refused');
  expect(boxLine(box, { reachable: false, needsAuth: true }, { up: false, needsAuth: true })).toBe('web [b1] 192.168.1.10 — needs-auth');
  expect(boxLine(box, undefined, undefined)).toBe('web [b1] 192.168.1.10 — unknown');
});

test('fleetOverview lists every box in order with a count header', () => {
  const out = fleetOverview([box, { id: 'b2', label: 'db', host: '192.168.1.11' }], { b1: { reachable: true } }, { b1: [{ up: true }] });
  expect(out.split('\n')).toEqual(['2 boxes', 'web [b1] 192.168.1.10 — up', 'db [b2] 192.168.1.11 — unknown']);
  expect(fleetOverview([], {}, {})).toBe('no boxes');
});

test('paneText carries geometry, flags, agent and stripped content', () => {
  const snap = { width: 80, height: 24, cursorX: 2, cursorY: 5, alt: true, mouse: true, content: '\x1b[31mhello\x1b[0m\n', agent: 'working', sessionName: 'web' };
  expect(paneText(snap, box)).toBe('pane web session web 80x24 cursor 2,5 alt:true mouse:true agent:working\n---\nhello');
});

test('healthText summarizes the latest sample and the box\'s events newest first', () => {
  const series = [{ t: 1000, up: true, cpuPct: 5 }, { t: 2000, up: true, cpuPct: 95, agent: 'working' }];
  const events = [
    { boxId: 'b1', t: 2000, kind: 'threshold', metric: 'cpu', value: 95 },
    { boxId: 'b2', t: 1500, kind: 'down' },
    { boxId: 'b1', t: 1000, kind: 'up' },
  ];
  const out = healthText('b1', series, events);
  expect(out.split('\n')).toEqual([
    'latest: up · cpu 95% · agent: working',
    'events (2):',
    `${new Date(2000).toISOString()} threshold cpu=95`,
    `${new Date(1000).toISOString()} up`,
  ]);
  expect(healthText('b1', [], [])).toBe('latest: no samples\nevents (0):');
  expect(healthText('b1')).toBe('latest: no samples\nevents (0):');
  expect(healthText('b1', [{ t: 1, up: true }], undefined)).toBe('latest: up\nevents (0):');
});

test('jobLine renders each kind, deriving fleet counts from targets when the raw job has none', () => {
  expect(jobLine('fleet', { id: 'j1', status: 'done', okCount: 2, targetCount: 3, errorCount: 1, command: 'uptime', createdAt: 'T' })).toBe('fleet j1 done 2/3 ok, 1 failed — uptime · T');
  expect(jobLine('fleet', { id: 'j1', status: 'running', command: 'uptime', createdAt: 'T', targets: [{ status: 'ok' }, { status: 'pending' }, { status: 'interrupted' }] })).toBe('fleet j1 running 1/3 ok, 1 failed — uptime · T');
  expect(fleetCounts({ targets: [] })).toEqual({ ok: 0, total: 0, failed: 0 });
  expect(jobLine('fleet', { id: 'j1', status: 'running', okCount: 0, targetCount: 1, errorCount: 0, scriptName: 'Upgrade', command: 'apt…', createdAt: 'T' })).toBe('fleet j1 running 0/1 ok, 0 failed — Upgrade · T');
  expect(jobLine('setup', { id: 's1', status: 'running', boxLabel: 'web', phase: 'seeding', createdAt: 'T' })).toBe('setup s1 running web phase seeding · T');
  expect(jobLine('provision', { id: 'p1', status: 'error', hostname: 'ct9', phase: 'create', createdAt: 'T' })).toBe('provision p1 error ct9 phase create · T');
  expect(jobLine('lifecycle', { id: 'l1', status: 'done', action: 'reboot', boxLabel: 'web', phase: 'done', createdAt: 'T' })).toBe('lifecycle l1 done reboot web phase done · T');
});

test('jobDetail tails fleet targets and job logs', () => {
  const fleet = { id: 'j1', status: 'done', okCount: 1, targetCount: 2, errorCount: 1, command: 'x', createdAt: 'T',
    targets: [{ label: 'web', status: 'ok', code: 0, stdout: 'abcdef', stderr: '' }, { label: 'db', status: 'error', code: 2, stdout: '', stderr: 'bad', error: 'exited 2' }] };
  expect(jobDetail('fleet', fleet, { tail: 3 })).toBe([
    'fleet j1 done 1/2 ok, 1 failed — x · T',
    '--- web (ok, exit 0)', '…def',
    '--- db (error, exit 2) exited 2', 'stderr:', 'bad',
  ].join('\n'));
  const setup = { id: 's1', status: 'needs-interactive', boxLabel: 'web', phase: 'running', needs: 'sudo', log: '0123456789', error: null, createdAt: 'T' };
  expect(jobDetail('setup', setup, { tail: 4 })).toBe('setup s1 needs-interactive web phase running · T\nneeds: sudo\nlog (last 4 chars):\n…6789');
});

test('scriptsText, presetsText and guestsText render their lists', () => {
  // Field names mirror fleetScriptsStore.js's real record shape (`script`,
  // `description`) — a mismatch here once hid a run_fleet_command bug that
  // only a full-stack run against the real store caught.
  expect(scriptsText([{ id: 'fs-1', name: 'Upgrade', description: 'apt', script: 'apt update\napt -y upgrade' }])).toBe('1 saved scripts\nfs-1 Upgrade — apt\n  apt update\n  apt -y upgrade');
  expect(scriptsText([])).toBe('no saved scripts');
  const presets = [{ id: 'pr1', name: 'small', hostId: 'h1', node: null, template: 'debian-12', cores: 2, memoryMiB: 2048, diskGiB: 8, net: { bridge: 'vmbr0', vlan: 20, ipMode: 'static', cidr: '192.168.1.50/24' } }];
  expect(presetsText(presets, [{ id: 'h1', name: 'pve', defaultNode: 'pve1' }])).toBe('pr1 small host=pve node=pve1 template=debian-12 2c 2048MiB disk 8GiB net vmbr0 vlan 20 static 192.168.1.50/24');
  expect(presetsText([], [])).toBe('no presets');
  expect(guestsText([{ boxId: 'b1', boxLabel: 'web', kind: 'lxc', vmid: 101, node: 'pve1', state: 'running', template: false, activeJob: null, error: null },
    { boxId: 'b2', boxLabel: 'vm', kind: 'qemu', vmid: 200, node: 'pve1', state: 'stopped', template: true, activeJob: { action: 'start' }, error: null }]))
    .toBe('web [b1] CT vmid 101 node pve1 state running\nvm [b2] VM vmid 200 node pve1 state stopped TEMPLATE · active job start');
  expect(guestsText([])).toBe('no linked guests');
});

test('errorText distinguishes unauthorized, unreachable and plain http errors', () => {
  expect(errorText({ kind: 'unauthorized', status: 401, path: '/api/boxes', message: 'unauthorized' })).toBe('token invalid or revoked — re-run `npm run mcp-enroll`');
  expect(errorText({ kind: 'unreachable', baseUrl: 'http://127.0.0.1:7437', message: 'ECONNREFUSED' })).toBe('cannot reach Tmuxifier at http://127.0.0.1:7437: ECONNREFUSED');
  expect(errorText({ kind: 'http', status: 409, path: '/api/boxes/b1/keys', message: 'pane has no mouse tracking' })).toBe('409 /api/boxes/b1/keys: pane has no mouse tracking');
  expect(errorText(new Error('plain'))).toBe('plain');
});

test('clip keeps the tail and marks it', () => {
  expect(clip('abcdef', 3)).toBe('…def');
  expect(clip('abc', 3)).toBe('abc');
});
