import { test, expect } from 'vitest';
import { createMcpServer, LATEST_PROTOCOL } from '../src/mcp/mcpServer.js';
import { METHOD_NOT_FOUND, INVALID_PARAMS, PARSE_ERROR, INVALID_REQUEST } from '../src/mcp/jsonrpc.js';

function registry(handlers = {}) {
  return {
    list: () => Object.keys(handlers).map((name) => ({ name, description: `tool ${name}`, inputSchema: { type: 'object', properties: {} } })),
    async call(name, args) {
      if (!handlers[name]) { const e = new Error(`unknown tool: ${name}`); e.code = 'UNKNOWN_TOOL'; throw e; }
      return handlers[name](args);
    },
  };
}
const req = (id, method, params) => ({ ok: true, message: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } });
const server = (handlers) => createMcpServer({ registry: registry(handlers), serverInfo: { name: 'tmuxifier', version: '9.9.9' } });

test('initialize echoes a supported client version and advertises tools', async () => {
  const s = server();
  const res = await s.handle(req(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tmuxifier', version: '9.9.9' },
  } });
});

test('initialize falls back to the latest known version for an unknown one', async () => {
  const res = await server().handle(req(1, 'initialize', { protocolVersion: '1999-01-01' }));
  expect(res.result.protocolVersion).toBe(LATEST_PROTOCOL);
});

test('notifications/initialized and any other notification produce no response', async () => {
  const s = server();
  expect(await s.handle({ ok: true, message: { jsonrpc: '2.0', method: 'notifications/initialized' } })).toBeNull();
  expect(await s.handle({ ok: true, message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } } })).toBeNull();
});

test('ping answers an empty object', async () => {
  expect(await server().handle(req(4, 'ping'))).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
});

test('tools/list returns the registry catalog', async () => {
  const res = await server({ read_pane: async () => ({ content: [] }) }).handle(req(5, 'tools/list'));
  expect(res.result).toEqual({ tools: [{ name: 'read_pane', description: 'tool read_pane', inputSchema: { type: 'object', properties: {} } }] });
});

test('tools/call dispatches with arguments and relays the result', async () => {
  const seen = [];
  const s = server({ echo: async (args) => { seen.push(args); return { content: [{ type: 'text', text: `hi ${args.who}` }] }; } });
  const res = await s.handle(req(6, 'tools/call', { name: 'echo', arguments: { who: 'bob' } }));
  expect(seen).toEqual([{ who: 'bob' }]);
  expect(res).toEqual({ jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: 'hi bob' }] } });
});

test('tools/call with no arguments passes an empty object', async () => {
  const seen = [];
  const s = server({ echo: async (args) => { seen.push(args); return { content: [] }; } });
  await s.handle(req(6, 'tools/call', { name: 'echo' }));
  expect(seen).toEqual([{}]);
});

test('a handler throw becomes an isError tool result, never a transport error', async () => {
  const s = server({ boom: async () => { throw new Error('kaboom'); } });
  const res = await s.handle(req(7, 'tools/call', { name: 'boom', arguments: {} }));
  expect(res.result).toEqual({ content: [{ type: 'text', text: 'kaboom' }], isError: true });
});

test('an unknown tool is a JSON-RPC invalid-params error', async () => {
  const res = await server().handle(req(8, 'tools/call', { name: 'nope', arguments: {} }));
  expect(res.error.code).toBe(INVALID_PARAMS);
  expect(res.error.message).toMatch(/unknown tool/);
});

test('tools/call without a name is invalid params', async () => {
  const res = await server().handle(req(8, 'tools/call', {}));
  expect(res.error.code).toBe(INVALID_PARAMS);
});

test('an unknown method is -32601', async () => {
  const res = await server().handle(req(9, 'resources/list'));
  expect(res).toEqual({ jsonrpc: '2.0', id: 9, error: { code: METHOD_NOT_FOUND, message: 'method not found: resources/list' } });
});

test('a parse-error entry answers -32700 with a null id', async () => {
  const res = await server().handle({ ok: false, id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
  expect(res).toEqual({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
});

test('a batch or a non-object answers -32600; a stray response is ignored', async () => {
  const s = server();
  expect((await s.handle({ ok: true, message: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] })).error.code).toBe(INVALID_REQUEST);
  expect(await s.handle({ ok: true, message: { jsonrpc: '2.0', id: 1, result: {} } })).toBeNull();
});

test('connect() handles messages concurrently — a slow call does not block a fast one', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = server({
    slow: async () => { await gate; return { content: [{ type: 'text', text: 'slow' }] }; },
    fast: async () => ({ content: [{ type: 'text', text: 'fast' }] }),
  });
  const sent = [];
  let deliver;
  s.connect({ send: (m) => sent.push(m), onMessage: (cb) => { deliver = cb; } });
  deliver(req(1, 'tools/call', { name: 'slow', arguments: {} }));
  deliver(req(2, 'tools/call', { name: 'fast', arguments: {} }));
  await new Promise((r) => setTimeout(r, 10));
  expect(sent.map((m) => m.id)).toEqual([2]);
  release();
  await new Promise((r) => setTimeout(r, 10));
  expect(sent.map((m) => m.id)).toEqual([2, 1]);
});

test('connect() never sends for a notification', async () => {
  const s = server();
  const sent = [];
  let deliver;
  s.connect({ send: (m) => sent.push(m), onMessage: (cb) => { deliver = cb; } });
  deliver({ ok: true, message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  await new Promise((r) => setTimeout(r, 5));
  expect(sent).toEqual([]);
});
