// The MCP lifecycle, transport-agnostic on purpose: phase 2 (Streamable HTTP
// behind Fastify) mounts this module unchanged. Handlers run concurrently so a
// blocking wait_for_* call never stalls a concurrent read_pane.
import { result, error, classify, METHOD_NOT_FOUND, INVALID_PARAMS, INVALID_REQUEST, INTERNAL_ERROR } from './jsonrpc.js';

export const LATEST_PROTOCOL = '2025-06-18';
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createMcpServer({ registry, serverInfo, log = () => {} }) {
  const methods = {
    async initialize(params) {
      const asked = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: serverInfo.name, version: serverInfo.version } };
    },
    async ping() { return {}; },
    async 'tools/list'() { return { tools: registry.list() }; },
    async 'tools/call'(params) {
      const name = params?.name;
      if (typeof name !== 'string' || !name) throw rpcError(INVALID_PARAMS, 'tools/call needs a tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        return await registry.call(name, args);
      } catch (e) {
        if (e?.code === 'UNKNOWN_TOOL') throw rpcError(INVALID_PARAMS, e.message);
        log(`tool ${name} failed: ${e?.message || e}`);
        return { content: [{ type: 'text', text: String(e?.message || e) }], isError: true };
      }
    },
  };

  async function handle(entry) {
    if (!entry.ok) return error(entry.id ?? null, entry.error.code, entry.error.message);
    const msg = entry.message;
    const kind = classify(msg);
    if (kind === 'invalid') return error(null, INVALID_REQUEST, 'invalid request');
    if (kind === 'notification' || kind === 'response') return null;
    const fn = methods[msg.method];
    if (!fn) return error(msg.id, METHOD_NOT_FOUND, `method not found: ${msg.method}`);
    try {
      return result(msg.id, await fn(msg.params));
    } catch (e) {
      if (e?.rpc) return error(msg.id, e.rpc.code, e.rpc.message);
      log(`${msg.method} failed: ${e?.message || e}`);
      return error(msg.id, INTERNAL_ERROR, 'internal error');
    }
  }

  function connect({ send, onMessage }) {
    onMessage((entry) => {
      handle(entry).then((res) => { if (res) send(res); }).catch((e) => log(`unhandled: ${e?.message || e}`));
    });
  }

  return { handle, connect };
}

function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = { code, message };
  return e;
}
