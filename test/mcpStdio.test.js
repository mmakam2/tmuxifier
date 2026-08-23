import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnMcp } from './helpers/mcpStdio.js';
import { main, REPO_ROOT } from '../src/mcp/index.js';

const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-mcp-'));

// Drive the exported entry point in-process: cwd, env, stdin and stdout are all
// injected, so this observes exactly which files a given cwd resolves to.
// Same, but kept alive: hands the body a live rpc() so a tool call actually
// goes over the wire the resolved config built.
async function withMain({ cwd, env = {} }, fn) {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const logs = [];
  const done = main({ cwd, env, stdin, stdout, log: (m) => logs.push(m) });
  const waiters = new Map();
  let buf = '';
  stdout.on('data', (c) => {
    buf += c;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) { const msg = JSON.parse(line); const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const mid = ++id; waiters.set(mid, resolve);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
  try { return await fn({ rpc, logs }); } finally { stdin.end(); await done; }
}

async function runMain({ cwd, env = {} }) {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const logs = []; let out = '';
  stdout.on('data', (c) => { out += c; });
  const code = main({ cwd, env, stdin, stdout, log: (m) => logs.push(m) });
  stdin.end();
  return { code: await code, log: logs.join('\n'), out };
}

// Drive the real entry point as a child over pipes: the transport, the stdout
// discipline and the exit path are exactly what a client sees.
test('the entry point speaks MCP over stdio against the configured URL and keeps stdout clean', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    if (req.url === '/api/boxes') return res.end('[]');
    if (req.url === '/api/status') return res.end('{}');
    if (req.url === '/api/health/series') return res.end('{}');
    res.statusCode = 404; res.end('{"error":"not found"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const mcp = spawnMcp({ env: { TMUXIFIER_MCP_URL: `http://127.0.0.1:${srv.address().port}`, TMUXIFIER_MCP_TOKEN: 'tok' } });
  try {
    const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo.name).toBe('tmuxifier');
    expect(init.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    mcp.notify('notifications/initialized');
    const list = await mcp.rpc('tools/list');
    expect(list.result.tools.map((t) => t.name)).toContain('wait_for_agent');
    const boxes = await mcp.rpc('tools/call', { name: 'list_boxes', arguments: {} });
    expect(boxes.result).toEqual({ content: [{ type: 'text', text: 'no boxes' }] });
    expect(mcp.stderr()).toMatch(/tmuxifier mcp v\d+\.\d+\.\d+ → http:\/\/127\.0\.0\.1:\d+ \(url from env, token from env\)/);
  } finally {
    await mcp.close();
    await new Promise((r) => srv.close(r));
  }
  expect(mcp.child.exitCode).toBe(0);
});

// A client that closes its read end (or crashes) must not leave the server
// hung or crash it on the next write's EPIPE — it should exit clean, like a
// closed stdin.
test('a closed stdout makes the process exit cleanly instead of crashing on EPIPE', async () => {
  const mcp = spawnMcp({ env: { TMUXIFIER_MCP_URL: 'http://127.0.0.1:1', TMUXIFIER_MCP_TOKEN: 'tok' } });
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  mcp.child.stdout.destroy();
  mcp.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) + '\n');
  const code = await new Promise((r) => mcp.child.once('exit', r));
  expect(code).toBe(0);
  expect(mcp.stderr()).toContain('stdout closed');
});

// Driven in-process rather than through spawnMcp: a spawned child takes the
// CLI branch, which calls main() with no arguments, so its cwd defaults to
// REPO_ROOT and it reads THIS repo's .env and data/mcp-token.json — the temp
// cwd would be decorative and the test would go red the day the repo is
// actually enrolled. Injecting the cwd is the only hermetic way to describe a
// host that has no token.
test('without a token it explains itself on stderr, exits 2, and writes nothing to the protocol stream', async () => {
  const cwd = await tmpdir(); // neither .env nor data/mcp-token.json in it
  const { code, log, out } = await runMain({ cwd });
  expect(code).toBe(2);
  expect(log).toMatch(/no MCP token: set TMUXIFIER_MCP_TOKEN or run `npm run mcp-enroll`/);
  expect(out).toBe('');
});

// An MCP client spawns this server with its OWN working directory, which is
// almost never the repo: everything the process needs must resolve from the
// module, and the env must still win wherever it is started from.
test('a client that spawns the server from a stranger\'s directory still gets a working server', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    res.end(req.url === '/api/boxes' ? '[]' : '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cwd = await tmpdir();
  const mcp = spawnMcp({ cwd, env: { TMUXIFIER_MCP_URL: `http://127.0.0.1:${srv.address().port}`, TMUXIFIER_MCP_TOKEN: 'tok' } });
  try {
    const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo.name).toBe('tmuxifier');
    expect(await mcp.call('list_boxes')).toEqual({ content: [{ type: 'text', text: 'no boxes' }] });
  } finally {
    await mcp.close();
    await new Promise((r) => srv.close(r));
  }
  expect(mcp.child.exitCode).toBe(0);
});

// Asserting REPO_ROOT from inside vitest alone would prove nothing: the test
// runner's own cwd IS the repo, so `process.cwd()` would satisfy it. Read it
// out of a process started somewhere else entirely.
test('the repo folder it reads is the module\'s own, not the caller\'s', async () => {
  const repo = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  expect(path.resolve(REPO_ROOT)).toBe(repo);
  const entry = new URL('../src/mcp/index.js', import.meta.url).href;
  const cwd = await tmpdir();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', `import(${JSON.stringify(entry)}).then((m) => process.stdout.write(m.REPO_ROOT))`], { cwd },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  expect(path.resolve(out.trim())).toBe(repo);
  expect(path.resolve(out.trim())).not.toBe(path.resolve(cwd));
});

