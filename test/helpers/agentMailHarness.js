import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailHub } from '../../src/server/agentMailHub.js';
import { createAgentMailStore } from '../../src/server/agentMailStore.js';
import { createAgentMailPolicyStore } from '../../src/server/agentMailPolicyStore.js';

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
  // A hub over the same stores and world; tests that need a second one (a restart) call it again.
  h.makeHub = (opts = {}) => createAgentMailHub({
    store: h.store,
    policyStore: h.policyStore,
    listBoxes: async () => h.boxes.map((b) => ({ ...b })),
    marksOf: (id) => (Object.hasOwn(h.marks, id) ? h.marks[id] : null),
    sessionsOf: (id) => (Object.hasOwn(h.sessions, id) ? h.sessions[id] : null),
    now: () => h.clock,
    ...hubOptions,
    ...opts,
  });
  const policies = world.policies ?? { o: { send: true, sendTo: ['b'] }, b: { receive: true, receiveFrom: ['o'] } };
  for (const [id, policy] of Object.entries(policies)) await h.setPolicy(id, policy);
  h.hub = h.makeHub();
  h.cleanup = async () => {
    await h.store.whenIdle();
    fs.rmSync(h.dir, { recursive: true, force: true });
  };
  return h;
}
