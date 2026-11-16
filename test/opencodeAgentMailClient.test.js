import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailListener, MAX_SOCKET_PATH_BYTES, MAX_REQUEST_BYTES } from '../src/server/agentMailListener.js';
import { wakeText } from '../src/server/agentMailText.js';
import {
  createMailSocketClient,
  MAX_SOCKET_PATH_BYTES as ASSET_MAX_SOCKET_PATH_BYTES,
  MAIL_BODY_CAP,
  MAIL_WAIT_TIMEOUT_MS,
} from '../src/server/assets/tmuxifier-opencode-agent.js';
import { createMailHarness, B, mark } from './helpers/agentMailHarness.js';

// The plugin asset's mail socket client (agent messaging, spec §6.5) against the REAL listener
// on a real unix socket over the real hub and stores (the box is `o`, so the client speaks as
// orders/main). Stand-in servers (a plain http server, a silent net server) appear only where
// the real listener cannot misbehave on demand: a 200 that is not a wake, an oversized body,
// an answer that never comes, and the exact bytes the client puts on the wire.

const SESSION = 'main';
const PANE = '%3';
const MID = 'm-abcdefgh';

let h; let dir; let sock; let listener; let extras;

beforeEach(async () => {
  h = await createMailHarness({ holdMs: 60_000 });
  // b may write to o, so a waiter of o/main can be sent mail.
  await h.setPolicy('o', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] });
  await h.setPolicy('b', { send: true, sendTo: ['o'], receive: true, receiveFrom: ['o'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mail-'));
  sock = path.join(dir, 's', 'sock');
  listener = null;
  extras = [];
});

afterEach(async () => {
  if (listener) await listener.close();
  for (const close of extras) await close();
  await h.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(over = {}) {
  listener = createAgentMailListener({ hub: h.hub, boxId: 'o', socketPath: sock, ...over });
  await listener.listen();
  return listener;
}

// A plain http server on its own unix socket; `handler` is an http request listener. The
// requests it saw are in `seen` ({ method, url, headers, body }).
async function stub(handler) {
  const file = path.join(dir, `stub-${extras.length}.sock`);
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(file, resolve));
  extras.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { file, seen };
}

// A server that accepts connections and never answers.
async function silent() {
  const file = path.join(dir, `silent-${extras.length}.sock`);
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); });
  await new Promise((resolve) => server.listen(file, resolve));
  extras.push(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return file;
}

async function until(pred, what) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waiting = () => h.hub.listening('o')[SESSION] ?? 0;

