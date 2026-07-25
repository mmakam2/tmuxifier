import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, afterEach, describe } from 'vitest';
import { startFakeSmtp } from './helpers/fakeSmtp.js';
import { createMailer } from '../src/server/mailer.js';

// Same house pattern as proxmoxApi.integration.test.js: skip the TLS
// transport test outright rather than fail a run on a box without openssl.
let opensslOk = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { opensslOk = false; }

let running = null;
afterEach(async () => { if (running) { await running.close(); running = null; } });

const mailerFor = (smtp, over = {}) => createMailer({
  host: '127.0.0.1', port: smtp.port, from: 'alerts@example.com', to: 'ops@example.com',
  timeoutMs: 3000, ...over,
});

// QUIT is fire-and-forget from the client (send() returns as soon as the
// message is queued, without waiting for "221 bye"), so the server-side
// count can lag the client's resolved promise by a tick or two - poll
// briefly instead of asserting the instant send() returns.
async function waitFor(predicate, timeoutMs = 500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('send delivers a message the server accepts', async () => {
  running = await startFakeSmtp();
  const got = await mailerFor(running).send({ subject: 'CRITICAL Invoice app', text: 'HTTP 502' });
  expect(got).toEqual({ ok: true, error: null });
  expect(running.messages).toHaveLength(1);
  expect(running.messages[0].data).toContain('Subject: CRITICAL Invoice app');
  expect(running.messages[0].data).toContain('HTTP 502');
  await waitFor(() => running.quitCount === 1); // the conversation ends with QUIT, not an abandoned socket
});

test('extra headers ride along, which is what the loop guard depends on', async () => {
  running = await startFakeSmtp();
  await mailerFor(running).send({ subject: 's', text: 't', headers: { 'X-Tmuxifier-Alert': '1' } });
  expect(running.messages[0].data).toContain('X-Tmuxifier-Alert: 1');
});

test('headers land before the blank line and the body lands after it', async () => {
  running = await startFakeSmtp();
  await mailerFor(running).send({
    subject: 'ordering', text: 'this is the body', headers: { 'X-Extra': 'yes' },
  });
  const data = running.messages[0].data;
  const blankLineAt = data.indexOf('\n\n');
  expect(blankLineAt).toBeGreaterThan(-1);
  expect(data.indexOf('Subject: ordering')).toBeLessThan(blankLineAt);
  expect(data.indexOf('X-Extra: yes')).toBeLessThan(blankLineAt);
  expect(data.indexOf('this is the body')).toBeGreaterThan(blankLineAt);
});

test('a body line of a single dot is stuffed so it cannot terminate DATA early', async () => {
  running = await startFakeSmtp();
  await mailerFor(running).send({ subject: 's', text: 'before\n.\nafter' });
  expect(running.messages).toHaveLength(1);
  expect(running.messages[0].data).toContain('before');
  expect(running.messages[0].data).toContain('after');
});

test('a multiline EHLO reply (250-... then 250 ...) is read as one reply, not several', async () => {
  running = await startFakeSmtp({ multilineEhlo: true });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got).toEqual({ ok: true, error: null });
  expect(running.messages).toHaveLength(1);
});

