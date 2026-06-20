import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createStatusChecker } from './status.js';
import { createSessionManager } from './sessions.js';
import { sshRun } from './sshRun.js';
import { buildServer } from './server.js';

const config = loadConfig();
if (!config.passwordHash || !config.cookieSecret) {
  console.error('Helm is not configured. Run: npm run set-password');
  process.exit(1);
}

const store = createStore({ dataDir: config.dataDir, sshConfigPath: config.sshConfigPath });
const sessions = createSessionManager({ hostKeyPolicy: config.hostKeyPolicy, graceSeconds: config.graceSeconds, sshConfigFile: config.sshConfigFile });
const statusChecker = createStatusChecker({
  run: (argv) => sshRun(argv),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
});

const app = buildServer({ config, store, sessions, statusChecker });

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
app.register(fastifyStatic, { root: dist, wildcard: false });
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/term')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});

app.listen({ host: config.bindAddress, port: config.port })
  .then(() => {
    console.log(`Helm listening on http://${config.bindAddress}:${config.port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
