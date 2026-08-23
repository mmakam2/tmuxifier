import { test, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnMcp } from './helpers/mcpStdio.js';

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

test('without a token the process explains itself on stderr and exits 2', async () => {
  expect(process.env.TMUXIFIER_MCP_TOKEN).toBeUndefined();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-mcp-'));
  const mcp = spawnMcp({ cwd });
  let stdout = '';
  mcp.child.stdout.on('data', (c) => { stdout += c; });
  const code = await new Promise((r) => mcp.child.once('exit', r));
  expect(code).toBe(2);
  expect(mcp.stderr()).toMatch(/no MCP token: set TMUXIFIER_MCP_TOKEN or run `npm run mcp-enroll`/);
  expect(stdout).toBe('');
});
