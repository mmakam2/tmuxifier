import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SESSION_NAME_RE } from './sshCommand.js';
import { THREAD_ID_RE, MSG_ID_RE } from './agentMailStore.js';

// The per-box agent-mail listener (design 6.4, 6.5): plain HTTP on a unix socket, one per box,
// forwarded onto the box as ~/.tmuxifier-mail/sock. The socket a request arrives on IS the box:
// `caller.boxId` is this listener's own `boxId`, never anything in the request. Everything a
// request carries is box output, so every parameter is checked against an allowlist BEFORE any
// hub call (the hub answers a malformed caller without logging it, on the understanding that
// nothing malformed gets that far), and is never rewritten.
//
// Wire format (the box-side `tmx` client is written against exactly this):
//   GET  /v1/ping?n=<16 lowercase hex>          200 ok (n optional; the last 8 are kept for sawNonce)
//   GET  /v1/who?session=                       200 | 403
//   POST /v1/threads            session,to,body 200 | 403
//   POST /v1/threads/<id>/messages session,body 200 | 403
//   GET  /v1/threads/<id>?session=              200 | 403
//   GET  /v1/inbox?session=                     200 | 403
//   GET  /v1/replies?session=&threads=a,b&timeout=<s>   200; no reply: X-Mail: none
//   GET  /v1/wait?session=&pane=%N              200 wake text | 204 idle
//   POST /v1/ack                session,m       200 ok | 404
// GET parameters come in the query string and a GET has no body; POST parameters come only in an
// application/x-www-form-urlencoded body (a query string on a POST is refused). Both are strict
// UTF-8 percent-encoding, decoded with URLSearchParams. A parameter given twice is refused. Every
// response is text/plain; charset=utf-8 and ends in exactly one newline (204 has no body). Bad
// input is 400 `bad request: <reason>`, an unknown path or method 404, a body over
// MAX_REQUEST_BYTES on the wire 413, more than `maxOpen` requests in progress or `maxHeld` held
// ones 503.
//
// Held requests (/v1/wait, /v1/replies) get an AbortSignal that is aborted when the client's
// connection closes before the response was written, and only then. close() aborts every held
// request (the hub answers it: idle for a waiter, status lines for a reply wait), waits for those
// answers to be written, destroys every remaining connection (keep-alive or half-sent), and
// removes the socket file if it is still the one this listener bound.

export const MAX_SOCKET_PATH_BYTES = 107; // sun_path is 108 bytes on Linux, NUL included
export const MAX_REQUEST_BYTES = 262144;
export const MAX_THREAD_IDS = 16;
const PANE_RE = /^%\d{1,9}$/;
const NONCE_RE = /^[0-9a-f]{16}$/;
const TIMEOUT_RE = /^\d{1,6}$/; // seconds; the hub clamps the value to its own range
const NONCES_KEPT = 8;
const FORM_TYPE = 'application/x-www-form-urlencoded';
const TEXT_TYPE = 'text/plain; charset=utf-8';

class BadRequest extends Error {}
class TooLarge extends Error {}
class Gone extends Error {}

