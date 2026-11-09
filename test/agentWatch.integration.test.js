import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun, sshStream } from '../src/server/sshRun.js';
import { buildProbeArgv } from '../src/server/sshCommand.js';
import { createStatusChecker } from '../src/server/status.js';
import { createStatusPoller } from '../src/server/statusPoller.js';
import { createHealthHistory } from '../src/server/healthHistory.js';
import { createAgentWatch, WATCH_REMOTE } from '../src/server/agentWatch.js';

// The whole server-side chain against a real sshd, a real ControlMaster and
// the box's real login shell: watch stream -> light probe -> history edge.
// Nothing here is faked; the unit suites cover the scheduling with a clock.

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};

// The watch loops running on the fixture box: processes whose command line is
// the watch script AND whose HOME is this fixture's. The HOME check keeps the
// count blind to any other suite (or a live server) on this machine.
function boxLoops(home) {
  const pids = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes('.tmuxifier-agent') || !cmd.includes('first=1')) continue;
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (env.includes(`HOME=${home}`)) pids.push(Number(pid));
    } catch { /* raced an exit, or not ours to read */ }
  }
  return pids;
}

async function harness() {
  const lb = await setupLocalBox();
  const controlDir = path.join(lb.tmp, 'cm');
  fs.mkdirSync(controlDir, { mode: 0o700 });
  const opts = { sshConfigFile: lb.sshConfigFile, controlDir, controlPersist: 60 };
  const remote = (cmd) => sshRun(buildProbeArgv(lb.box, cmd, opts), { env: lb.env });
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const markDir = path.join(lb.home, '.tmuxifier-agent');
  fs.mkdirSync(markDir, { recursive: true });
  const writeMark = (state, cause, ts) => {
    fs.writeFileSync(path.join(markDir, `${lb.session}.tmp`), `${lb.session}:${state}:${ts}:${cause}\n`);
    fs.renameSync(path.join(markDir, `${lb.session}.tmp`), path.join(markDir, lb.session));
  };
  // A pane that reads as Claude Code to the probe: pane_current_command is
  // argv[0]'s basename (the same trick test/e2e/agentStates.spec.ts uses).
  const made = await remote(`tmux new-session -d -s ${lb.session} bash -c 'exec -a claude sleep 600'`);
  expect(made.code).toBe(0);
  const cmd = await remote(`tmux display-message -p -t '=${lb.session}:' '#{pane_current_command}'`);
  expect(cmd.stdout.trim()).toBe('claude');

  const history = createHealthHistory();
  const published = [];
  const statusChecker = createStatusChecker({ run: (argv) => sshRun(argv, { env: lb.env }), ...opts });
  let watch = null;
  const poller = createStatusPoller({
    store: { listBoxes: async () => [box] }, statusChecker, history,
    onCycle: (boxes, snap) => watch.sync(boxes, snap),
  });
  watch = createAgentWatch({
    spawnStream: (b, { onData }) => sshStream(buildProbeArgv(b, WATCH_REMOTE, opts), { env: lb.env, timeout: 0, onData }),
    onChange: async (id) => { if (await poller.refreshAgents(id)) published.push(id); },
  });
  teardown = async () => {
    watch.stopAll();
    try { await sshRun(['-F', lb.sshConfigFile, '-o', `ControlPath=${path.join(controlDir, '%C')}`, '-O', 'exit', lb.box.host], { env: lb.env }); } catch { /* no master */ }
    await lb.cleanup();
  };
  return { lb, box, history, published, poller, watch, writeMark };
}

test('a marker change on the box reaches the history in about a second, with no sweep in between', async () => {
  const { lb, history, published, poller, watch, writeMark } = await harness();
  writeMark('working', 'prompt', 100);
  await poller.pollOnce();                       // the one and only sweep
  expect(history.getSeries('b1').at(-1).agents[lb.session].state).toBe('working');
  expect(watch.size()).toBe(1);
  // The stream reports once at start; let that settle so the next edge is ours.
  expect(await until(() => published.length >= 1, 8000)).toBe(true);
  const base = published.length;

  const t0 = Date.now();
  writeMark('blocked', 'permission', 101);
  expect(await until(() => history.getEvents().events.some((e) => e.kind === 'agent-blocked'), 6000)).toBe(true);
  const took = Date.now() - t0;
  expect(took).toBeLessThan(5000);
  expect(published.length).toBeGreaterThan(base);
  const ev = history.getEvents().events.find((e) => e.kind === 'agent-blocked');
  expect(ev).toMatchObject({ boxId: 'b1', session: lb.session, cause: 'permission', agent: 'claude' });
  expect(poller.getSnapshot().b1.agentMarks[lb.session].state).toBe('blocked');
  expect(history.getSeries('b1')).toHaveLength(1); // still the sweep's single sample

  // And the turn finishing, the same way.
  writeMark('ready', 'stop', 102);
  expect(await until(() => history.getEvents().events.some((e) => e.kind === 'agent-input'), 6000)).toBe(true);
  expect(history.getSeries('b1').at(-1).agents[lb.session].state).toBe('done');
}, 60000);

test('exactly one loop runs on the box, and it exits once the stream is dropped', async () => {
  const { lb, poller, watch } = await harness();
  await poller.pollOnce();
  expect(await until(() => boxLoops(lb.home).length === 1, 8000)).toBe(true);
  // Further sweeps do not stack loops.
  await poller.pollOnce();
  await poller.pollOnce();
  await new Promise((r) => setTimeout(r, 1500));
  expect(boxLoops(lb.home)).toHaveLength(1);
  // The server goes away (or stops watching). With no PTY the loop gets no
  // hangup; it must end by itself at its next beat rather than stay resident.
  watch.stopAll();
  expect(await until(() => boxLoops(lb.home).length === 0, 30000)).toBe(true);
}, 60000);