// Deterministic (no timing/races involved) regression test for the reader
// design: a server whose EHLO reply and MAIL FROM's eventual reply land in
// ONE TCP read on the client - exactly the "two replies coalesce into a
// single chunk" risk the mailer.js design comment calls out. A reader that
// discards its buffer once it resolves the "current" reply (rather than
// keeping a byte buffer that survives across calls) would treat the
// trailing "250 ok" as EHLO's answer and then hang forever waiting for a
// MAIL FROM reply that was already consumed - it never sees the real one
// because this server intentionally never sends it again.
test('a reply that arrives already bundled with the NEXT command\'s reply is still handled correctly', async () => {
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); }
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') {
          // MAIL FROM's reply is pre-sent here, in the SAME write, so both
          // land in one TCP read - no MAIL case below replies to it again.
          sock.write('250 fake\r\n250 ok\r\n');
        } else if (cmd === 'RCPT') sock.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const got = await createMailer({
      host: '127.0.0.1', port: server.address().port, from: 'alerts@example.com',
      to: 'ops@example.com', timeoutMs: 1000,
    }).send({ subject: 's', text: 't' });
    expect(got).toEqual({ ok: true, error: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('multiple comma-separated recipients each get their own RCPT TO', async () => {
  running = await startFakeSmtp();
  const got = await mailerFor(running, { to: 'ops@example.com, alerts@example.com' })
    .send({ subject: 's', text: 't' });
  expect(got.ok).toBe(true);
  expect(running.messages[0].rcpt).toEqual([
    'RCPT TO:<ops@example.com>',
    'RCPT TO:<alerts@example.com>',
  ]);
});

test('a 5xx at EHLO returns ok:false with the code in the error', async () => {
  running = await startFakeSmtp({ failAt: 'EHLO' });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
  expect(running.messages).toHaveLength(0);
});

test('a 5xx at AUTH LOGIN returns ok:false with the code in the error', async () => {
  running = await startFakeSmtp({ failAt: 'AUTH' });
  const got = await mailerFor(running, { user: 'u', pass: 'p' }).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
  expect(running.messages).toHaveLength(0);
});

test('a 5xx at MAIL FROM returns ok:false with the code in the error', async () => {
  running = await startFakeSmtp({ failAt: 'MAIL' });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
  expect(running.messages).toHaveLength(0);
});

test('a rejected recipient (5xx at RCPT TO) returns ok:false with the code in the error', async () => {
  running = await startFakeSmtp({ failAt: 'RCPT' });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
  expect(running.messages).toHaveLength(0);
});

test('a 5xx at DATA returns ok:false with the code in the error', async () => {
  running = await startFakeSmtp({ failAt: 'DATA' });
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toContain('550');
  expect(running.messages).toHaveLength(0);
});

test('a failed send closes its socket promptly rather than leaking it until the idle timeout', async () => {
  // timeoutMs is deliberately much larger than the poll bound below: a
  // socket that only closes via the idle timer (i.e. the explicit
  // sock.destroy() in send()'s finally block was lost) would still leave
  // this test "passing" eventually, just ~10s slower - which is exactly the
  // kind of accidental safety net that hid this gap the first time round.
  // Asserting against the fake server's own close count, bounded well under
  // timeoutMs, is what makes a missing destroy() an actual failure instead
  // of a slow pass.
  running = await startFakeSmtp({ failAt: 'RCPT' });
  const got = await mailerFor(running, { timeoutMs: 10000 }).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  await waitFor(() => running.closeCount === 1, 500);
});

test('a refused connection returns ok:false rather than throwing', async () => {
  const got = await createMailer({
    host: '127.0.0.1', port: 1, from: 'a@example.com', to: 'b@example.com', timeoutMs: 1000,
  }).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(got.error).toBeTruthy();
});

test('a relay that accepts the connection and then goes silent times out rather than hanging forever', async () => {
  // Accepts the TCP connection but never sends a greeting, simulating a
  // relay wedged behind a firewall/load balancer: distinct from "refused"
  // (immediate ECONNREFUSED) and from a 5xx (an actual reply). Without
  // timeoutMs wired to the socket, this send() would hang until the caller
  // (the alert evaluation loop) itself gave up or forever.
  const silentServer = net.createServer(() => {}); // accept and say nothing
  await new Promise((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
  try {
    const got = await createMailer({
      host: '127.0.0.1', port: silentServer.address().port,
      from: 'a@example.com', to: 'b@example.com', timeoutMs: 200,
    }).send({ subject: 's', text: 't' });
    expect(got.ok).toBe(false);
    expect(got.error).toContain('timed out');
  } finally {
    await new Promise((resolve) => silentServer.close(resolve));
  }
});

test('AUTH LOGIN runs when credentials are configured', async () => {
  running = await startFakeSmtp({ requireAuth: true });
  const got = await mailerFor(running, { user: 'u', pass: 'p' }).send({ subject: 's', text: 't' });
  expect(got).toEqual({ ok: true, error: null });
  expect(running.messages).toHaveLength(1);
});

test('AUTH is required but not sent still fails against a server that enforces it', async () => {
  running = await startFakeSmtp({ requireAuth: true });
  // No user/pass configured, so the mailer never runs AUTH LOGIN; the fake
  // server refuses MAIL FROM until AUTH completes, so this must fail rather
  // than quietly deliver an unauthenticated message.
  const got = await mailerFor(running).send({ subject: 's', text: 't' });
  expect(got.ok).toBe(false);
  expect(running.messages).toHaveLength(0);
});

// startFakeSmtp only speaks plain TCP; useTls exercises a real tls.connect
// against a minimal ad-hoc TLS responder so that code path isn't dead cover.
describe.runIf(opensslOk)('createMailer useTls (real node:tls transport)', () => {
  test('send completes a full transaction over TLS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-tls-'));
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile,
      '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
    ], { stdio: 'ignore' });

    const messages = [];
    const server = tls.createServer(
      { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
      (sock) => {
        let inData = false;
        let buf = '';
        let current = { rcpt: [], data: '' };
        sock.write('220 fake tls ESMTP\r\n');
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\r\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (inData) {
              if (line === '.') {
                inData = false;
                messages.push(current);
                current = { rcpt: [], data: '' };
                sock.write('250 queued\r\n');
              } else {
                current.data += `${line}\n`;
              }
              continue;
            }
            const cmd = line.split(' ')[0].toUpperCase();
            if (cmd === 'EHLO') sock.write('250 fake\r\n');
            else if (cmd === 'MAIL') { current.from = line; sock.write('250 ok\r\n'); }
            else if (cmd === 'RCPT') { current.rcpt.push(line); sock.write('250 ok\r\n'); }
            else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
            else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          }
        });
        sock.on('error', () => {});
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // createMailer has no "trust this CA" knob (matches the brief's
    // interface) and a real relay presents a CA-signed cert, so the only
    // way to exercise useTls end-to-end against this ad-hoc self-signed test
    // cert is the same global escape hatch Node itself documents for it.
    const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const got = await createMailer({
        host: '127.0.0.1', port: server.address().port, from: 'alerts@example.com',
        to: 'ops@example.com', useTls: true, timeoutMs: 3000,
      }).send({ subject: 'tls smoke test', text: 'over TLS' });
      expect(got).toEqual({ ok: true, error: null });
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toContain('over TLS');
    } finally {
      if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
