import net from 'node:net';
import tls from 'node:tls';

// Hand-rolled SMTP submission, dependency-free in the spirit of googleAuth.js
// and webauthn.js. Every failure returns { ok: false, error } instead of
// throwing: a relay being down must be recorded as notify:failed, never take
// down the alert-evaluation loop.

// An SMTP reply status line (RFC 5321 4.2.1): 3 digits then '-' (more lines
// of this reply follow) or ' ' (this is the final line).
const REPLY_LINE = /^(\d{3})([ -])/;

// One persistent 'data' listener for the life of the connection, feeding a
// byte buffer that survives across replies. A listener attached fresh per
// reply and torn down once that reply resolves - the obvious-looking
// approach - is unsafe on a real net.Socket for two reasons:
//   1. The first 'data' listener switches a socket into flowing mode for
//      good. Once flowing, bytes that arrive while zero 'data' listeners are
//      attached are DROPPED, not queued (see Node's stream docs, "three
//      states"): removing the last listener does not fall back to paused
//      mode, so any gap between one reply's cleanup and the next reply's
//      attach is a silent-loss window.
//   2. A single TCP read can hand back more than one reply's worth of bytes
//      (multiline replies are one example; a relay answering faster than we
//      drain the socket is another). Throwing away the reader's buffer the
//      moment a reply resolves discards bytes the NEXT reply needs.
// A shared buffer plus a FIFO of waiters sidesteps both: the listener never
// moves, and leftover bytes stay put for whoever asks next.
function createReplyReader(sock) {
  let buf = '';
  const waiting = [];
  let fatal = null;

  function nextReplyEnd() {
    let from = 0;
    for (;;) {
      const eol = buf.indexOf('\r\n', from);
      if (eol === -1) return -1;
      const m = REPLY_LINE.exec(buf.slice(from, eol));
      if (m && m[2] === '-') { from = eol + 2; continue; } // "250-..." - more lines coming
      if (m) return eol + 2; // "250 ..." - final line of this reply
      from = eol + 2; // not a reply line (defensive) - skip and keep scanning
    }
  }

  function drain() {
    while (waiting.length) {
      const end = nextReplyEnd();
      if (end === -1) return;
      const raw = buf.slice(0, end);
      buf = buf.slice(end);
      waiting.shift()(null, raw);
    }
  }

  function fail(err) {
    if (fatal) return; // already delivered to every waiter
    fatal = err;
    while (waiting.length) waiting.shift()(err, null);
  }

  sock.on('data', (chunk) => { buf += chunk.toString('utf8'); drain(); });
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('smtp connection closed')));

  return function readReply(expect) {
    return new Promise((resolve, reject) => {
      if (fatal) { reject(fatal); return; }
      waiting.push((err, raw) => {
        if (err) { reject(err); return; }
        const lastLine = raw.trimEnd().split('\r\n').pop();
        if (expect.includes(lastLine[0])) resolve(lastLine);
        else reject(new Error(lastLine));
      });
      drain(); // bytes for this reply may already be sitting in buf
    });
  };
}

export function createMailer({
  host, port = 25, from, to, user = null, pass = null, useTls = false, timeoutMs = 15000,
}) {
  return {
    async send({ subject, text, headers = {} }) {
      let sock;
      try {
        sock = await new Promise((resolve, reject) => {
          const connectOpts = { host, port };
          // SNI forbids IP literals (RFC 6066); only send servername for
          // real hostnames, which is all a real relay ever needs it for.
          if (useTls && !net.isIP(host)) connectOpts.servername = host;
          const s = (useTls ? tls : net).connect(connectOpts, () => resolve(s));
          s.setTimeout(timeoutMs, () => s.destroy(new Error('smtp timed out')));
          s.once('error', reject);
        });

        const readReply = createReplyReader(sock);
        const say = async (line, expect = ['2', '3']) => {
          sock.write(`${line}\r\n`);
          return readReply(expect);
        };

        await readReply(['2']); // greeting
        await say('EHLO tmuxifier');
        if (user && pass) {
          await say('AUTH LOGIN');
          await say(Buffer.from(user, 'utf8').toString('base64'));
          await say(Buffer.from(pass, 'utf8').toString('base64'));
        }
        await say(`MAIL FROM:<${from}>`);
        const recipients = String(to).split(',').map((r) => r.trim()).filter(Boolean);
        for (const rcpt of recipients) {
          await say(`RCPT TO:<${rcpt}>`);
        }
        await say('DATA', ['3']);

        const head = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ].join('\r\n');
        // Dot-stuffing (RFC 5321 4.5.2): a body line that is exactly "."
        // (or starts with one) would otherwise read to the server as the
        // end-of-DATA marker, truncating the message early.
        const body = String(text).split('\n')
          .map((line) => line.replace(/\r$/, ''))
          .map((line) => (line.startsWith('.') ? `.${line}` : line))
          .join('\r\n');
        sock.write(`${head}\r\n\r\n${body}\r\n.\r\n`);
        await readReply(['2']);

        sock.write('QUIT\r\n');
        return { ok: true, error: null };
      } catch (e) {
        return { ok: false, error: e?.message || 'smtp send failed' };
      } finally {
        try { sock?.destroy(); } catch { /* already gone */ }
      }
    },
  };
}
