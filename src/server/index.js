import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadConfig, requiredConfigError } from './config.js';
import { createStore } from './store.js';
import { createStatusChecker } from './status.js';
import { createStatusPoller } from './statusPoller.js';
import { createSessionManager } from './sessions.js';
import { sshRun, sshRunStdin } from './sshRun.js';
import { createBoxActions } from './boxActions.js';
import { createFleetStore } from './fleetStore.js';
import { createFleetManager } from './fleet.js';
import { createHealthEventsStore } from './healthEventsStore.js';
import { createHealthHistory } from './healthHistory.js';
import { createLocalShellActions } from './localShellActions.js';
import { createBoxRemoval } from './boxRemoval.js';
import { buildServer } from './server.js';
import { createSecretBox } from './secretBox.js';
import { createProxmoxStore } from './proxmoxStore.js';
import { createNetboxStore } from './netboxStore.js';
import { createProvisionStore } from './provisionStore.js';
import { createProvisionManager } from './proxmoxProvision.js';
import { createProxmoxClient, inspectEndpoint } from './proxmoxApi.js';
import { createProxmoxInventory, mergeProxmoxStatus } from './proxmoxInventory.js';
import { createProxmoxLifecycleStore } from './proxmoxLifecycleStore.js';
import { createProxmoxLifecycleManager } from './proxmoxLifecycle.js';
import { createKnownHosts } from './knownHosts.js';
import { readDefaultPublicKey } from './defaultKey.js';
import os from 'node:os';

process.on('unhandledRejection', (err) => { console.error('unhandledRejection:', err); });
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); });

const config = loadConfig();
config.configPath = path.resolve('config.json');
const cfgError = requiredConfigError(config);
if (cfgError) {
  console.error(cfgError);
  process.exit(1);
}

fs.mkdirSync(config.controlDir, { recursive: true, mode: 0o700 });

