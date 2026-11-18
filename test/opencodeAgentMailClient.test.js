import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
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

// A request function that records every client socket it opens.
function tracked() {
  const sockets = [];
  const request = (opts, onRes) => {
    const req = http.request(opts, onRes);
    req.on('socket', (s) => sockets.push(s));
    return req;
  };
  return { request, sockets };
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

  test('a mail wake is not lost when the signal aborts the instant its answer is read: the result is the mail', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const ac = new AbortController();
    // The abort fires inside the answer's own `end` event, right behind the client's `end`
    // listener and before anything awaiting the call can run. Only a client that settles on
    // `end` itself keeps the mail; one that settles any later (a microtask, `close`) reads it
    // as aborted, and the wake the hub handed over is lost to it.
    const request = (opts, onRes) => http.request(opts, (res) => { onRes(res); res.once('end', () => ac.abort()); });
    const client = createMailSocketClient({ sockPath: sock, request });
    const w = client.wait({ session: SESSION, pane: PANE, signal: ac.signal });
    await until(() => waiting() === 1, 'the waiter to connect');
    const sent = await h.hub.send(B, 'orders', 'ping');
    const got = await w;
    expect(ac.signal.aborted, 'the abort fired').toBe(true);
    expect(got.kind).toBe('mail');
    expect(got.messageId).toBe(h.store.thread(sent.threadId).messages[0].id);
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

  test('nothing is left open after a wake and its ack: every client socket is destroyed, the listener untouched', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const t = tracked();
    const client = createMailSocketClient({ sockPath: sock, request: t.request });
    const w = client.wait({ session: SESSION, pane: PANE });
    await until(() => waiting() === 1, 'the waiter to connect');
    await h.hub.send(B, 'orders', 'ping');
    const got = await w;
    expect(await client.ack({ session: SESSION, messageId: got.messageId })).toBe(true);
    expect(t.sockets, 'one socket per request').toHaveLength(2);
    // The listener keeps an idle kept-alive socket open for seconds, so a client that let one
    // be kept alive (or pooled it) fails this; listener.close() would destroy it and hide that.
    await until(() => t.sockets.every((s) => s.destroyed), 'every client socket to be destroyed');
    expect(waiting(), 'no waiter left on the hub').toBe(0);
  });

  test('a call settled before its answer ends destroys the connection: an oversized body the server never finishes', async () => {
    const closed = [];
    const file = path.join(dir, 'endless.sock');
    const server = net.createServer((s) => {
      s.on('error', () => {});
      s.on('close', () => closed.push(true));
      s.once('data', () => {
        // Promises more than the cap, sends just over it, and then holds the connection open.
        s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${MAIL_BODY_CAP * 2}\r\n\r\n[tmuxifier-mail ${MID}] ${'x'.repeat(MAIL_BODY_CAP)}`);
      });
    });
    await new Promise((resolve) => server.listen(file, resolve));
    extras.push(() => new Promise((resolve) => { server.close(() => resolve()); }));
    const client = createMailSocketClient({ sockPath: file });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'size' });
    await until(() => closed.length === 1, 'the server to see the connection closed');
  });
});

// A stand-in that sends a status line and headers promising a body, part of that body, and then
// resets the connection. Bun's node:http inside OpenCode is unmeasured, so the client must give
// every emitter a listener and never leave an `error` unhandled, whatever the order of events.
async function resetting(status, { partial = 'par', length = 100 } = {}) {
  const file = path.join(dir, `reset-${extras.length}.sock`);
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.once('data', () => {
      const head = status === 204
        ? 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'
        : `HTTP/1.1 ${status} X\r\nContent-Type: text/plain\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${partial}`;
      s.write(head, () => setTimeout(() => { try { s.resetAndDestroy(); } catch { s.destroy(); } }, 5));
    });
  });
  await new Promise((resolve) => server.listen(file, resolve));
  extras.push(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return file;
}

describe('createMailSocketClient: an answer cut off by a reset', () => {
  test('wait and ack settle on a 204, 503 or 404 whose connection is reset mid-body, with no uncaught error', async () => {
    const errors = [];
    const onErr = (e) => errors.push(e);
    process.on('uncaughtException', onErr);
    try {
      for (const status of [204, 503, 404, 200]) {
        const file = await resetting(status);
        const client = createMailSocketClient({ sockPath: file });
        const r = await client.wait({ session: SESSION, pane: PANE });
        if (status === 204) expect(r).toEqual({ kind: 'idle' });
        else if (status === 200) expect(r).toMatchObject({ kind: 'down' });
        else expect(r).toEqual({ kind: 'down', reason: `status ${status}` });
        // ack reads only the status line: a 200 is true even when its body is cut off.
        const a = await client.ack({ session: SESSION, messageId: MID });
        expect(a, String(status)).toBe(status === 200);
      }
      // Give a late `error` from a destroyed response a chance to surface.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onErr);
    }
    expect(errors).toEqual([]);
  });

  test('every response gets an error listener before the call settles, and an unread body is drained', async () => {
    const seen = [];
    const request = (opts, onRes) => {
      const req = new (class extends EventEmitter {
        write() {} end() {
          setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = this.status;
            res.resume = () => { seen.push(['resume', res.listenerCount('error')]); };
            onRes(res);
            seen.push(['after', res.listenerCount('error')]);
          });
        }
        destroy() { seen.push(['destroy']); }
      })();
      req.status = opts.method === 'GET' ? 503 : 404;
      return req;
    };
    const client = createMailSocketClient({ sockPath: sock, request });
    expect(await client.wait({ session: SESSION, pane: PANE })).toEqual({ kind: 'down', reason: 'status 503' });
    expect(await client.ack({ session: SESSION, messageId: MID })).toBe(false);
    // resume (with an error listener already on), then the destroy, then nothing new.
    expect(seen).toEqual([['resume', 1], ['destroy'], ['after', 1], ['resume', 1], ['destroy'], ['after', 1]]);
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

// The abort listener a wait puts on its signal is removed whatever settles the call, so a
// long-lived signal (the mail part's, one per part) does not collect one per wait.
describe('createMailSocketClient: the abort listener', () => {
  const listeners = (signal) => getEventListeners(signal, 'abort').length;

  test('wait removes it when the answer settles the call: mail, idle, a refusal, an unparsable 200', async () => {
    await start();
    h.marks.o.main = mark('ready');
    const ac = new AbortController();
    const w = createMailSocketClient({ sockPath: sock }).wait({ session: SESSION, pane: PANE, signal: ac.signal });
    await until(() => waiting() === 1, 'the waiter to connect');
    expect(listeners(ac.signal), 'while the wait is held').toBe(1);
    await h.hub.send(B, 'orders', 'ping');
    expect((await w).kind).toBe('mail');
    expect(listeners(ac.signal), 'after mail').toBe(0);
    for (const [status, body, want] of [[204, undefined, { kind: 'idle' }], [503, 'busy\n', { kind: 'down', reason: 'status 503' }], [200, 'hello\n', { kind: 'down', reason: 'parse' }]]) {
      const s = await stub((req, res) => { res.writeHead(status); res.end(body); });
      const signal = new AbortController().signal;
      expect(await createMailSocketClient({ sockPath: s.file }).wait({ session: SESSION, pane: PANE, signal }), String(status)).toEqual(want);
      expect(listeners(signal), `after a ${status}`).toBe(0);
    }
  });

  test('wait removes it on the safety timeout and on a connection error', async () => {
    const file = await silent();
    const a = new AbortController().signal;
    expect(await createMailSocketClient({ sockPath: file, waitTimeoutMs: 50 }).wait({ session: SESSION, pane: PANE, signal: a })).toEqual({ kind: 'down', reason: 'timeout' });
    expect(listeners(a), 'after a timeout').toBe(0);
    const b = new AbortController().signal;
    expect(await createMailSocketClient({ sockPath: path.join(dir, 'nothing-here', 'sock') }).wait({ session: SESSION, pane: PANE, signal: b })).toEqual({ kind: 'down', reason: 'connect' });
    expect(listeners(b), 'after a connection error').toBe(0);
    const c = new AbortController().signal;
    const request = () => { throw new Error('boom'); };
    expect(await createMailSocketClient({ sockPath: sock, request }).wait({ session: SESSION, pane: PANE, signal: c })).toEqual({ kind: 'down', reason: 'connect' });
    expect(listeners(c), 'after a request function that throws').toBe(0);
  });

  test('wait leaves none after an abort, and adds none for a signal already aborted', async () => {
    await start();
    const ac = new AbortController();
    const w = createMailSocketClient({ sockPath: sock }).wait({ session: SESSION, pane: PANE, signal: ac.signal });
    await until(() => waiting() === 1, 'the waiter to connect');
    ac.abort();
    expect(await w).toEqual({ kind: 'down', reason: 'aborted' });
    expect(listeners(ac.signal), 'after the abort').toBe(0);
    const done = AbortSignal.abort();
    expect(await createMailSocketClient({ sockPath: sock }).wait({ session: SESSION, pane: PANE, signal: done })).toEqual({ kind: 'down', reason: 'aborted' });
    expect(listeners(done), 'an already aborted signal').toBe(0);
  });

  test('ack takes no signal: one passed to it is never listened on', async () => {
    const s = await stub((req, res) => { res.writeHead(200); res.end('ok\n'); });
    const signal = new AbortController().signal;
    expect(await createMailSocketClient({ sockPath: s.file }).ack({ session: SESSION, messageId: MID, signal })).toBe(true);
    expect(listeners(signal)).toBe(0);
  });
});
