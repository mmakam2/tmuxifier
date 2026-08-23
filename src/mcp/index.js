// Entry point for the stdio MCP server: `npm run mcp` / `claude mcp add
// tmuxifier -- node /path/to/tmuxifier/src/mcp/index.js`. stdout is the
// protocol stream; every diagnostic goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { readEnvFile } from '../server/envFile.js';
import { createLineParser, encode } from './jsonrpc.js';
import { createMcpServer } from './mcpServer.js';
import { createApiClient, trustBundle } from './apiClient.js';
import { createToolRegistry } from './tools.js';
import { resolveMcpConfig, TOKEN_FILE } from './config.js';

console.log = (...args) => console.error(...args); // stdout discipline, before anything can print

// An MCP client starts this process with ITS own working directory — Claude
// Code's is wherever the user launched it — so the repo's own files must be
// found from the module, never from process.cwd(). Overridable for tests.
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function main({ env: envIn = process.env, cwd = REPO_ROOT, stdin = process.stdin, stdout = process.stdout, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  // One env map for both resolvers: loadConfig folds in <cwd>/.env itself, so
  // passing raw process.env to resolveMcpConfig left the TMUXIFIER_MCP_* knobs
  // documented in .env.example working for the enroll CLI but not for this one.
  const env = { ...readEnvFile(path.join(cwd, '.env')), ...envIn };
  let serverConfig = null;
  try {
    serverConfig = loadConfig({}, { env, cwd });
  } catch (e) { log(`server config unavailable (${e?.message || e}); using defaults/env`); }
  const tokenFile = readJsonIfPresent(path.join(cwd, TOKEN_FILE));
  let cfg;
  try { cfg = resolveMcpConfig({ env, serverConfig, tokenFile }); }
  catch (e) { log(String(e?.message || e)); return 2; }

  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  // A config-derived https URL is this repo's own server, so trust exactly the
  // certificate it is configured to serve. An unreadable file is a log line,
  // not a refusal — the system trust store may well already cover it.
  let ca;
  if (cfg.caFile) {
    try { ca = trustBundle(fs.readFileSync(path.resolve(cwd, cfg.caFile), 'utf8')); }
    catch (e) { log(`TLS certificate ${cfg.caFile} unreadable (${e?.message || e}); falling back to the system trust store`); }
  }
  const client = createApiClient({ baseUrl: cfg.baseUrl, token: cfg.token, insecure: cfg.insecure, ca });
  const registry = createToolRegistry({ client });
  const server = createMcpServer({ registry, serverInfo: { name: 'tmuxifier', version }, log });
  const parser = createLineParser();
  log(`tmuxifier mcp v${version} → ${cfg.baseUrl} (url from ${cfg.source.url}, token from ${cfg.source.token})`);

  await new Promise((resolve) => {
    server.connect({
      send: (m) => stdout.write(encode(m)),
      onMessage: (cb) => { stdin.on('data', (chunk) => { for (const entry of parser.push(chunk)) cb(entry); }); },
    });
    // A client that closes its read end (or crashes) turns the next stdout
    // write into an EPIPE. Without a handler, an 'error' event with nobody
    // listening throws and crashes the process; treat a dead stdout exactly
    // like stdin ending — there is no one left to talk to. Resolving alone
    // is not enough to let the process exit: stdin's own 'data' listener
    // (registered above by onMessage) still holds the event loop open, since
    // a client that only closed its read end hasn't closed our stdin — so
    // destroy it too, releasing the handle that would otherwise keep the
    // process alive forever.
    stdout.on('error', (e) => { log(`stdout closed (${e?.code || e?.message || e}); exiting`); stdin.destroy(); resolve(); });
    stdin.on('end', resolve);
    stdin.on('close', resolve);
  });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack || e}\n`); process.exitCode = 1; });
}
