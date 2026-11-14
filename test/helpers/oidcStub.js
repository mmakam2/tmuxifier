import { createServer } from 'node:http';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// Real node:http OIDC provider stub on 127.0.0.1:0. Routes live in the `routes`
// table (path -> (req, res, ctx)) so tests/tasks can register more endpoints.
export async function startOidcStub(initial = {}) {
  const opts = { claims: {}, discovery: {}, tokenStatus: 200, nonce: undefined, ...initial };
  const stub = { issuer: '', lastTokenRequest: null, set(o) { Object.assign(opts, o); }, routes: {} };

  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  stub.routes['/.well-known/openid-configuration'] = (req, res) => {
    json(res, 200, {
      issuer: stub.issuer,
      authorization_endpoint: `${stub.issuer}/authorize`,
      token_endpoint: `${stub.issuer}/token`,
      ...opts.discovery,
    });
  };

  stub.routes['/authorize'] = (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const nonce = q.get('nonce');
    if (nonce) opts.nonce = nonce;
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', 'c');
    back.searchParams.set('state', q.get('state') || '');
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  stub.routes['/token'] = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    stub.lastTokenRequest = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (opts.tokenStatus !== 200) return json(res, opts.tokenStatus, { error: 'boom' });
    const claims = {
      iss: stub.issuer,
      aud: 'cid',
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'you@example.com',
      email_verified: true,
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
      ...opts.claims,
    };
    const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    json(res, 200, { id_token: idToken, token_type: 'Bearer' });
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const h = stub.routes[path];
    if (!h) return json(res, 404, {});
    Promise.resolve(h(req, res, opts)).catch(() => { if (!res.headersSent) json(res, 500, {}); else res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.issuer = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return stub;
}
