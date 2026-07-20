#!/usr/bin/env node
// Stands in for whisper-server in e2e runs: same argv contract (--host/--port),
// same /inference response shape, no model and no compiler required.
//
// The engine (voiceEngine.js) decides readiness by probing the port with a
// plain HTTP request — never by reading stdout, which the real whisper-server
// binary never writes to at all. So this fixture must bind its port and
// answer *something* on every path, including '/': a 404 there is exactly
// what the real binary does too, and the engine treats any HTTP response
// (not just 2xx) as "ready". A fixture that only answered on /inference would
// leave the engine polling forever on a real deployment's actual behavior,
// so this deliberately mirrors that shape rather than taking a shortcut.
import http from 'node:http';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const host = argv[argv.indexOf('--host') + 1] || '127.0.0.1';

// The real whisper-server's /inference response carries a leading space and a
// trailing newline (verified live against whisper.cpp v1.9.1:
// {"text":" (beep)\n"}). Matching that shape here — rather than returning
// already-clean text — means the e2e assertion actually exercises
// normalizeTranscript's stripping instead of trivially passing on input that
// needed no normalization.
const text = process.env.FAKE_WHISPER_TEXT ?? ' hello from the fixture\n';

http.createServer((req, res) => {
  if (!req.url.startsWith('/inference')) { res.writeHead(404).end(); return; }
  // Drain the multipart body so the client's write always completes.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
  });
}).listen(port, host, () => {
  console.log(`whisper server listening at http://${host}:${port}`);
});
