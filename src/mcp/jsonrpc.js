// Pure newline-delimited JSON-RPC 2.0 framing for the MCP stdio transport.
// No I/O: fed strings/Buffers, returns objects. Batches are deliberately
// unsupported (MCP removed them in 2025-06-18); an array classifies as invalid.
import { StringDecoder } from 'node:string_decoder';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function createLineParser() {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return {
    push(chunk) {
      buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      const out = [];
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { out.push({ ok: true, message: JSON.parse(line) }); }
        catch { out.push({ ok: false, id: null, error: { code: PARSE_ERROR, message: 'parse error' } }); }
      }
      return out;
    },
  };
}

export function encode(message) { return JSON.stringify(message) + '\n'; }

export function result(id, value) { return { jsonrpc: '2.0', id, result: value }; }

export function error(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

export function classify(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid';
  const hasMethod = typeof message.method === 'string';
  const hasId = 'id' in message && message.id !== null;
  if (hasMethod && hasId) return validId(message.id) ? 'request' : 'invalid';
  if (hasMethod) return 'notification';
  if (hasId && ('result' in message || 'error' in message)) return 'response';
  return 'invalid';
}