test('a cwd\'s .env and token file are both read: config URL, file token', async () => {
  const cwd = await tmpdir();
  await fs.mkdir(path.join(cwd, 'data'));
  await fs.writeFile(path.join(cwd, 'data/mcp-token.json'), JSON.stringify({ token: 'filetok' }));
  await fs.writeFile(path.join(cwd, '.env'), 'TMUXIFIER_PORT=7999\n');
  const { code, log } = await runMain({ cwd });
  expect(log).toContain('→ http://127.0.0.1:7999 (url from config, token from file)');
  expect(code).toBe(0);
});

// The TMUXIFIER_MCP_* knobs documented in .env.example are .env knobs: the
// entry point must fold that file into the map it hands resolveMcpConfig, not
// only into the one loadConfig sees.
test('.env supplies the MCP knobs themselves, not just the server settings', async () => {
  const cwd = await tmpdir();
  await fs.writeFile(path.join(cwd, '.env'), 'TMUXIFIER_MCP_URL=http://127.0.0.1:7998\nTMUXIFIER_MCP_TOKEN=envfiletok\n');
  const { code, log } = await runMain({ cwd });
  expect(log).toContain('→ http://127.0.0.1:7998 (url from env, token from env)');
  expect(code).toBe(0);
});

// docs/DEPLOY.md's on-host TLS deployment: the server serves a certificate no
// public CA signed. The MCP server derives its URL from that same config, so it
// must trust exactly that certificate — otherwise the documented setup only
// works with verification switched off entirely.
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

describe.runIf(opensslOk)('this repo\'s own TLS endpoint', () => {
  let srv; let other; let cwd; let enrolled; let port; let otherPort;

  const certFor = (dir, cn) => {
    const f = (n) => path.join(dir, n);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', f('key.pem'), '-out', f('cert.pem'),
      '-days', '1', '-nodes', '-subj', `/CN=${cn}`, '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { cert: fsSync.readFileSync(f('cert.pem')), key: fsSync.readFileSync(f('key.pem')) };
  };
  const api = (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    res.end(req.url === '/api/boxes' ? '[]' : '{}');
  };

  beforeAll(async () => {
    cwd = await tmpdir();
    enrolled = await tmpdir();
    for (const d of [cwd, enrolled]) { await fs.mkdir(path.join(d, 'tls')); await fs.mkdir(path.join(d, 'data')); }
    srv = https.createServer(certFor(path.join(cwd, 'tls'), 'tmuxifier-test'), api);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
    // A second server with a certificate of its own — the stranger this repo's
    // certificate must never be offered to.
    const otherDir = await tmpdir();
    other = https.createServer(certFor(otherDir, 'somebody-else'), api);
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    otherPort = other.address().port;

    const env = `TMUXIFIER_PORT=${port}\nTMUXIFIER_TLS_CERT=tls/cert.pem\nTMUXIFIER_TLS_KEY=tls/key.pem\n`;
    await fs.writeFile(path.join(cwd, '.env'), env);
    await fs.writeFile(path.join(cwd, 'data/mcp-token.json'), JSON.stringify({ token: 'tok' }));
    // The same host, enrolled: mcp-enroll records the URL it paired against on
    // EVERY run, so this — not the bare token file above — is the ordinary case.
    await fs.writeFile(path.join(enrolled, '.env'), env);
    await fs.copyFile(path.join(cwd, 'tls/cert.pem'), path.join(enrolled, 'tls/cert.pem'));
    await fs.copyFile(path.join(cwd, 'tls/key.pem'), path.join(enrolled, 'tls/key.pem'));
    await fs.writeFile(path.join(enrolled, 'data/mcp-token.json'), JSON.stringify({ token: 'tok', url: `https://127.0.0.1:${port}` }));
  });

  afterAll(async () => {
    if (srv) await new Promise((r) => srv.close(r));
    if (other) await new Promise((r) => other.close(r));
  });

  const listBoxes = async ({ dir, env = {} }) => withMain({ cwd: dir, env }, async ({ rpc, logs }) => {
    const res = await rpc('tools/call', { name: 'list_boxes', arguments: {} });
    return { res: res.result, log: logs.join('\n') };
  });

  test('is trusted when the config itself resolved the URL', async () => {
    const { res, log } = await listBoxes({ dir: cwd });
    expect(log).toContain(`\u2192 https://127.0.0.1:${port} (url from config, token from file)`);
    expect(res).toEqual({ content: [{ type: 'text', text: 'no boxes' }] });
  });

  test('is trusted when the URL came from the token file enrollment wrote', async () => {
    const { res, log } = await listBoxes({ dir: enrolled });
    expect(log).toContain(`\u2192 https://127.0.0.1:${port} (url from file, token from file)`);
    expect(res).toEqual({ content: [{ type: 'text', text: 'no boxes' }] });
  });

  test('is trusted when the env names that same URL', async () => {
    const { res, log } = await listBoxes({ dir: cwd, env: { TMUXIFIER_MCP_URL: `https://127.0.0.1:${port}`, TMUXIFIER_MCP_TOKEN: 'tok' } });
    expect(log).toContain('(url from env, token from env)');
    expect(res).toEqual({ content: [{ type: 'text', text: 'no boxes' }] });
  });

  test('is never offered to a different endpoint, which serves a chain of its own', async () => {
    const { res } = await listBoxes({ dir: cwd, env: { TMUXIFIER_MCP_URL: `https://127.0.0.1:${otherPort}`, TMUXIFIER_MCP_TOKEN: 'tok' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|unable to verify/);
  });
});