describe('createMailSocketClient: wait', () => {
  test('answers idle (204) when the hub ends the hold with nothing to hand over', async () => {
    h.hub = h.makeHub({ holdMs: 40 });
    await start();
    const client = createMailSocketClient({ sockPath: sock });
    const t0 = Date.now();
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'idle' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(waiting()).toBe(0);
  });

  test('returns the wake text and its message id when mail is handed to the waiting session', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const client = createMailSocketClient({ sockPath: sock });
    const w = client.wait({ session: SESSION, pane: PANE });
    await until(() => waiting() === 1, 'the waiter to connect');
    const sent = await h.hub.send(B, 'orders', 'which version?\nsecond line');
    expect(sent.ok).toBe(true);
    const got = await w;
    const m = h.store.thread(sent.threadId).messages[0];
    expect(got).toEqual({
      kind: 'mail',
      messageId: m.id,
      text: wakeText({ messageId: m.id, threadId: sent.threadId, from: 'billing/main', body: 'which version?\nsecond line', kind: 'task' }),
    });
    expect(got.text.startsWith(`[tmuxifier-mail ${m.id}] `)).toBe(true);
    expect(got.text.endsWith('\n')).toBe(false);
    expect(m.state).toBe('handed');
    expect(m.handedPane).toBe(PANE);
  });

  test('a waiter whose session is not ready is held, and mail goes to it once the marker turns ready', async () => {
    await start();
    h.marks.o.main = mark('working');
    const client = createMailSocketClient({ sockPath: sock });
    const w = client.wait({ session: SESSION, pane: PANE });
    await until(() => waiting() === 1, 'the waiter to connect');
    const sent = await h.hub.send(B, 'orders', 'later');
    const early = await Promise.race([w, new Promise((r) => setTimeout(() => r('held'), 60))]);
    expect(early).toBe('held');
    h.marks.o.main = mark('ready');
    h.hub.boxChanged('o');
    const got = await w;
    expect(got.kind).toBe('mail');
    expect(got.messageId).toBe(h.store.thread(sent.threadId).messages[0].id);
  });

  test('aborting the signal ends the request: the hub sees the waiter gone and the call resolves down/aborted', async () => {
    await start();
    const client = createMailSocketClient({ sockPath: sock });
    const ac = new AbortController();
    const w = client.wait({ session: SESSION, pane: PANE, signal: ac.signal });
    await until(() => waiting() === 1, 'the waiter to connect');
    ac.abort();
    expect(await w).toEqual({ kind: 'down', reason: 'aborted' });
    await until(() => waiting() === 0, 'the hub to drop the waiter');
  });

  test('an already aborted signal never connects', async () => {
    const request = vi.fn(http.request);
    const client = createMailSocketClient({ sockPath: sock, request });
    const ac = new AbortController();
    ac.abort();
    expect(await client.wait({ session: SESSION, pane: PANE, signal: ac.signal })).toEqual({ kind: 'down', reason: 'aborted' });
    expect(request).not.toHaveBeenCalled();
  });

  test('a mail wake is not lost when the signal aborts after the answer: the result is the mail', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const client = createMailSocketClient({ sockPath: sock });
    const ac = new AbortController();
    const w = client.wait({ session: SESSION, pane: PANE, signal: ac.signal });
    await until(() => waiting() === 1, 'the waiter to connect');
    await h.hub.send(B, 'orders', 'ping');
    const got = await w;
    ac.abort();
    expect(got.kind).toBe('mail');
  });

  test('an absent socket is down/connect', async () => {
    const client = createMailSocketClient({ sockPath: path.join(dir, 'nothing-here', 'sock') });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'connect' });
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
  });

  test('a path that is a file, not a socket, is down/connect', async () => {
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    const client = createMailSocketClient({ sockPath: path.join(dir, 'file') });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'connect' });
  });

  test('a refusal from the listener is down with its status: bad session (400) and too many held requests (503)', async () => {
    await start({ maxHeld: 0 });
    const client = createMailSocketClient({ sockPath: sock });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'status 503' });
    expect(await client.wait({ session: 'not a session', pane: PANE })).toEqual({ kind: 'down', reason: 'status 400' });
    expect(await client.wait({ session: SESSION, pane: 'nope' })).toEqual({ kind: 'down', reason: 'status 400' });
  });

  test('with no answer inside the safety timeout it is down/timeout and the hub drops the waiter', async () => {
    await start();
    const client = createMailSocketClient({ sockPath: sock, waitTimeoutMs: 60 });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'timeout' });
    await until(() => waiting() === 0, 'the hub to drop the waiter');
  });

  test('the safety timeout defaults to the hub hold plus 30 s, and the hub hold is what the asset assumes', () => {
    const hub = fs.readFileSync(new URL('../src/server/agentMailHub.js', import.meta.url), 'utf8');
    const hold = Number(/holdMs = (\d+)\s*\}/.exec(hub)?.[1]);
    expect(hold).toBeGreaterThan(0);
    expect(MAIL_WAIT_TIMEOUT_MS).toBe(hold + 30_000);
  });

  test('a 200 whose first line is not a mail tag with a valid id is down/parse', async () => {
    for (const body of ['hello\n', '', '\n[tmuxifier-mail m-abcdefgh] x\n', '[tmuxifier-mail m-0ooooooo] x\n', '[tmuxifier-mail m-abcdefg] x\n', '[tmuxifier-mail m-abcdefgh x\n', ' [tmuxifier-mail m-abcdefgh] x\n']) {
      const s = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(body); });
      const client = createMailSocketClient({ sockPath: s.file });
      expect(await client.wait({ session: SESSION, pane: PANE }), JSON.stringify(body)).toEqual({ kind: 'down', reason: 'parse' });
    }
  });

  test('the text is the whole body minus its one final newline, lines and blank lines kept', async () => {
    const body = `[tmuxifier-mail ${MID}] Message from the agent in billing.\n\nline one\n\nline two\n`;
    const s = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); });
    const client = createMailSocketClient({ sockPath: s.file });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'mail', messageId: MID, text: body.slice(0, -1) });
  });

  test('a body over the cap is down/size, one at the cap is accepted', async () => {
    expect(MAIL_BODY_CAP).toBe(262144);
    const head = `[tmuxifier-mail ${MID}] `;
    const exact = head + 'x'.repeat(MAIL_BODY_CAP - head.length - 1) + '\n';
    expect(Buffer.byteLength(exact)).toBe(MAIL_BODY_CAP);
    const over = `${exact}x`;
    const a = await stub((req, res) => { res.writeHead(200); res.end(exact); });
    const b = await stub((req, res) => { res.writeHead(200); res.end(over); });
    expect((await createMailSocketClient({ sockPath: a.file }).wait({ session: SESSION, pane: PANE })).kind).toBe('mail');
    expect(await createMailSocketClient({ sockPath: b.file }).wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'size' });
  });

  test('a connection cut mid-answer is down', async () => {
    const s = await stub((req, res) => { res.writeHead(200, { 'Content-Length': '500' }); res.write('[tmuxifier-mail'); setTimeout(() => res.destroy(), 10); });
    const out = await createMailSocketClient({ sockPath: s.file }).wait({ session: SESSION, pane: PANE });
    expect(out.kind).toBe('down');
  });

  test('on the wire: GET with the parameters only in the query string, no body, no kept-alive socket', async () => {
    const s = await stub((req, res) => { res.writeHead(204); res.end(); });
    const client = createMailSocketClient({ sockPath: s.file });
    expect(await client.wait({ session: 'my.session-1', pane: '%12' })).toEqual({ kind: 'idle' });
    expect(s.seen).toHaveLength(1);
    const [r] = s.seen;
    expect(r.method).toBe('GET');
    const u = new URL(r.url, 'http://x');
    expect(u.pathname).toBe('/v1/wait');
    expect([...u.searchParams.entries()]).toEqual([['session', 'my.session-1'], ['pane', '%12']]);
    expect(r.body).toBe('');
    expect(String(r.headers.connection).toLowerCase()).toBe('close');
  });
});

