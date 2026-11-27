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
// markers behind `paneMarksOf`, and an injected clock (`h.clock`). Shared by the hub test files.
//
// The hub reads agent state per PANE (`paneMarksOf`, `panesOf`). A test gives it either way:
//   - `h.paneMarks` ({ <box id>: { '%N': paneMark(session, state, cause) } }), handed to the hub
//     as is: for a test about panes (one pane ready, a sibling working).
//   - `h.marks`, the shorthand ({ <box id>: { <session>: mark(state, cause) } }, the default
//     { o: { main: working }, b: { main: working } }): every pane of that session carries the
//     mark. A session's panes are those the box's pane listing shows for it, plus every pane a
//     waiter of that session connected on (a waiter's pane is a pane of its session), or one
//     made-up pane id when there are none, so the session still runs an agent. This is the
//     common case, a session with one agent pane, and it keeps a test about sessions short.
//   `h.paneMarks[id]` wins over `h.marks[id]`; a box in neither reads as unreachable (null).
export const O = { boxId: 'o', session: 'main' };
export const B = { boxId: 'b', session: 'main' };
export const mark = (state, cause = state === 'ready' ? 'stop' : 'prompt') => ({ state, cause, ts: 1 });
export const paneMark = (session, state, cause = state === 'ready' ? 'stop' : 'prompt') => ({ session, state, cause, ts: 1 });
// One pane row of a box's listing (status.js PaneRow).
export const paneRow = (session, pane, cmd, extra = {}) => ({ session, windowId: '@1', pane, index: 0, active: true, zoomed: false, cmd, ...extra });

// hubOptions go to createAgentMailHub (holdMs, paneMarksOf, for instance). `world` replaces the
// bench's boxes and policies ({ boxes, policies: { <box id>: policy } }), for a suite whose boxes
// come from a fixture, and may give the boxes' listings, mutable as `h.panes` and `h.sessions`:
// `panes: { <box id>: PaneRow[] }` and/or `sessions: { <box id>: { name, paneCmd }[] }`. Either
// stands in for the other: with only session rows, each session lists one pane running its
// `paneCmd` (and each waiter's pane of it, running the same); with only pane rows, each session
// is listed with its active pane's command. A box with neither reads as unknown (`null`).
//
// `world.workers` ({ <box id>: raw worker record }) turns on agent workers: a real worker store
// in the same temp dir holding those records (`h.workerStore`) and a real starter (`h.workers`)
// whose `execCommand` runs the start script on a worker bench (`h.bench`, test/helpers/
// workerBench.js: a private tmux server and fixture home) under `sh`. A project with no `dir`
// gets `<bench home>/<project name>`, created here. The starter reads the same listings as
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
  h.paneMarks = {};
  h.sessions = world.sessions ?? {};
  h.panes = world.panes ?? {};
  // box id -> session -> Set of the panes its waiters connected on
  const noted = new Map();
  const note = (caller, pane) => {
    if (typeof caller?.boxId !== 'string' || typeof caller.session !== 'string' || typeof pane !== 'string' || !/^%\d+$/.test(pane)) return;
    if (!noted.has(caller.boxId)) noted.set(caller.boxId, new Map());
    const m = noted.get(caller.boxId);
    if (!m.has(caller.session)) m.set(caller.session, new Set());
    m.get(caller.session).add(pane);
  };
  const notedOf = (id, session) => [...(noted.get(id)?.get(session) ?? [])];
  // A made-up pane id per box and session, the same on every call.
  const madeUp = new Map();
  const madeUpPane = (id, session) => {
    const key = `${id}\0${session}`;
    if (!madeUp.has(key)) madeUp.set(key, `%${500 + madeUp.size}`);
    return madeUp.get(key);
  };
  h.panesOf = (id) => {
    if (Object.hasOwn(h.panes, id)) return h.panes[id];
    if (!Object.hasOwn(h.sessions, id) || !Array.isArray(h.sessions[id])) return null;
    const rows = [];
    for (const s of h.sessions[id]) {
      if (!s || typeof s.name !== 'string') continue;
      rows.push(paneRow(s.name, madeUpPane(id, s.name), s.paneCmd));
      for (const p of notedOf(id, s.name)) rows.push(paneRow(s.name, p, s.paneCmd, { active: false }));
    }
    return rows;
  };
  h.sessionsOf = (id) => {
    if (Object.hasOwn(h.sessions, id)) return h.sessions[id];
    if (!Object.hasOwn(h.panes, id) || !Array.isArray(h.panes[id])) return null;
    const out = new Map();
    for (const p of h.panes[id]) {
      if (!p || typeof p.session !== 'string') continue;
      if (!out.has(p.session) || p.active) out.set(p.session, { name: p.session, paneCmd: p.cmd });
    }
    return [...out.values()];
  };
  h.paneMarksOf = (id) => {
    if (Object.hasOwn(h.paneMarks, id)) return h.paneMarks[id];
    if (!Object.hasOwn(h.marks, id) || !h.marks[id]) return null;
    const listing = Object.hasOwn(h.panes, id) && Array.isArray(h.panes[id]) ? h.panes[id] : [];
    const out = Object.create(null);
    for (const session of Object.keys(h.marks[id])) {
      const m = h.marks[id][session];
      // A noted pane the listing shows in another session is not this session's.
      const listed = listing.filter((p) => p && p.session === session).map((p) => p.pane);
      const waited = notedOf(id, session).filter((pane) => !listing.some((p) => p && p.pane === pane && p.session !== session));
      const panes = [...new Set([...listed, ...waited])];
      for (const pane of panes.length ? panes : [madeUpPane(id, session)]) out[pane] = { session, ...m };
    }
    return out;
  };
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
      sessionsOf: h.sessionsOf,
      panesOf: h.panesOf,
      now: () => h.clock,
    });
  }
  // A hub over the same stores and world; tests that need a second one (a restart) call it again.
  // Every waiter's pane is noted as a pane of its session (see above).
  h.makeHub = (opts = {}) => {
    const hub = createAgentMailHub({
      store: h.store,
      policyStore: h.policyStore,
      listBoxes: async () => h.boxes.map((b) => ({ ...b })),
      paneMarksOf: h.paneMarksOf,
      panesOf: h.panesOf,
      now: () => h.clock,
      workers: h.workers,
      workerStore: h.workerStore,
      mailInstalled: (id) => h.installed.has(id),
      ...hubOptions,
      ...opts,
    });
    const waitMail = hub.waitMail;
    hub.waitMail = (caller, pane, signal) => { note(caller, pane); return waitMail(caller, pane, signal); };
    return hub;
  };
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
