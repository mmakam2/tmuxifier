import { test, expect } from 'vitest';
import { createLineParser, encode, result, error, classify, PARSE_ERROR, METHOD_NOT_FOUND } from '../src/mcp/jsonrpc.js';

test('parses one message per line and buffers partial lines', () => {
  const p = createLineParser();
  expect(p.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"me')).toEqual([
    { ok: true, message: { jsonrpc: '2.0', id: 1, method: 'ping' } },
  ]);
  expect(p.push('thod":"ping"}\r\n')).toEqual([
    { ok: true, message: { jsonrpc: '2.0', id: 2, method: 'ping' } },
  ]);
});

test('accepts Buffer chunks split mid-multibyte-character', () => {
  const p = createLineParser();
  const line = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x","params":{"s":"é"}}\n');
  const cut = line.indexOf(Buffer.from('é')) + 1; // one byte into the 2-byte é
  const out = [...p.push(line.subarray(0, cut)), ...p.push(line.subarray(cut))];
  expect(out).toEqual([{ ok: true, message: { jsonrpc: '2.0', id: 1, method: 'x', params: { s: 'é' } } }]);
});

test('a malformed line yields a parse error entry and does not poison the next line', () => {
  const p = createLineParser();
  const out = p.push('{not json\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  expect(out[0]).toEqual({ ok: false, id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
  expect(out[1]).toEqual({ ok: true, message: { jsonrpc: '2.0', id: 3, method: 'ping' } });
});

test('blank lines are skipped', () => {
  expect(createLineParser().push('\n\n  \n')).toEqual([]);
});

test('encode appends exactly one newline and never embeds a raw one', () => {
  const s = encode({ jsonrpc: '2.0', id: 1, result: { text: 'a\nb' } });
  expect(s.endsWith('\n')).toBe(true);
  expect(s.slice(0, -1)).not.toContain('\n');
});

test('result/error build well-formed envelopes', () => {
  expect(result(7, { ok: true })).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  expect(error(7, METHOD_NOT_FOUND, 'unknown method')).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'unknown method' } });
  expect(error(null, PARSE_ERROR, 'parse error', { line: 1 }).error.data).toEqual({ line: 1 });
});

test('classify distinguishes requests, notifications, responses and garbage', () => {
  expect(classify({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe('request');
  expect(classify({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toBe('request');
  expect(classify({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe('notification');
  expect(classify({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response');
  expect(classify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe('response');
  expect(classify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toBe('invalid');
  expect(classify({ jsonrpc: '2.0', id: {}, method: 'ping' })).toBe('invalid');
  expect(classify(null)).toBe('invalid');
  expect(classify('ping')).toBe('invalid');
});
