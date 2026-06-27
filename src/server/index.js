import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadConfig, requiredConfigError } from './config.js';
import { createStore } from './store.js';
import { createStatusChecker } from './status.js';
import { createStatusPoller } from './statusPoller.js';
import { createSessionManager } from './sessions.js';
import { sshRun } from './sshRun.js';
import { createBoxActions } from './boxActions.js';
import { createFleetStore } from './fleetStore.js';
import { createFleetManager } from './fleet.js';
import { createLocalShellActions } from './localShellActions.js';
import { buildServer } from './server.js';
import { createSecretBox } from './secretBox.js';
import { createProxmoxStore } from './proxmoxStore.js';
import { createProvisionStore } from './provisionStore.js';
import { createProvisionManager } from './proxmoxProvision.js';
import { createProxmoxClient, inspectEndpoint } from './proxmoxApi.js';
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
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
  controlPersist: config.controlPersist,
});
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
});
const secretBox = createSecretBox(config.cookieSecret);
const proxmoxStore = createProxmoxStore({ dataDir: config.dataDir, secretBox });
const provisionStore = createProvisionStore({ dataDir: config.dataDir });
const makeProxmoxClient = (host) => createProxmoxClient({ host, timeoutMs: config.pveTimeoutMs });
const defaultPublicKey = () => readDefaultPublicKey({ configuredPath: config.pveDefaultPubKeyPath, home: os.homedir() });
const provisionManager = createProvisionManager({
  proxmoxStore,
  boxStore: store,
  makeClient: makeProxmoxClient,
  defaultPublicKey,
  load: () => provisionStore.load(),
  save: (jobs) => provisionStore.save(jobs),
  pollMs: config.pvePollMs,
  taskTimeoutMs: config.pveProvisionTimeoutMs,
  leaseTimeoutMs: config.pveLeaseTimeoutMs,
  maxJobs: config.pveMaxJobs,
});
// One server-side poll loop drives all status probing; the /api/status handler
// just serves its snapshot, so SSH volume no longer scales with open tab count.
const statusPoller = createStatusPoller({
  store,
  statusChecker,
  intervalMs: config.statusPollMs,
  concurrency: config.statusConcurrency,
});

const app = buildServer({ config, store, sessions, statusChecker, statusPoller, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, defaultPublicKey });

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
