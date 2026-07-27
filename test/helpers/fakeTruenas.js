import { WebSocketServer } from 'ws';

// A real WebSocket server speaking JSON-RPC 2.0 the way TrueNAS middleware does,
// so the client tests exercise the actual socket path (no mocks — the repo
// convention). Every knob a test needs to steer is an option; counters let tests
// assert how many times the client authenticated or reconnected.
export async function startFakeTruenas({
  username = 'truenas_admin',
  apiKey = '1-testkey',
  responseType = null,         // force an auth response_type other than SUCCESS
  pools = null,
  info = null,
  alerts = null,
  expireAfterCalls = Infinity, // data calls to answer before the session "dies"
  malformed = false,           // reply with an unparseable frame
} = {}) {
  const counts = { login: 0, logout: 0, pool: 0, info: 0, alert: 0, connections: 0 };

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/current' });

  wss.on('connection', (socket) => {
    counts.connections++;
    let authed = false;
    let dataCalls = 0;

    const reply = (id, result) => {
      socket.send(malformed ? '{not json' : JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const replyError = (id, message, code = -32000) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    };

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const { id, method, params } = msg;

      if (method === 'auth.login_ex') {
        counts.login++;
        const p = params?.[0] ?? {};
        if (responseType) return reply(id, { response_type: responseType });
        if (p.mechanism !== 'API_KEY_PLAIN') return reply(id, { response_type: 'AUTH_ERR' });
        if (p.username !== username || p.api_key !== apiKey) return reply(id, { response_type: 'AUTH_ERR' });
        authed = true;
        dataCalls = 0;
        return reply(id, { response_type: 'SUCCESS' });
      }

      if (method === 'auth.logout') {
        counts.logout++;
        authed = false;
        return reply(id, true);
      }

      if (!authed) return replyError(id, 'Not authenticated');
      if (++dataCalls > expireAfterCalls) { authed = false; return replyError(id, 'Not authenticated'); }

      if (method === 'pool.query') { counts.pool++; return reply(id, pools ?? DEFAULT_POOLS); }
      if (method === 'system.info') { counts.info++; return reply(id, info ?? DEFAULT_INFO); }
      if (method === 'alert.list') { counts.alert++; return reply(id, alerts ?? DEFAULT_ALERTS); }
      return replyError(id, `Unknown method ${method}`, -32601);
    });
  });

  await new Promise((resolve) => wss.on('listening', resolve));
  const { port } = wss.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    get wssClients() { return [...wss.clients]; },
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

export const DEFAULT_POOLS = [
  { name: 'tank', size: 21990232555520, allocated: 14953089105920, free: 7037143449600, healthy: true, status: 'ONLINE', scan: null },
  { name: 'fast', size: 1000204886016, allocated: 310063534080, free: 690141351936, healthy: true, status: 'ONLINE', scan: null },
];
export const DEFAULT_INFO = { version: '25.10.5', uptime_seconds: 3563000, hostname: 'nas' };
export const DEFAULT_ALERTS = [
  { level: 'WARNING', dismissed: false, text: 'Scrub is overdue' },
  { level: 'INFO', dismissed: false, text: 'Informational only' },
  { level: 'CRITICAL', dismissed: true, text: 'Already acknowledged' },
];
