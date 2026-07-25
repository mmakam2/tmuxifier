import net from 'node:net';

// A real socket server speaking just enough SMTP to accept a message. Used
// instead of a mock so the mailer is exercised over an actual TCP
// conversation - including whatever chunking/coalescing a real socket does,
// which a mock can't reproduce. Reused by Task 21.
export async function startFakeSmtp({ requireAuth = false, failAt = null, multilineEhlo = false } = {}) {
  const messages = [];
  let quitCount = 0; // proof the client actually said goodbye, not just abandoned the socket
  let closeCount = 0; // proof a failed send closes its socket promptly, not just eventually
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    let current = { rcpt: [], data: '' };
    // AUTH LOGIN's two continuation lines (base64 username, then base64
    // password) arrive as plain text, not as SMTP commands - authStep
    // tracks which one is expected next, and MAIL FROM is refused until it
    // completes. Without this gate a client that silently skipped AUTH would
    // sail straight through to MAIL FROM against this fake server, and the
    // "AUTH runs when credentials are configured" test would never notice.
    let authStep = 0; // 0 = idle, 1 = awaiting base64 username, 2 = awaiting base64 password
    let authed = false;
    sock.write('220 fake ESMTP\r\n');
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
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (authStep === 2) { authStep = 0; authed = true; sock.write('235 ok\r\n'); continue; }
        const cmd = line.split(' ')[0].toUpperCase();
        if (failAt && cmd === failAt) { sock.write('550 refused\r\n'); continue; }
        if (cmd === 'EHLO') {
          if (multilineEhlo) sock.write('250-fake\r\n250-PIPELINING\r\n250 8BITMIME\r\n');
          else sock.write(requireAuth ? '250-fake\r\n250 AUTH LOGIN\r\n' : '250 fake\r\n');
        } else if (cmd === 'AUTH') { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (cmd === 'MAIL') {
          if (requireAuth && !authed) sock.write('530 authentication required\r\n');
          else { current.from = line; sock.write('250 ok\r\n'); }
        } else if (cmd === 'RCPT') { current.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { quitCount += 1; sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 unrecognized command\r\n');
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { closeCount += 1; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    messages,
    get quitCount() { return quitCount; },
    get closeCount() { return closeCount; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
