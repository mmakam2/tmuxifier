import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAgentMailListener } from '../src/server/agentMailListener.js';
import { refusalText } from '../src/server/agentMailText.js';
import { createMailHarness, O, mark } from './helpers/agentMailHarness.js';

// The per-box mail listener over a real unix socket, in front of the real hub from the harness.
// `counted` wraps the hub's request methods in pass-throughs that record each call (and the
// signal a held call was given), so a test can prove a request never reached the hub.

const HUB_CALLS = ['who', 'send', 'reply', 'read', 'inbox', 'waitMail', 'waitReplies', 'ack'];

function counted(hub) {
  const calls = [];
  const signals = [];
  const wrapped = { ...hub };
  for (const name of HUB_CALLS) {
    wrapped[name] = (...args) => {
      calls.push(name);
      if (name === 'waitMail') signals.push(args[2]);
      if (name === 'waitReplies') signals.push(args[3]);
      return hub[name](...args);
    };
  }
  return { hub: wrapped, calls, signals };
}

// One HTTP request over the socket. `form` is an object sent form-encoded; `body` raw.
function request(socketPath, method, urlPath, { form, body, headers = {}, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    let payload = body;
    const h = { ...headers };
    if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      h['Content-Type'] ??= 'application/x-www-form-urlencoded';
    }
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ socketPath, method, path: urlPath, headers: h, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// A request whose connection the test can drop: resolves with the client request object.
function openHeld(socketPath, urlPath) {
  const req = http.request({ socketPath, method: 'GET', path: urlPath, agent: false });
  req.on('error', () => {});
  const response = new Promise((resolve) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  req.end();
  return { req, response };
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let h; let dir; let sock; let listener; let c; let extra;

beforeEach(async () => {
  h = await createMailHarness({ holdMs: 60_000 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmx-l-'));
  sock = path.join(dir, 'mail', 'o.sock');
  c = counted(h.hub);
  listener = createAgentMailListener({ hub: c.hub, boxId: 'o', socketPath: sock });
  extra = [];
});
afterEach(async () => {
  for (const l of [listener, ...extra]) await l.close();
  await h.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p, opts) => request(sock, 'GET', p, opts);
const post = (p, form, opts) => request(sock, 'POST', p, { form, ...opts });

describe('agentMailListener: the socket', () => {
  test('the socket file is 0600 in a 0700 directory and close removes it', async () => {
    await listener.listen();
    const st = fs.lstatSync(sock);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
    expect((await get('/v1/ping')).text).toBe('ok\n');
    await listener.close();
    expect(fs.existsSync(sock)).toBe(false);
  });

  test('a path over 107 bytes is refused before listening', async () => {
    const parent = path.join(dir, 'never');
    const long = path.join(parent, 'x'.repeat(108 - parent.length - 1));
    expect(Buffer.byteLength(long)).toBe(108);
    const l = createAgentMailListener({ hub: c.hub, boxId: 'o', socketPath: long });
    await expect(l.listen()).rejects.toThrow('socket path too long');
    expect(fs.existsSync(parent)).toBe(false); // nothing on disk changed

    const fits = path.join(parent, 'x'.repeat(107 - parent.length - 1));
    expect(Buffer.byteLength(fits)).toBe(107);
    const ok = createAgentMailListener({ hub: c.hub, boxId: 'o', socketPath: fits });
    extra.push(ok);
    await ok.listen();
    expect((await request(fits, 'GET', '/v1/ping')).status).toBe(200);
  });

  test('a stale socket file is replaced', async () => {
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sock, 'left over');
    await listener.listen();
    expect(fs.lstatSync(sock).isSocket()).toBe(true);
    expect((await get('/v1/ping')).status).toBe(200);
  });

  test('close does not hang on a held request, a keep-alive connection or a half-sent request', async () => {
    await listener.listen();
    const held = openHeld(sock, '/v1/wait?session=main&pane=%251');
    await until(() => h.hub.listening('o').main === 1);
    const agent = new http.Agent({ keepAlive: true });
    expect((await get('/v1/ping', { agent })).status).toBe(200); // leaves an idle keep-alive socket
    const half = net.connect(sock);
    half.on('error', () => {});
    half.write('POST /v1/threads HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 50\r\n\r\nsess');
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await listener.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await held.response).status).toBe(204); // ended with the hub's idle answer
    expect(h.hub.listening('o')).toEqual({});
    expect(fs.existsSync(sock)).toBe(false);
    agent.destroy();
    half.destroy();
  });
});

describe('agentMailListener: requests', () => {
  beforeEach(async () => { await listener.listen(); });

  test('ping records the nonce', async () => {
    await get('/v1/ping?n=0123456789abcdef');
    expect(listener.sawNonce('0123456789abcdef')).toBe(true);
    expect(listener.sawNonce('ffffffffffffffff')).toBe(false);
  });

  test('ping keeps the last 8 nonces, refuses a malformed one, and every request counts as seen', async () => {
    expect(listener.lastRequestAt()).toBe(0);
    const before = Date.now();
    const nonces = Array.from({ length: 9 }, (_, i) => `00000000000000${String(i).padStart(2, '0')}`);
    for (const n of nonces) expect((await get(`/v1/ping?n=${n}`)).status).toBe(200);
    expect(listener.sawNonce(nonces[0])).toBe(false);
    for (const n of nonces.slice(1)) expect(listener.sawNonce(n)).toBe(true);
    expect(listener.lastRequestAt()).toBeGreaterThanOrEqual(before);

    const r = await get('/v1/ping?n=0123456789ABCDEF');
    expect(r.status).toBe(400);
    expect(listener.sawNonce('0123456789ABCDEF')).toBe(false);
    const at = listener.lastRequestAt();
    await new Promise((res) => setTimeout(res, 5));
    await get('/v1/nope');
    expect(listener.lastRequestAt()).toBeGreaterThan(at);
  });

  test('send over HTTP: form-encoded target with a space and a UTF-8 body round-trip', async () => {
    h.boxes[1].label = 'billing team';
    const body = 'héllo — 世界 🎉\nline two & a=b+c%';
    const r = await post('/v1/threads', { session: 'main', to: 'billing team/main', body });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    const [thread] = h.store.threads();
    expect(thread.messages[0].body).toBe(body);
    expect(thread.starter).toEqual({ boxId: 'o', session: 'main' });
    expect(thread.peer).toEqual({ boxId: 'b', session: 'main' });
    expect(r.text).toBe(`Sent. Thread ${thread.id}. queued: billing team/main is working\n`);

    // the reply and read routes, from the other side's hub view
    const back = await h.hub.reply({ boxId: 'b', session: 'main' }, thread.id, 'ok 👍');
    expect(back.ok).toBe(true);
    const read = await get(`/v1/threads/${thread.id}?session=main`);
    expect(read.status).toBe(200);
    expect(read.text).toContain('ok 👍');
    expect(read.text.endsWith('\n') && !read.text.endsWith('\n\n')).toBe(true);
    const reply = await post(`/v1/threads/${thread.id}/messages`, { session: 'main', body: 'thanks' });
    expect(reply.status).toBe(200);
    expect(h.store.thread(thread.id).messages.map((m) => m.body)).toEqual([body, 'ok 👍', 'thanks']);
  });

  test('a refused send is 403 with the reason as text', async () => {
    const r = await post('/v1/threads', { session: 'main', to: 'nowhere', body: 'hi' });
    expect(r.status).toBe(403);
    expect(r.text).toBe(`${refusalText('unknown-box', { target: 'nowhere' })}\n`);
    expect(h.store.threads()).toEqual([]);

    // the caller's box comes from the listener, never the request: a boxId field changes nothing,
    // so `orders` is still this session's own
    const own = await post('/v1/threads', { session: 'main', to: 'orders', body: 'hi', boxId: 'b' });
    expect(own.status).toBe(403);
    expect(own.text).toBe(`${refusalText('own-session')}\n`);
  });

  test('who, inbox and a read by a non-participant answer with the hub text', async () => {
    const who = await get('/v1/who?session=main');
    expect(who.status).toBe(200);
    expect(who.text).toContain('billing');
    const notRunning = await get('/v1/who?session=other');
    expect(notRunning.status).toBe(403);
    expect(notRunning.text).toBe(`${refusalText('no-agent', { who: 'orders/other' })}\n`);
    const inbox = await get('/v1/inbox?session=main');
    expect(inbox.status).toBe(200);
    const read = await get('/v1/threads/t-abcdefgh?session=main');
    expect(read.status).toBe(403);
    expect(read.text).toBe(`${refusalText('not-a-participant')}\n`);
  });

  test('wait returns 200 with the tagged text when mail is handed, and 204 when the hold expires', async () => {
    h.marks.o.main = mark('ready');
    h.marks.b.main = mark('ready');
    await h.setPolicy('b', { receive: true, receiveFrom: ['o'], send: true, sendTo: ['o'] });
    await h.setPolicy('o', { send: true, sendTo: ['b'], receive: true, receiveFrom: ['b'] });
    const held = openHeld(sock, '/v1/wait?session=main&pane=%251');
    await until(() => h.hub.listening('o').main === 1);
    const s = await h.hub.send({ boxId: 'b', session: 'main' }, 'orders', 'please check');
    const r = await held.response;
    expect(r.status).toBe(200);
    const m = h.store.thread(s.threadId).messages[0];
    expect(r.text.startsWith(`[tmuxifier-mail ${m.id}]`)).toBe(true);
    expect(r.text).toContain('please check');
    expect(m.state).toBe('handed');
    await new Promise((res) => setTimeout(res, 50)); // the server has closed that connection by now
    expect(c.signals[0].aborted).toBe(false); // a completed response is not an abort

    const ack = await post('/v1/ack', { session: 'main', m: m.id });
    expect(ack.status).toBe(200);
    expect(ack.text).toBe('ok\n');
    expect(h.store.thread(s.threadId).messages[0].state).toBe('delivered');
    const again = await post('/v1/ack', { session: 'main', m: m.id });
    expect(again.status).toBe(404);

    // a hub with a short hold, behind a second listener
    const quick = createAgentMailListener({ hub: h.makeHub({ holdMs: 100 }), boxId: 'o', socketPath: path.join(dir, 'q.sock') });
    extra.push(quick);
    await quick.listen();
    const idle = await request(path.join(dir, 'q.sock'), 'GET', '/v1/wait?session=main&pane=%252');
    expect(idle.status).toBe(204);
    expect(idle.text).toBe('');
    expect(idle.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  test('a dropped connection on /v1/wait stops counting as a listener', async () => {
    const held = openHeld(sock, '/v1/wait?session=main&pane=%251');
    await until(() => h.hub.listening('o').main === 1);
    expect(c.signals[0].aborted).toBe(false);
    held.req.destroy();
    await until(() => c.signals[0].aborted);
    await until(() => h.hub.listening('o').main === undefined);
    // the listener is still serving
    expect((await get('/v1/ping')).status).toBe(200);
  });

  test('a dropped connection on /v1/replies aborts its signal', async () => {
    const s = await h.hub.send(O, 'billing', 'q');
    const held = openHeld(sock, `/v1/replies?session=main&threads=${s.threadId}&timeout=60`);
    await until(() => c.signals.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.signals[0].aborted).toBe(false);
    held.req.destroy();
    await until(() => c.signals[0].aborted);
  });

  test('replies timeout is 200 with X-Mail: none', async () => {
    const s = await h.hub.send(O, 'billing', 'q');
    const r = await get(`/v1/replies?session=main&threads=${s.threadId}&timeout=1`);
    expect(r.status).toBe(200);
    expect(r.headers['x-mail']).toBe('none');
    expect(r.text).toBe(`thread ${s.threadId}: queued: billing/main is working\n`);
    await new Promise((res) => setTimeout(res, 50));
    expect(c.signals[0].aborted).toBe(false);
  });

  test('replies with a reply is 200 without X-Mail', async () => {
    const s = await h.hub.send(O, 'billing', 'q');
    const held = openHeld(sock, `/v1/replies?session=main&threads=${s.threadId}&timeout=60`);
    await until(() => c.signals.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await h.hub.reply({ boxId: 'b', session: 'main' }, s.threadId, 'answer');
    const r = await held.response;
    expect(r.status).toBe(200);
    expect(r.headers['x-mail']).toBeUndefined();
    expect(r.text).toContain('answer');
    await new Promise((res) => setTimeout(res, 50));
    expect(c.signals[0].aborted).toBe(false);
  });

  test('bad session, bad pane, bad thread id, 17 thread ids are 400 and never reach the hub', async () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `t-${'abcdefghjkmnpqrst'[i]}bcdefgh`).join(',');
    const bad = [
      ['GET', '/v1/who'],
      ['GET', '/v1/who?session='],
      ['GET', '/v1/who?session=a%20b'],
      ['GET', '/v1/who?session=x;rm'],
      ['GET', `/v1/who?session=${'a'.repeat(65)}`],
      ['GET', '/v1/who?session=main&session=other'],
      ['GET', '/v1/inbox?session=%C3%A9'],
      ['GET', '/v1/inbox?session=%FF'],
      ['GET', '/v1/wait?session=main'],
      ['GET', '/v1/wait?session=main&pane=1'],
      ['GET', '/v1/wait?session=main&pane=%25x'],
      ['GET', '/v1/wait?session=main&pane=%251234567890'],
      ['GET', '/v1/wait?session=bad.name&pane=%251'],
      ['GET', '/v1/threads/t-ABCDEFGH?session=main'],
      ['GET', '/v1/threads/t-abcdefgi?session=main'],
      ['GET', '/v1/threads/m-abcdefgh?session=main'],
      ['GET', `/v1/replies?session=main&threads=${ids(17)}&timeout=5`],
      ['GET', '/v1/replies?session=main&threads=t-abcdefgh,,t-bbcdefgh&timeout=5'],
      ['GET', '/v1/replies?session=main&threads=t-abcdefgi&timeout=5'],
      ['GET', '/v1/replies?session=main&threads=&timeout=5'],
      ['GET', '/v1/replies?session=main&threads=t-abcdefgh'],
      ['GET', '/v1/replies?session=main&threads=t-abcdefgh&timeout=-1'],
      ['GET', '/v1/replies?session=main&threads=t-abcdefgh&timeout=1.5'],
      ['GET', '/v1/ping?n=xyz'],
    ];
    for (const [method, p] of bad) {
      const r = await request(sock, method, p);
      expect(r.status, p).toBe(400);
      expect(r.text, p).toMatch(/^bad request: [^\n]+\n$/);
    }
    const badPosts = [
      ['/v1/threads/t-ABCDEFGH/messages', { session: 'main', body: 'x' }],
      ['/v1/threads', { session: 'a b', to: 'billing', body: 'x' }],
      ['/v1/threads', { to: 'billing', body: 'x' }],
      ['/v1/ack', { session: 'main', m: 'm-ABCDEFGH' }],
      ['/v1/ack', { session: 'main' }],
    ];
    for (const [p, form] of badPosts) {
      const r = await post(p, form);
      expect(r.status, p).toBe(400);
    }
    // a POST takes its parameters in a form body, in UTF-8, and nowhere else
    const encodings = [
      { body: 'session=main&body=%FF', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { body: 'session=main&body=%E', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { body: Buffer.concat([Buffer.from('session=main&body='), Buffer.from([0xc3, 0x28])]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      { body: 'session=main&body=hi', headers: { 'Content-Type': 'text/plain' } },
      { body: 'session=main&body=hi', headers: {} },
    ];
    for (const opts of encodings) {
      const r = await request(sock, 'POST', '/v1/threads', opts);
      expect(r.status, String(opts.body)).toBe(400);
    }
    expect((await post('/v1/threads?x=1', { session: 'main', to: 'billing', body: 'x' })).status).toBe(400);
    expect((await get('/v1/inbox?session=main', { body: 'x' })).status).toBe(400);
    expect(c.calls).toEqual([]);
    expect(h.store.refusals()).toEqual([]);

    // the same requests made well do reach it: 16 thread ids is the limit, not 15
    const r16 = await get(`/v1/replies?session=main&threads=${ids(16)}&timeout=5`);
    expect(r16.status).toBe(200);
    expect(r16.headers['x-mail']).toBe('none');
    const charset = await request(sock, 'POST', '/v1/threads', {
      body: 'session=main&to=billing&body=hi',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    });
    expect(charset.status).toBe(200);
    expect(c.calls).toEqual(['waitReplies', 'send']);
  });

  test('an oversized request body is 413', async () => {
    // 262144 bytes on the wire is still read (and reaches the hub, which refuses the body size)
    const head = 'session=main&to=billing&body=';
    const atLimit = head + 'a'.repeat(262144 - head.length);
    const r1 = await request(sock, 'POST', '/v1/threads', { body: atLimit, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(r1.status).toBe(403);
    expect(r1.text).toBe(`${refusalText('too-large')}\n`);
    expect(c.calls).toEqual(['send']);

    const over = atLimit + 'a';
    const r2 = await request(sock, 'POST', '/v1/threads', { body: over, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(r2.status).toBe(413);
    // The limit it names is the one a sender can act on: the message's, not the wire's.
    expect(r2.text).toBe('request too large: a message is at most 65536 bytes\n');

    // chunked, with no length declared: counted as it arrives
    const r3 = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/threads', agent: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      for (let i = 0; i < 9; i++) req.write('a'.repeat(32768));
      req.end();
    });
    expect(r3).toBe(413);
    expect(c.calls).toEqual(['send']);
  });

  test('the 65th open request and the 33rd held request get 503', async () => {
    const helds = [];
    for (let i = 1; i <= 32; i++) helds.push(openHeld(sock, `/v1/wait?session=main&pane=%25${i}`));
    await until(() => h.hub.listening('o').main === 32);
    const third = await get('/v1/wait?session=main&pane=%2533');
    expect(third.status).toBe(503);
    expect(third.text).toMatch(/^[^\n]+\n$/);
    expect((await get(`/v1/replies?session=main&threads=t-abcdefgh&timeout=5`)).status).toBe(503);
    expect(h.hub.listening('o').main).toBe(32);

    // 32 more requests that stay open: POSTs whose body never finishes arriving
    const halves = [];
    for (let i = 0; i < 32; i++) {
      const s = net.connect(sock);
      s.on('error', () => {});
      s.write('POST /v1/threads HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 50\r\n\r\nsess');
      halves.push(s);
    }
    await until(async () => (await get('/v1/ping')).status === 503);
    const r = await get('/v1/inbox?session=main');
    expect(r.status).toBe(503);

    // one of them ending frees a slot
    halves.pop().destroy();
    await until(async () => (await get('/v1/ping')).status === 200);
    for (const s of halves) s.destroy();
    for (const x of helds) x.req.destroy();
    await until(() => h.hub.listening('o').main === undefined);
  });

  test('unknown path and method are 404', async () => {
    const cases = [
      ['GET', '/'],
      ['GET', '/v1'],
      ['GET', '/v1/nope'],
      ['GET', '/v2/ping'],
      ['GET', '/v1/ping/'],
      ['DELETE', '/v1/inbox?session=main'],
      ['POST', '/v1/inbox'],
      ['GET', '/v1/threads?session=main'],
      ['PUT', '/v1/threads'],
      ['HEAD', '/v1/ping'],
      ['GET', '/v1/ack?session=main&m=m-abcdefgh'],
      ['POST', '/v1/threads/t-abcdefgh'],
      ['GET', '/v1/threads/t-abcdefgh/messages?session=main'],
      ['GET', '/v1/threads/t-abcdefgh/x?session=main'],
    ];
    for (const [method, p] of cases) {
      const r = await request(sock, method, p);
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    }
    expect(c.calls).toEqual([]);
  });
});