describe('createMailSocketClient: ack', () => {
  test('true once for a handed message, which then reads delivered; a second ack is false', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const client = createMailSocketClient({ sockPath: sock });
    const w = client.wait({ session: SESSION, pane: PANE });
    await until(() => waiting() === 1, 'the waiter to connect');
    const sent = await h.hub.send(B, 'orders', 'ping');
    const got = await w;
    const find = () => h.store.thread(sent.threadId).messages.find((m) => m.id === got.messageId);
    expect(find().state).toBe('handed');
    expect(await client.ack({ session: SESSION, messageId: got.messageId })).toBe(true);
    expect(find().state).toBe('delivered');
    expect(await client.ack({ session: SESSION, messageId: got.messageId })).toBe(false);
  });

  test('false for a message nobody handed this session (404), and for a bad id or session without a request', async () => {
    await start();
    const request = vi.fn(http.request);
    const client = createMailSocketClient({ sockPath: sock, request });
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await client.ack({ session: SESSION, messageId: 'm-0ooooooo' })).toBe(false);
    expect(await client.ack({ session: SESSION, messageId: undefined })).toBe(false);
    expect(await client.ack({ session: 5, messageId: MID })).toBe(false);
    expect(await client.ack()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('on the wire: a form-encoded POST /v1/ack with session and m in the body and nothing in the query', async () => {
    const s = await stub((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok\n'); });
    const client = createMailSocketClient({ sockPath: s.file });
    expect(await client.ack({ session: 'my session', messageId: MID })).toBe(true);
    const [r] = s.seen;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/v1/ack');
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.body));
    expect([...new URLSearchParams(r.body).entries()]).toEqual([['session', 'my session'], ['m', MID]]);
    expect(String(r.headers.connection).toLowerCase()).toBe('close');
  });

  test('only a 200 is true: 204, 400, 404 and 503 are false', async () => {
    for (const status of [204, 201, 400, 404, 503]) {
      const s = await stub((req, res) => { res.writeHead(status); res.end(status === 204 ? undefined : 'x\n'); });
      expect(await createMailSocketClient({ sockPath: s.file }).ack({ session: SESSION, messageId: MID }), String(status)).toBe(false);
    }
  });

  test('no answer inside the ack timeout is false', async () => {
    const file = await silent();
    const client = createMailSocketClient({ sockPath: file, ackTimeoutMs: 50 });
    const t0 = Date.now();
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('nothing is left open after a wake and its ack: the listener closes at once', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const client = createMailSocketClient({ sockPath: sock });
    const w = client.wait({ session: SESSION, pane: PANE });
    await until(() => waiting() === 1, 'the waiter to connect');
    await h.hub.send(B, 'orders', 'ping');
    const got = await w;
    expect(await client.ack({ session: SESSION, messageId: got.messageId })).toBe(true);
    const t0 = Date.now();
    await listener.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('createMailSocketClient: the socket path', () => {
  test('the asset keeps its own copy of the listener\'s limits, pinned equal', () => {
    expect(ASSET_MAX_SOCKET_PATH_BYTES).toBe(MAX_SOCKET_PATH_BYTES);
    expect(MAIL_BODY_CAP).toBe(MAX_REQUEST_BYTES);
  });

  test('a path over 107 bytes is down/path and false, without a request', async () => {
    const request = vi.fn(http.request);
    const long = `/${'a'.repeat(MAX_SOCKET_PATH_BYTES)}`; // 108 bytes
    expect(Buffer.byteLength(long)).toBe(MAX_SOCKET_PATH_BYTES + 1);
    const client = createMailSocketClient({ sockPath: long, request });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'path' });
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  test('the limit counts UTF-8 bytes, not characters', async () => {
    const request = vi.fn(http.request);
    const wide = `/${'é'.repeat(54)}`; // 55 characters, 109 bytes
    expect(wide.length).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(wide)).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    const client = createMailSocketClient({ sockPath: wide, request });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'path' });
    expect(request).not.toHaveBeenCalled();
  });

  test('a path of exactly 107 bytes is tried', async () => {
    const request = vi.fn(http.request);
    const edge = `/${'a'.repeat(MAX_SOCKET_PATH_BYTES - 1)}`;
    expect(Buffer.byteLength(edge)).toBe(MAX_SOCKET_PATH_BYTES);
    const client = createMailSocketClient({ sockPath: edge, request });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'connect' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('a missing or non-string path is down/path', async () => {
    for (const sockPath of [undefined, null, '', 7, {}]) {
      const client = createMailSocketClient({ sockPath });
      expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'path' });
      expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
    }
    expect(await createMailSocketClient().wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'path' });
  });
});

describe('createMailSocketClient: never throws or rejects', () => {
  test('a request function that throws is down/connect and ack false', async () => {
    const request = () => { throw new Error('boom'); };
    const client = createMailSocketClient({ sockPath: sock, request });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'connect' });
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
  });

  test('bad wait arguments are down/args', async () => {
    const request = vi.fn(http.request);
    const client = createMailSocketClient({ sockPath: sock, request });
    for (const args of [undefined, {}, { session: 1, pane: PANE }, { session: SESSION }, { session: SESSION, pane: 3 }]) {
      expect(await client.wait(args), JSON.stringify(args)).toEqual({ kind: 'down', reason: 'args' });
    }
    expect(request).not.toHaveBeenCalled();
  });

  test('a signal that is not an AbortSignal is ignored', async () => {
    h.hub = h.makeHub({ holdMs: 30 });
    await start();
    const client = createMailSocketClient({ sockPath: sock });
    expect(await client.wait({ session: SESSION, pane: PANE, signal: {} })).toEqual({ kind: 'idle' });
  });
});
