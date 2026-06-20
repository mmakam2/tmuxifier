import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { verifyPassword, COOKIE_NAME, cookieOptions } from './auth.js';
import { createGoogleAuth, pkcePair, randomState } from './googleAuth.js';

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : String(value || '').split(',')[0].trim();
}

function requestHostOrigins(req) {
  const host = firstHeaderValue(req.headers?.host);
  if (!host) return [];
  return [`http://${host}`, `https://${host}`];
}

export function buildServer({ config, store, sessions, statusChecker, boxActions, googleAuth }) {
  const httpsOpts =
    config.tlsCert && config.tlsKey
      ? { https: { key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert) } }
      : {};
  const app = Fastify({ logger: false, ...httpsOpts });
  app.register(cookie, { secret: config.cookieSecret });
  app.register(websocket);

  const OAUTH_COOKIE = 'tmuxifier_oauth';
  let google = googleAuth;
  if (config.authMode === 'google' && !google) {
    google = createGoogleAuth({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${String(config.publicUrl).replace(/\/+$/, '')}/api/auth/google/callback`,
      allowedEmails: config.allowedEmails,
    });
  }

  const attempts = new Map(); // ip -> { count, ts } simple rate-limit

  function allowedOrigins(req) {
    const origins = new Set(requestHostOrigins(req));
    const publicOrigin = originOf(config.publicUrl);
    if (publicOrigin) origins.add(publicOrigin);
    return origins;
  }

  function hasTrustedOrigin(req) {
    const origin = firstHeaderValue(req.headers?.origin);
    if (!origin) return true;
    const normalized = originOf(origin);
    return !!normalized && allowedOrigins(req).has(normalized);
  }

  function requireTrustedOrigin(req, reply, done) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || hasTrustedOrigin(req)) {
      done();
      return;
    }
    reply.code(403).send({ error: 'forbidden origin' });
  }

  app.addHook('onRequest', requireTrustedOrigin);
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (String(config.publicUrl || '').toLowerCase().startsWith('https://')) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (req.raw.url?.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  function isAuthed(req) {
    // Primary: use req.cookies if populated (normal case)
    const raw = req.cookies?.[COOKIE_NAME];
    if (raw) {
      const r = app.unsignCookie(raw);
      return r.valid && r.value === 'ok';
    }
    // Fallback: parse cookie header manually (needed for WS with @fastify/websocket v10)
    const cookieHeader = req.headers?.cookie;
    if (!cookieHeader) return false;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      if (name === COOKIE_NAME) {
        const value = decodeURIComponent(trimmed.slice(eqIdx + 1).trim());
        const r = app.unsignCookie(value);
        return r.valid && r.value === 'ok';
      }
    }
    return false;
  }
  function requireAuth(req, reply, done) {
    if (!isAuthed(req)) { reply.code(401).send({ error: 'unauthorized' }); return; }
    done();
  }

  app.get('/api/auth/info', async () => ({ mode: config.authMode === 'google' ? 'google' : 'password' }));

  if (config.authMode !== 'google') {
    app.post('/api/login', async (req, reply) => {
      const ip = req.ip;
      const rec = attempts.get(ip) || { count: 0, ts: Date.now() };
      if (Date.now() - rec.ts > 60000) { rec.count = 0; rec.ts = Date.now(); }
      if (rec.count >= 10) return reply.code(429).send({ error: 'too many attempts' });
      if (attempts.size > 1000) attempts.clear();
      const ok = await verifyPassword(req.body?.password || '', config.passwordHash);
      if (!ok) { rec.count += 1; attempts.set(ip, rec); return reply.code(401).send({ error: 'invalid' }); }
      attempts.delete(ip);
      reply.setCookie(COOKIE_NAME, 'ok', cookieOptions(config.secureCookie));
      return { ok: true };
    });
  }

  if (config.authMode === 'google') {
    app.get('/api/auth/google/login', async (req, reply) => {
      const state = randomState();
      const { verifier, challenge } = pkcePair();
      // SameSite=lax lets this short-lived state cookie survive Google's top-level redirect back.
      reply.setCookie(OAUTH_COOKIE, `${state}.${verifier}`, {
        httpOnly: true, sameSite: 'lax', secure: config.secureCookie, path: '/', signed: true, maxAge: 300,
      });
      return reply.redirect(google.authorizationUrl({ state, codeChallenge: challenge }));
    });

    app.get('/api/auth/google/callback', async (req, reply) => {
      const raw = req.cookies?.[OAUTH_COOKIE];
      reply.clearCookie(OAUTH_COOKIE, { path: '/' });
      if (!raw) return reply.redirect('/?error=state');
      const unsigned = app.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return reply.redirect('/?error=state');
      const [savedState, verifier] = unsigned.value.split('.');
      const { code, state } = req.query;
      if (!code || !state || state !== savedState) return reply.redirect('/?error=state');
      let result;
      try {
        result = await google.exchangeCodeForEmail({ code, codeVerifier: verifier });
      } catch {
        return reply.redirect('/?error=google');
      }
      if (!result.emailVerified || !google.isAllowed(result.email)) return reply.redirect('/?error=forbidden');
      reply.setCookie(COOKIE_NAME, 'ok', cookieOptions(config.secureCookie));
      return reply.redirect('/');
    });
  }

  app.post('/api/logout', async (req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireAuth }, async () => ({ ok: true }));

  app.get('/api/boxes', { preHandler: requireAuth }, async () => store.listBoxes());
  app.post('/api/boxes', { preHandler: requireAuth }, async (req, reply) => {
    let box;
    try {
      const { installOhMyTmux = false, ...boxSpec } = req.body || {};
      box = await store.addBox(boxSpec);
      if (boxActions?.ensureReady) await boxActions.ensureReady(box, { installOhMyTmux: installOhMyTmux === true });
      return box;
    }
    catch (e) {
      if (box) await store.removeBox(box.id).catch(() => {});
      return reply.code(400).send({ error: e.message });
    }
  });
  app.patch('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { return await store.updateBox(req.params.id, req.body || {}); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/boxes/:id', { preHandler: requireAuth }, async (req) => {
    const box = await store.getBox(req.params.id);
    if (box) {
      if (sessions?.closeKey) sessions.closeKey(box.id);
      if (boxActions?.killSession) {
        try { void Promise.resolve(boxActions.killSession(box)).catch(() => {}); } catch {}
      }
    }
    await store.removeBox(req.params.id); return { ok: true };
  });
  app.post('/api/import', { preHandler: requireAuth }, async () => store.importFromSshConfig());

  app.get('/api/status', { preHandler: requireAuth }, async () => {
    const boxes = await store.listBoxes();
    const out = {};
    await Promise.all(boxes.map(async (b) => { out[b.id] = await statusChecker.checkBox(b); }));
    return out;
  });

  app.register(async (scope) => {
    scope.get('/term', { websocket: true }, async (socket, req) => {
      if (!hasTrustedOrigin(req)) { socket.close(1008, 'forbidden origin'); return; }
      if (!isAuthed(req)) { socket.close(1008, 'unauthorized'); return; }
      const { box: boxId, cid, cols, rows } = req.query;
      const box = await store.getBox(boxId);
      if (!box) { socket.close(1008, 'unknown box'); return; }
      const size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };

      let entry;
      try {
        entry = sessions.open({ key: boxId, box, session: box.sessionName, size });
      } catch (err) {
        const msg = err?.message || 'session error';
        try { socket.send(msg); } catch {}
        socket.close(1011);
        return;
      }

      const off = sessions.attach(entry, (d) => {
        try { if (socket.readyState === 1) socket.send(d); } catch { /* socket closing */ }
      });
      const offExit = sessions.onExit(entry, () => { try { socket.close(1000); } catch {} });
      socket.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'i') sessions.write(entry, msg.d);
        else if (msg.t === 'r') sessions.resize(entry, { cols: msg.c, rows: msg.r });
      });
      socket.on('close', () => {
        if (typeof off === 'function') off();
        if (typeof offExit === 'function') offExit();
        sessions.detach(entry);
      });
    });
  });

  return app;
}
