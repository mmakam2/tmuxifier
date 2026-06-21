import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadConfig, requiredConfigError } from './config.js';
import { createStore } from './store.js';
import { createStatusChecker } from './status.js';
import { createSessionManager } from './sessions.js';
import { sshRun } from './sshRun.js';
import { createBoxActions } from './boxActions.js';
import { createLocalShellActions } from './localShellActions.js';
import { buildServer } from './server.js';

process.on('unhandledRejection', (err) => { console.error('unhandledRejection:', err); });
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); });

const config = loadConfig();
config.configPath = path.resolve('config.json');
const cfgError = requiredConfigError(config);
if (cfgError) {
  console.error(cfgError);
  process.exit(1);
}

fs.mkdirSync(config.controlDir, { recursive: true });

const store = createStore({ dataDir: config.dataDir, sshConfigPath: config.sshConfigPath });
const sessions = createSessionManager({ hostKeyPolicy: config.hostKeyPolicy, graceSeconds: config.graceSeconds, sshConfigFile: config.sshConfigFile, controlDir: config.controlDir });
const boxActions = createBoxActions({
  run: (argv, opts) => sshRun(argv, opts),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
});
const statusChecker = createStatusChecker({
  run: (argv) => sshRun(argv),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
  // Let a status probe clean up a stale ControlMaster socket it detects, so a
  // box that lost multiplexing recovers without a manual remove/re-add.
  reapStaleMaster: (box) => boxActions.reapStaleMaster(box),
});
const localShellActions = createLocalShellActions();

const app = buildServer({ config, store, sessions, statusChecker, boxActions, localShellActions });

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
app.register(fastifyStatic, { root: dist, wildcard: false });
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/term')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});

const scheme = config.tlsCert && config.tlsKey ? 'https' : 'http';
app.listen({ host: config.bindAddress, port: config.port })
  .then(() => {
    console.log(`Tmuxifier listening on ${scheme}://${config.bindAddress}:${config.port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
