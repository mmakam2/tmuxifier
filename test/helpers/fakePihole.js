import http from 'node:http';

// A real HTTP server speaking the Pi-hole v6 envelope, so the client tests
// exercise the actual request path (no mocks — the repo convention). Every
// knob a test needs to steer is an option; counters let tests assert how many
// times the client authenticated.
export async function startFakePihole({
  password = 'app-pw',
  validity = 1800,
  totp = false,
  expireSidAfter = Infinity, // reject this many uses in, forcing a 401 + re-auth
  summary = null,
  version = null,
  system = null,
  blocking = null,
  delayMs = 0,
  malformed = false,
} = {}) {
  const counts = { auth: 0, delete: 0, summary: 0, version: 0, system: 0, blocking: 0 };
  let issued = 0;
  let uses = 0;
  const sids = new Set();

  const send = (res, status, body) => {
    const payload = malformed ? '{not json' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/api/auth' && req.method === 'POST') {
      counts.auth++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let given = null;
        try { given = JSON.parse(raw).password; } catch { /* malformed body */ }
        if (totp) {
          send(res, 401, { session: { valid: false, totp: true, sid: null, validity: -1, message: 'no password or TOTP token supplied' } });
          return;
        }
        if (given !== password) {
          send(res, 401, { session: { valid: false, totp: false, sid: null, validity: -1, message: 'password incorrect' } });
          return;
        }
        const sid = `sid-${++issued}`;
        sids.add(sid);
        send(res, 200, { session: { valid: true, totp: false, sid, csrf: 'csrf', validity, message: 'password correct' } });
      });
      return;
    }

    if (path === '/api/auth' && req.method === 'DELETE') {
      counts.delete++;
      sids.delete(req.headers['x-ftl-sid']);
      res.writeHead(204).end();
      return;
    }

    const sid = req.headers['x-ftl-sid'];
    if (!sid || !sids.has(sid) || ++uses > expireSidAfter) {
      send(res, 401, { error: { key: 'unauthorized', message: 'Unauthorized', hint: null } });
      return;
    }

    const reply = (key, body) => {
      counts[key]++;
      if (delayMs) setTimeout(() => send(res, 200, body), delayMs);
      else send(res, 200, body);
    };

    if (path === '/api/stats/summary') return reply('summary', summary ?? DEFAULT_SUMMARY);
    if (path === '/api/info/version') return reply('version', version ?? DEFAULT_VERSION);
    if (path === '/api/info/system') return reply('system', system ?? DEFAULT_SYSTEM);
    if (path === '/api/dns/blocking') return reply('blocking', blocking ?? DEFAULT_BLOCKING);
    send(res, 404, { error: { key: 'not_found', message: 'Not found' } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    async stop() { await new Promise((resolve) => server.close(resolve)); },
  };
}

export const DEFAULT_SUMMARY = {
  queries: { total: 48132, blocked: 10780, percent_blocked: 22.396, unique_domains: 3412, forwarded: 30012, cached: 7340 },
  clients: { active: 31, total: 54 },
  gravity: { domains_being_blocked: 1284933, last_update: 1753000000 },
};
export const DEFAULT_VERSION = {
  version: {
    core: { local: { version: 'v6.2.1' }, remote: { version: 'v6.2.1' } },
    web: { local: { version: 'v6.2' }, remote: { version: 'v6.2' } },
    ftl: { local: { version: 'v6.2.3' }, remote: { version: 'v6.2.3' } },
  },
};
export const DEFAULT_SYSTEM = { system: { uptime: 1220400, procs: 210 } };
export const DEFAULT_BLOCKING = { blocking: 'enabled', timer: null };