const store = createStore({ dataDir: config.dataDir });
const sessions = createSessionManager({ hostKeyPolicy: config.hostKeyPolicy, graceSeconds: config.graceSeconds, sshConfigFile: config.sshConfigFile, controlDir: config.controlDir, controlPersist: config.controlPersist });
const boxActions = createBoxActions({
  run: (argv, opts) => sshRun(argv, opts),
  runStdin: (argv, input, opts) => sshRunStdin(argv, input, opts),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
  controlPersist: config.controlPersist,
});
const removeBox = createBoxRemoval({ store, sessions, boxActions });
const statusChecker = createStatusChecker({
  run: (argv) => sshRun(argv),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
  controlPersist: config.controlPersist,
  // Let a status probe clean up a stale ControlMaster socket it detects, so a
  // box that lost multiplexing recovers without a manual remove/re-add.
  reapStaleMaster: (box) => boxActions.reapStaleMaster(box),
  // Don't probe a box that has a live interactive session — the probe would
  // collide with the login on the shared ControlMaster socket. Instead report
  // its real state from the ControlMaster: alive = connected, absent = needs auth.
  hasLiveSession: (box) => sessions.hasLiveSession(box.id),
  masterAlive: (box) => boxActions.isMasterAlive(box),
});
const localShellActions = createLocalShellActions();
const fleetStore = createFleetStore({ dataDir: config.dataDir });
const fleetManager = createFleetManager({
  store,
  execCommand: (box, command, opts) => boxActions.execCommand(box, command, opts),
  load: () => fleetStore.load(),
  save: (jobs) => fleetStore.save(jobs),
  concurrency: config.fleetConcurrency,
  timeoutMs: config.fleetTimeoutMs,
  maxJobs: config.fleetMaxJobs,
  maxOutputBytes: config.fleetMaxOutputBytes,
  // Same mid-login guard as the status checker: don't fire a BatchMode exec
  // over a box's shared ControlMaster while its interactive login is live.
  hasLiveSession: (box) => sessions.hasLiveSession(box.id),
  masterAlive: (box) => boxActions.isMasterAlive(box),
});
const secretBox = createSecretBox(config.cookieSecret);
const proxmoxStore = createProxmoxStore({ dataDir: config.dataDir, secretBox });
const netboxStore = createNetboxStore({ dataDir: config.dataDir, secretBox });
const provisionStore = createProvisionStore({ dataDir: config.dataDir });
const makeProxmoxClient = (host) => createProxmoxClient({ host, timeoutMs: config.pveTimeoutMs });
// Cache the first successful read: deriving the key shells out to ssh-keygen
// and the host key doesn't change while the server runs. A null result is NOT
// cached, so adding a key later still gets picked up without a restart.
let cachedDefaultKey = null;
const defaultPublicKey = async () => {
  if (!cachedDefaultKey) cachedDefaultKey = await readDefaultPublicKey({ configuredPath: config.pveDefaultPubKeyPath, home: os.homedir() });
  return cachedDefaultKey;
};
const knownHosts = createKnownHosts();
const provisionManager = createProvisionManager({
  proxmoxStore,
  netboxStore,
  boxStore: store,
  makeClient: makeProxmoxClient,
  defaultPublicKey,
  knownHosts,
  load: () => provisionStore.load(),
  save: (jobs) => provisionStore.save(jobs),
  pollMs: config.pvePollMs,
  taskTimeoutMs: config.pveProvisionTimeoutMs,
  leaseTimeoutMs: config.pveLeaseTimeoutMs,
  maxJobs: config.pveMaxJobs,
});
// Inventory batches PVE guest lookups per host (one cluster/resources call
// covers every node) for both the status-poll enricher below and the
// manual-association browse routes, and best-effort auto-follows a container
// that migrated to a new node (guarded below once the lifecycle manager
// exists, so a drift write never races a job's own snapshot of the link).
// The lifecycle manager reuses the same removeBox instance wired above
// (Task 7) so a deprovision job's final unlink runs the exact same cleanup
// as a manual DELETE /api/boxes/:id — no second removal code path to keep
// in sync.
const proxmoxInventory = createProxmoxInventory({
  proxmoxStore, makeClient: makeProxmoxClient, boxStore: store,
  freshnessMs: config.statusPollMs * 2,
});
const lifecycleStore = createProxmoxLifecycleStore({ dataDir: config.dataDir });
const lifecycleManager = createProxmoxLifecycleManager({
  boxStore: store, proxmoxStore, inventory: proxmoxInventory,
  makeClient: makeProxmoxClient, removeLinkedBox: removeBox,
  netboxStore, knownHosts,
  load: () => lifecycleStore.load(), save: (jobs) => lifecycleStore.save(jobs),
  pollMs: config.pvePollMs,
  taskTimeoutMs: config.pveProvisionTimeoutMs,
  shutdownTimeoutMs: config.pveProvisionTimeoutMs,
  maxJobs: config.pveMaxJobs,
});
// A drift write (auto-follow) must not race a lifecycle job's own snapshot of
// the link it's operating on — the job would abort when resolveTarget sees a
// target it didn't expect. Guard is late-bound here since it needs the
// lifecycle manager instance constructed just above.
proxmoxInventory.setActiveJobGuard((boxId) => lifecycleManager.hasActiveJob(boxId));
// Health history rides on the status poll: each snapshot is projected into a
// rolling per-box series (in-memory) and an edge-triggered events log
// (persisted). In-app display only — nothing subscribes to onEvent in Phase 1.
const healthEventsStore = createHealthEventsStore({ dataDir: config.dataDir });
const history = createHealthHistory({
  maxSamples: config.healthHistoryMax,
  maxEvents: config.healthEventsMax,
  thresholds: {
    cpu: config.healthCpuWarnPct,
    mem: config.healthMemWarnPct,
    disk: config.healthDiskWarnPct,
    hysteresis: config.healthThresholdHysteresisPct,
  },
  load: () => healthEventsStore.load(),
  save: (events) => healthEventsStore.save(events),
});
// One server-side poll loop drives all status probing; the /api/status handler
// just serves its snapshot, so SSH volume no longer scales with open tab count.
const statusPoller = createStatusPoller({
  store,
  statusChecker,
  intervalMs: config.statusPollMs,
  concurrency: config.statusConcurrency,
  history,
  // Runs the PVE inventory refresh alongside each SSH probe cycle so linked
  // boxes get grey "Stopped" status instead of a red connection failure. See
  // mergeProxmoxStatus in proxmoxInventory.js for the merge truth table.
  statusEnricher: {
    collect: (boxes) => proxmoxInventory.refreshLinked(boxes),
    merge: (snapshot, boxes, records) => mergeProxmoxStatus(snapshot, boxes, records),
  },
});

const app = buildServer({ config, store, sessions, statusChecker, statusPoller, history, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, netboxStore, defaultPublicKey, removeBox, proxmoxInventory, lifecycleManager, knownHosts });

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
app.register(fastifyStatic, { root: dist, wildcard: false });
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/term')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});

const scheme = config.tlsCert && config.tlsKey ? 'https' : 'http';
app.listen({ host: config.bindAddress, port: config.port })
  .then(() => {
    statusPoller.start().catch((err) => console.error('status poll failed to start:', err));
    console.log(`Tmuxifier listening on ${scheme}://${config.bindAddress}:${config.port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
