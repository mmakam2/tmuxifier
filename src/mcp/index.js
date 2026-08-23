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
import { createApiClient } from './apiClient.js';
import { createToolRegistry } from './tools.js';
import { resolveMcpConfig, TOKEN_FILE } from './config.js';

console.log = (...args) => console.error(...args); // stdout discipline, before anything can print

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function main({ env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  let serverConfig = null;
  try {
    serverConfig = loadConfig({}, { env: { ...readEnvFile(path.join(cwd, '.env')), ...env }, cwd });
  } catch (e) { log(`server config unavailable (${e?.message || e}); using defaults/env`); }
  const tokenFile = readJsonIfPresent(path.join(cwd, TOKEN_FILE));
  let cfg;
  try { cfg = resolveMcpConfig({ env, serverConfig, tokenFile }); }
  catch (e) { log(String(e?.message || e)); return 2; }

  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const client = createApiClient({ baseUrl: cfg.baseUrl, token: cfg.token, insecure: cfg.insecure });
  const registry = createToolRegistry({ client });
  const server = createMcpServer({ registry, serverInfo: { name: 'tmuxifier', version }, log });
  const parser = createLineParser();
  log(`tmuxifier mcp v${version} → ${cfg.baseUrl} (url from ${cfg.source.url}, token from ${cfg.source.token})`);

  await new Promise((resolve) => {
    server.connect({
      send: (m) => stdout.write(encode(m)),
      onMessage: (cb) => { stdin.on('data', (chunk) => { for (const entry of parser.push(chunk)) cb(entry); }); },
    });
    stdin.on('end', resolve);
    stdin.on('close', resolve);
  });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack || e}\n`); process.exitCode = 1; });
}