// Strict form decoding: null unless every `+`-for-space, percent-escaped component is valid
// UTF-8 (URLSearchParams alone would turn a bad escape into U+FFFD, i.e. rewrite it).
function strictForm(s) {
  for (const part of s.split('&')) {
    for (const piece of part.split('=')) {
      try { decodeURIComponent(piece.replace(/\+/g, ' ')); } catch { return null; }
    }
  }
  return new URLSearchParams(s);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// [pathname, query or null]; the raw request target, never decoded.
function splitTarget(url) {
  const q = url.indexOf('?');
  return q === -1 ? [url, null] : [url.slice(0, q), url.slice(q + 1)];
}

// { name, id } for a known method and path, else null. The thread id segment is validated later
// (a bad id there is a 400, not a 404).
function route(method, pathname) {
  const fixed = {
    'GET /v1/ping': 'ping',
    'GET /v1/who': 'who',
    'POST /v1/threads': 'send',
    'GET /v1/inbox': 'inbox',
    'GET /v1/replies': 'replies',
    'GET /v1/wait': 'wait',
    'POST /v1/ack': 'ack',
  };
  const key = `${method} ${pathname}`;
  if (Object.hasOwn(fixed, key)) return { name: fixed[key] };
  const m = /^\/v1\/threads\/([^/]+)(\/messages)?$/.exec(pathname);
  if (!m) return null;
  if (m[2] && method === 'POST') return { name: 'reply', id: m[1] };
  if (!m[2] && method === 'GET') return { name: 'read', id: m[1] };
  return null;
}

export function createAgentMailListener({ hub, boxId, socketPath, maxOpen = 64, maxHeld = 32 }) {
  let server = null;
  let bound = null; // { dev, ino } of the socket file this listener made
  let closing = false;
  let closed = null;
  let open = 0;
  const held = new Set(); // { ac, ended }
  const nonces = [];
  let lastAt = 0;

  function answer(res, status, text, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    const body = status === 204 ? '' : `${String(text).replace(/\n+$/, '')}\n`;
    res.writeHead(status, { 'Content-Type': TEXT_TYPE, ...headers });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = req.headers['content-length'];
      if (declared !== undefined && !(Number(declared) <= MAX_REQUEST_BYTES)) {
        reject(new TooLarge());
        return;
      }
      const chunks = [];
      let n = 0;
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      req.on('data', (c) => {
        if (done) return;
        n += c.length;
        if (n > MAX_REQUEST_BYTES) finish(reject, new TooLarge());
        else chunks.push(c);
      });
      req.on('end', () => finish(resolve, Buffer.concat(chunks)));
      req.on('close', () => finish(reject, new Gone()));
      req.on('error', () => finish(reject, new Gone()));
    });
  }

  // The request's parameters, or a thrown BadRequest/TooLarge.
  async function paramsOf(req, query) {
    const raw = await readBody(req);
    let text;
    if (req.method === 'POST') {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== FORM_TYPE) throw new BadRequest(`a POST takes an ${FORM_TYPE} body`);
      if (query !== null) throw new BadRequest('a POST takes its parameters in the body, not the query string');
      try { text = utf8.decode(raw); } catch { throw new BadRequest('the body is not valid UTF-8'); }
    } else {
      if (raw.length > 0) throw new BadRequest('a GET takes no body');
      text = query ?? '';
    }
    const params = strictForm(text);
    if (!params) throw new BadRequest('the parameters are not valid UTF-8 form encoding');
    return params;
  }

  // One parameter's value, or undefined when absent; a repeated parameter is refused.
  function one(params, name) {
    const all = params.getAll(name);
    if (all.length > 1) throw new BadRequest(`${name} is given more than once`);
    return all[0];
  }
  function sessionOf(params) {
    const s = one(params, 'session');
    if (typeof s !== 'string' || !SESSION_NAME_RE.test(s)) throw new BadRequest('session is not a valid tmux session name');
    return s;
  }
  function threadIdOf(id) {
    if (!THREAD_ID_RE.test(id)) throw new BadRequest('not a thread id');
    return id;
  }
  function threadIdsOf(params) {
    const raw = one(params, 'threads');
    if (typeof raw !== 'string' || raw === '') throw new BadRequest('threads is missing');
    const ids = raw.split(',');
    if (ids.length > MAX_THREAD_IDS) throw new BadRequest(`at most ${MAX_THREAD_IDS} threads`);
    for (const id of ids) threadIdOf(id);
    return ids;
  }

  // Runs a held hub call: the signal aborts only when the client goes before the answer.
  async function holdFor(res, run) {
    if (held.size >= maxHeld) return answer(res, 503, 'busy: too many held requests, try again later');
    const ac = new AbortController();
    let ended;
    const entry = { ac, ended: new Promise((r) => { ended = r; }) };
    held.add(entry);
    // Attached only while the hub call is pending: it is taken off (below) in the same run of
    // microtasks that writes the answer, before any socket event can fire, so a completed
    // response never aborts.
    const onClose = () => ac.abort();
    res.on('close', onClose);
    try {
      await run(ac.signal);
    } finally {
      res.off('close', onClose);
      held.delete(entry);
      ended();
    }
  }

  async function dispatch(req, res) {
    const [pathname, query] = splitTarget(req.url ?? '');
    const r = route(req.method, pathname);
    if (!r) return answer(res, 404, 'not found');
    const params = await paramsOf(req, query);
    if (closing) return answer(res, 503, 'busy: the mail service is shutting down', { Connection: 'close' });
    const id = r.id === undefined ? undefined : threadIdOf(r.id);
    const caller = () => ({ boxId, session: sessionOf(params) });
    const text = (out) => answer(res, out.ok ? 200 : 403, out.text);
    switch (r.name) {
      case 'ping': {
        const n = one(params, 'n');
        if (n !== undefined) {
          if (!NONCE_RE.test(n)) throw new BadRequest('n is not 16 lowercase hex digits');
          nonces.push(n);
          if (nonces.length > NONCES_KEPT) nonces.shift();
        }
        return answer(res, 200, 'ok');
      }
      case 'who': return text(await hub.who(caller()));
      case 'send': {
        const me = caller();
        return text(await hub.send(me, one(params, 'to') ?? '', one(params, 'body') ?? ''));
      }
      case 'reply': {
        const me = caller();
        return text(await hub.reply(me, id, one(params, 'body') ?? ''));
      }
      case 'read': return text(await hub.read(caller(), id));
      case 'inbox': return text(await hub.inbox(caller()));
      case 'ack': {
        const me = caller();
        const m = one(params, 'm');
        if (typeof m !== 'string' || !MSG_ID_RE.test(m)) throw new BadRequest('m is not a message id');
        return (await hub.ack(me, m)) ? answer(res, 200, 'ok') : answer(res, 404, 'not found: no message with that id is waiting for this session to confirm');
      }
      case 'wait': {
        const me = caller();
        const pane = one(params, 'pane');
        if (typeof pane !== 'string' || !PANE_RE.test(pane)) throw new BadRequest('pane is not a tmux pane id');
        return holdFor(res, async (signal) => {
          const out = await hub.waitMail(me, pane, signal);
          if (out.idle) answer(res, 204, '');
          else answer(res, 200, out.text);
        });
      }
      case 'replies': {
        const me = caller();
        const ids = threadIdsOf(params);
        const t = one(params, 'timeout');
        if (typeof t !== 'string' || !TIMEOUT_RE.test(t)) throw new BadRequest('timeout is not a whole number of seconds');
        return holdFor(res, async (signal) => {
          const out = await hub.waitReplies(me, ids, Number(t) * 1000, signal);
          answer(res, 200, out.text, out.got ? {} : { 'X-Mail': 'none' });
        });
      }
      default: return answer(res, 404, 'not found');
    }
  }

  async function onRequest(req, res) {
    lastAt = Date.now();
    if (closing) return answer(res, 503, 'busy: the mail service is shutting down', { Connection: 'close' });
    if (open >= maxOpen) return answer(res, 503, 'busy: too many requests, try again later');
    open += 1;
    res.once('close', () => { open -= 1; });
    try {
      await dispatch(req, res);
    } catch (e) {
      if (e instanceof BadRequest) answer(res, 400, `bad request: ${e.message}`);
      else if (e instanceof TooLarge) answer(res, 413, `request too large: at most ${MAX_REQUEST_BYTES} bytes`, { Connection: 'close' });
      else if (e instanceof Gone) res.destroy();
      else {
        console.error(`[tmuxifier] agent mail listener: ${e.message}`);
        answer(res, 500, 'internal error');
      }
    }
  }

  async function listen() {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error('socket path too long');
    if (server) throw new Error('already listening');
    const dir = path.dirname(socketPath);
    if (fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) fs.chmodSync(dir, 0o700); // umask-proof
    try {
      if (!fs.lstatSync(socketPath).isDirectory()) fs.unlinkSync(socketPath); // stale
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const s = http.createServer((req, res) => { void onRequest(req, res); });
    s.maxConnections = maxOpen * 2; // idle keep-alive sockets included; beyond this they are refused
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(socketPath, () => { s.off('error', reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
    const st = fs.lstatSync(socketPath);
    bound = { dev: st.dev, ino: st.ino };
    server = s;
  }

  function close() {
    if (closed) return closed;
    closing = true;
    closed = (async () => {
      if (!server) return;
      const done = new Promise((resolve) => server.close(() => resolve()));
      const ending = [...held];
      for (const e of ending) e.ac.abort();
      await Promise.all(ending.map((e) => e.ended));
      server.closeAllConnections();
      await done;
      try {
        const st = fs.lstatSync(socketPath);
        if (bound && st.dev === bound.dev && st.ino === bound.ino) fs.unlinkSync(socketPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    })();
    return closed;
  }

  return {
    listen,
    close,
    lastRequestAt: () => lastAt,
    sawNonce: (n) => typeof n === 'string' && nonces.includes(n),
  };
}
