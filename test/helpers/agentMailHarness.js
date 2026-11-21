import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailHub } from '../../src/server/agentMailHub.js';
import { createAgentMailStore } from '../../src/server/agentMailStore.js';
import { createAgentMailPolicyStore } from '../../src/server/agentMailPolicyStore.js';
import { createAgentWorkerStore } from '../../src/server/agentWorkerStore.js';
import { createAgentWorkers } from '../../src/server/agentWorkers.js';
import { createWorkerBench } from './workerBench.js';

// The agent-mail hub's test bench: real mail and policy stores on a temp dir, two boxes
// (`orders` = o, `billing` = b, both on session `main`), the policy o -> b, mutable agent
// markers behind `marksOf`, and an injected clock (`h.clock`). Shared by the hub test files.

export const O = { boxId: 'o', session: 'main' };
export const B = { boxId: 'b', session: 'main' };
export const mark = (state, cause = state === 'ready' ? 'stop' : 'prompt') => ({ state, cause, ts: 1 });

// hubOptions go to createAgentMailHub (holdMs, marksOf, for instance). `world` replaces the bench's
// boxes and policies ({ boxes, policies: { <box id>: policy } }), for a suite whose boxes come
// from a fixture, and may give the boxes' session listings (`sessions: { <box id>: { name,
// paneCmd }[] }`, mutable as `h.sessions`); a box with no listing reads as unknown (`null`).
//
// `world.workers` ({ <box id>: raw worker record }) turns on agent workers: a real worker store
// in the same temp dir holding those records (`h.workerStore`) and a real starter (`h.workers`)
// whose `execCommand` runs the start script on a worker bench (`h.bench`, test/helpers/
// workerBench.js: a private tmux server and fixture home) under `sh`. A project with no `dir`
// gets `<bench home>/<project name>`, created here. The starter reads the same `h.sessions` as
// the hub, so a test that starts a worker must give the box a listing (possibly `[]`).
// `world.installed` (box ids, mutable as the Set `h.installed`) is what `mailInstalled` reports.
// Call h.cleanup() in afterEach.
export async function createMailHarness(hubOptions = {}, world = {}) {
  const h = {};
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-'));
  h.clock = 1_000_000;
  h.boxes = world.boxes ?? [
    { id: 'o', label: 'orders', sessionName: 'main' },
    { id: 'b', label: 'billing', sessionName: 'main' },
  ];
  h.marks = { o: { main: mark('working') }, b: { main: mark('working') } };
  h.sessions = world.sessions ?? {};
  h.store = createAgentMailStore({ dataDir: h.dir, now: () => h.clock });
  await h.store.load();
  h.policyStore = createAgentMailPolicyStore({ dataDir: h.dir });
  h.setPolicy = (id, raw) => h.policyStore.set(id, raw, { knownIds: new Set(h.boxes.map((b) => b.id)) });
  h.names = (id) => h.boxes.find((b) => b.id === id)?.label;
  h.installed = new Set(world.installed ?? []);
  h.workers = null;
  h.workerStore = null;
  h.bench = null;
  if (world.workers) {
    h.bench = createWorkerBench({ defaultShell: 'bash' });
    h.workerStore = createAgentWorkerStore({ dataDir: h.dir });
    for (const [id, raw] of Object.entries(world.workers)) {
      const projects = (raw.projects ?? []).map((p) => {
        if (p.dir !== undefined) return p;
        const dir = path.join(h.bench.home, p.name);
        fs.mkdirSync(dir, { recursive: true });
        return { ...p, dir };
      });
      await h.workerStore.set(id, { ...raw, projects });
    }
    h.workers = createAgentWorkers({
      execCommand: async (box, remote) => ({ ...h.bench.run('sh', remote), stderr: '' }),
      workerStore: h.workerStore,
      setupRunning: () => false,
      sessionsOf: (id) => (Object.hasOwn(h.sessions, id) ? h.sessions[id] : null),
      now: () => h.clock,
    });
  }
  // A hub over the same stores and world; tests that need a second one (a restart) call it again.
  h.makeHub = (opts = {}) => createAgentMailHub({
    store: h.store,
    policyStore: h.policyStore,
    listBoxes: async () => h.boxes.map((b) => ({ ...b })),
    marksOf: (id) => (Object.hasOwn(h.marks, id) ? h.marks[id] : null),
    sessionsOf: (id) => (Object.hasOwn(h.sessions, id) ? h.sessions[id] : null),
    now: () => h.clock,
    workers: h.workers,
    workerStore: h.workerStore,
    mailInstalled: (id) => h.installed.has(id),
    ...hubOptions,
    ...opts,
  });
  const policies = world.policies ?? { o: { send: true, sendTo: ['b'] }, b: { receive: true, receiveFrom: ['o'] } };
  for (const [id, policy] of Object.entries(policies)) await h.setPolicy(id, policy);
  h.hub = h.makeHub();
  h.cleanup = async () => {
    await h.store.whenIdle();
    if (h.bench) await h.bench.cleanup();
    fs.rmSync(h.dir, { recursive: true, force: true });
  };
  return h;
}
