import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { verifyPassword, COOKIE_NAME, cookieOptions, sessionValue, sessionValueValid } from './auth.js';
import { createLoginRateLimiter } from './rateLimit.js';
import { createGoogleAuth, pkcePair, randomState } from './googleAuth.js';
import { buildEnsureTmuxRemote } from './boxActions.js';
import { assertBoxSafe } from './sshCommand.js';
import { upsertConfigFile } from './configFile.js';
import { mapWithConcurrency } from './concurrency.js';
import { parseEndpoint } from './proxmoxValidate.js';
import { assertSettingsInput as assertNetboxSettings } from './netboxValidate.js';
import { testNetbox } from './netboxApi.js';

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

const execFileAsync = promisify(execFile);

// Async on purpose: a synchronous child process here (up to its 5s timeout)
// would stall the event loop and freeze every open terminal's keystrokes.
async function killTmuxSession(sessionName) {
  await execFileAsync('tmux', ['kill-session', '-t', sessionName], { timeout: 5000 });
}

export function buildServer({ config, store, sessions, statusChecker, statusPoller, history, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, netboxStore, netboxTest = testNetbox, defaultPublicKey = () => null, googleAuth, localSession = 'local', killLocalSession = killTmuxSession }) {
  const httpsOpts =
    config.tlsCert && config.tlsKey
      ? { https: { key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert) } }
      : {};
  // trustProxy makes req.ip the X-Forwarded-For client behind the reverse
  // proxy/tunnel deployment the docs recommend. Without it every client shares
  // the proxy's address, so per-IP login rate limiting buckets everyone
  // together — any remote client could lock the real user out. Off by default:
  // trusting forwarded headers from a non-proxy would let clients spoof their ip.
  const app = Fastify({
    logger: false,
    ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
    ...httpsOpts,
  });
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

  const loginLimiter = createLoginRateLimiter(); // per-ip lockout for POST /api/login

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
      return r.valid && sessionValueValid(r.value);
    }
    // Fallback: parse the cookie header manually. Under @fastify/websocket v10
    // this WAS the WebSocket-upgrade path (req.cookies stayed empty there);
    // v11 populates req.cookies for upgrades too, so this is now a defensive
    // backstop for any request the cookie plugin didn't decorate.
    const cookieHeader = req.headers?.cookie;
    if (!cookieHeader) return false;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      if (name === COOKIE_NAME) {
        // Malformed percent-encoding (e.g. %zz) makes decodeURIComponent throw
        // URIError — this pre-auth path must fail closed with a clean
        // unauthorized, not crash the upgrade into a connection reset.
        let value;
        try { value = decodeURIComponent(trimmed.slice(eqIdx + 1).trim()); } catch { return false; }
        const r = app.unsignCookie(value);
        return r.valid && sessionValueValid(r.value);
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
      if (loginLimiter.limited(ip)) return reply.code(429).send({ error: 'too many attempts' });
      const ok = await verifyPassword(req.body?.password || '', config.passwordHash);
      if (!ok) { loginLimiter.fail(ip); return reply.code(401).send({ error: 'invalid' }); }
      loginLimiter.succeed(ip);
      reply.setCookie(COOKIE_NAME, sessionValue(), cookieOptions(config.secureCookie));
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
      reply.setCookie(COOKIE_NAME, sessionValue(), cookieOptions(config.secureCookie));
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
    try {
      const box = await store.addBox(req.body || {});
      return reply.code(201).send(box);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.patch('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const before = await store.getBox(req.params.id);
      const updated = await store.updateBox(req.params.id, req.body || {});
      // If anything the ssh argv is built from changed — the target tmux session
      // or any connection field — drop the live PTY (if any) so the browser
      // terminal reconnects with the NEW values instead of silently staying on
      // the ones it opened with (terminal on the old host, dot probing the new).
      // For a session-only change the ControlMaster (keyed by host/user/port) is
      // left alone, so the reattach multiplexes over it with no re-auth; a
      // connection-field change makes the old master irrelevant anyway.
      const connectionFields = ['sessionName', 'host', 'user', 'port', 'proxyJump'];
      if (before && sessions?.closeKey && connectionFields.some((f) => updated[f] !== before[f])) {
        sessions.closeKey(req.params.id);
      }
      return updated;
    }
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
  // Read-only: list a box's live tmux sessions to populate the Add/Edit session
  // dropdown. Accepts an unsaved spec (add mode) or a saved box's fields + id
  // (edit mode — id lets listSessions apply the live-session guard). assertBoxSafe
  // rejects unsafe connection fields up front; the probe itself is BatchMode +
  // ConnectTimeout bounded and rides the shared ControlMaster.
  app.post('/api/boxes/probe-sessions', { preHandler: requireAuth }, async (req, reply) => {
    const { id, host, user, port, proxyJump } = req.body || {};
    const spec = { id, host, user, port, proxyJump };
    try {
      assertBoxSafe(spec);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    return statusChecker.listSessions(spec);
  });
  app.post('/api/boxes/:id/reconnect', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    // Shut the SSH ControlMaster down first (while it's still alive, `-O exit`
    // can remove its socket). Killing the PTY first would SIGKILL the master and
    // leave a stale socket, which disables multiplexing on the next connect — so
    // a password box would re-login fine in the terminal yet stay red forever.
    if (boxActions?.exitMaster) {
      try { await boxActions.exitMaster(box); } catch {}
    }
    if (sessions?.closeKey) {
      sessions.closeKey(box.id);
      sessions.closeKey(`provision:${box.id}`);
    }
    if (boxActions?.killSession) {
      try { void Promise.resolve(boxActions.killSession(box)).catch(() => {}); } catch {}
    }
    if (statusChecker?.resetBackoff) statusChecker.resetBackoff(box.id);
    return { ok: true };
  });
  app.get('/api/export', { preHandler: requireAuth }, async (req, reply) => {
    const payload = await store.exportBoxes();
    const stamp = payload.exportedAt.slice(0, 10);
    reply.header('content-disposition', `attachment; filename="tmuxifier-boxes-${stamp}.json"`);
    reply.type('application/json');
    return JSON.stringify(payload, null, 2);
  });
  app.post('/api/import', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return await store.importBoxes(req.body);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/fleet/jobs', { preHandler: requireAuth }, async (req, reply) => {
    const { boxIds, command } = req.body || {};
    if (typeof command !== 'string' || !command.trim()) return reply.code(400).send({ error: 'command is required' });
    if (command.length > 65536) return reply.code(400).send({ error: 'command too long' });
    if (!Array.isArray(boxIds) || boxIds.length === 0) return reply.code(400).send({ error: 'select at least one box' });
    try {
      const job = await fleetManager.createJob({ boxIds, command });
      return reply.code(201).send(job);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.get('/api/fleet/jobs', { preHandler: requireAuth }, async () => fleetManager.listJobs());
  app.get('/api/fleet/jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = fleetManager.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });
  app.post('/api/fleet/jobs/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const job = fleetManager.cancelJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });

  // --- Proxmox LXC provisioning ---
  async function callHost(reply, id, fn) {
    let host;
    try {
      host = await proxmoxStore.getHost(id, { withSecret: true });
    } catch {
      return reply.code(502).send({ error: 'could not decrypt host token — re-add the host (was TMUXIFIER_COOKIE_SECRET rotated?)' });
    }
    if (!host) return reply.code(404).send({ error: 'host not found' });
    try { return await fn(makeProxmoxClient(host)); }
    catch (e) { return reply.code(502).send({ error: e.message }); }
  }

  app.post('/api/proxmox/inspect', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { host, port } = parseEndpoint((req.body || {}).endpoint);
      return await inspectEndpoint(`${host}:${port}`, { timeoutMs: config.pveTimeoutMs });
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  app.get('/api/proxmox/hosts', { preHandler: requireAuth }, async () => proxmoxStore.listHosts());
  app.post('/api/proxmox/hosts', { preHandler: requireAuth }, async (req, reply) => {
    const spec = req.body || {};
    try {
      // Verify the token reaches Proxmox before persisting an unusable profile.
      const { host, port } = parseEndpoint(spec.endpoint);
      const transient = { endpoint: `${host}:${port}`, tokenId: spec.tokenId, tokenSecret: spec.tokenSecret, verifyMode: spec.verifyMode || 'pin', fingerprint256: spec.fingerprint256 };
      await makeProxmoxClient(transient).version();
    } catch (e) { return reply.code(400).send({ error: `could not reach Proxmox: ${e.message}` }); }
    try { return reply.code(201).send(await proxmoxStore.addHost(spec)); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/hosts/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removeHost(req.params.id); return { ok: true }; });
  app.post('/api/proxmox/hosts/:id/test', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, async (c) => ({ ok: true, version: await c.version() })));
  app.get('/api/proxmox/hosts/:id/nodes', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.nodes()));
  app.get('/api/proxmox/hosts/:id/nodes/:node/storage', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, async (c) => {
      const list = await c.storages(req.params.node);
      const group = (kind) => list.filter((s) => String(s.content || '').split(',').includes(kind));
      return { rootdir: group('rootdir'), vztmpl: group('vztmpl') };
    }));
  app.get('/api/proxmox/hosts/:id/nodes/:node/templates', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.templates(req.params.node, req.query.storage)));
  app.get('/api/proxmox/hosts/:id/nodes/:node/bridges', { preHandler: requireAuth }, async (req, reply) =>
    callHost(reply, req.params.id, (c) => c.bridges(req.params.node)));

  app.get('/api/proxmox/keys', { preHandler: requireAuth }, async () => proxmoxStore.listKeys());
  app.post('/api/proxmox/keys', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await proxmoxStore.addKey(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/keys/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removeKey(req.params.id); return { ok: true }; });

  app.get('/api/proxmox/default-key', { preHandler: requireAuth }, async () => ({ publicKey: await defaultPublicKey() }));
  app.get('/api/proxmox/root-password', { preHandler: requireAuth }, async () => ({ set: await proxmoxStore.hasRootPassword() }));
  app.put('/api/proxmox/root-password', { preHandler: requireAuth }, async (req, reply) => {
    try { await proxmoxStore.setRootPassword((req.body || {}).password); return { set: true }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/root-password', { preHandler: requireAuth }, async () => { await proxmoxStore.clearRootPassword(); return { set: false }; });

  app.get('/api/proxmox/presets', { preHandler: requireAuth }, async () => proxmoxStore.listPresets());
  app.post('/api/proxmox/presets', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await proxmoxStore.addPreset(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/proxmox/presets/:id', { preHandler: requireAuth }, async (req) => { await proxmoxStore.removePreset(req.params.id); return { ok: true }; });

  app.post('/api/proxmox/provisions', { preHandler: requireAuth }, async (req, reply) => {
    try { return reply.code(201).send(await provisionManager.createProvision(req.body || {})); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.get('/api/proxmox/provisions', { preHandler: requireAuth }, async () => provisionManager.listProvisions());
  app.get('/api/proxmox/provisions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = provisionManager.getProvision(req.params.id);
    if (!job) return reply.code(404).send({ error: 'provision not found' });
    return job;
  });
  // --- NetBox integration settings ---
  app.get('/api/netbox/settings', { preHandler: requireAuth }, async () => ({ settings: await netboxStore.getSettings() }));
  app.put('/api/netbox/settings', { preHandler: requireAuth }, async (req, reply) => {
    try { return { settings: await netboxStore.setSettings(req.body || {}) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/netbox/settings', { preHandler: requireAuth }, async () => { await netboxStore.clearSettings(); return { ok: true }; });
  // Test may carry unsaved form values; a blank token falls back to the stored one
  // so "test before saving" works without ever echoing the token to the browser.
  app.post('/api/netbox/test', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body || {};
    const bodyToken = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
    let stored = null;
    try { stored = await netboxStore.getSettings({ withSecret: !bodyToken }); }
    catch { return reply.code(502).send({ error: 'could not decrypt the stored NetBox token — re-enter it (was TMUXIFIER_COOKIE_SECRET rotated?)' }); }
    const token = bodyToken || (stored && stored.token) || null;
    if (!token) return reply.code(400).send({ error: 'an API token is required — enter one or save settings first' });
    let candidate;
    try {
      candidate = {
        ...assertNetboxSettings({
          url: body.url ?? (stored && stored.url),
          token,
          tlsMode: body.tlsMode ?? (stored && stored.tlsMode) ?? undefined,
          fingerprint256: body.fingerprint256 ?? (stored && stored.fingerprint256),
        }),
        token,
      };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
    return netboxTest(candidate);
  });
  app.get('/api/status', { preHandler: requireAuth }, async () => {
    // Serve the shared, server-side poll snapshot when a poller is wired: every
    // open tab reads the same cache instead of driving its own SSH probe cycle,
    // so connection volume is independent of how many tabs are watching. See
    // src/server/statusPoller.js. Falls back to on-demand probing when no poller
    // is provided (e.g. unit tests).
    if (statusPoller) return statusPoller.getSnapshot();
    const boxes = await store.listBoxes();
    const out = {};
    // Probe in small batches, not all at once: a fleet-wide burst of simultaneous
    // SSH handshakes trips connection-rate/IPS blocks on the path and makes boxes
    // flicker red. See src/server/concurrency.js.
    await mapWithConcurrency(boxes, config.statusConcurrency || 4, async (b) => {
      out[b.id] = await statusChecker.checkBox(b);
    });
    return out;
  });

  // Rolling per-box health series (for row sparklines) and the in-app events
  // timeline. Served from the in-memory history the poller feeds — no new SSH,
  // no change to /api/status. `?box=` narrows the series to one box.
  app.get('/api/health/series', { preHandler: requireAuth }, async (req) => {
    const box = req.query?.box;
    return box ? { [box]: history.getSeries(box) } : history.getSeries();
  });
  app.get('/api/health/events', { preHandler: requireAuth }, async (req) => {
    const since = Number(req.query?.since) || 0;
    return history.getEvents({ since });
  });

  // Client UI settings the browser needs at boot. Currently just the terminal
  // font, validated/normalized server-side (config.js); the name is not secret.
  app.get('/api/ui-config', { preHandler: requireAuth }, async () => {
    return { termFont: config.termFont ?? null, termFontSize: config.termFontSize ?? 12 };
  });

  app.get('/api/local-shell', { preHandler: requireAuth }, async () => {
    return { shell: config.localShell || 'none' };
  });

  app.patch('/api/local-shell', { preHandler: requireAuth }, async (req, reply) => {
    const { shell } = req.body || {};
    if (!shell || !['none', 'omz', 'omb'].includes(shell)) {
      return reply.code(400).send({ error: 'invalid shell' });
    }
    try {
      if (localShellActions?.ensureReady) await localShellActions.ensureReady(shell);
    } catch (e) {
      const msg = e?.message || 'could not install local shell framework';
      return reply.code(400).send({ error: msg });
    }
    try {
      upsertConfigFile(config.configPath, { localShell: shell });
      config.localShell = shell;
    } catch (e) {
      return reply.code(500).send({ error: 'could not save config' });
    }
    return { ok: true };
  });

  app.post('/api/local-shell/reconnect', { preHandler: requireAuth }, async () => {
    if (sessions?.closeKey) sessions.closeKey('__local__');
    // Kill the underlying tmux session so the next openLocal() creates a fresh
    // session with the current shell framework, not reattach to the old one.
    try { await killLocalSession(localSession); } catch {}
    return { ok: true };
  });

  app.register(async (scope) => {
    scope.get('/term', { websocket: true }, async (socket, req) => {
      if (!hasTrustedOrigin(req)) { socket.close(1008, 'forbidden origin'); return; }
      if (!isAuthed(req)) { socket.close(1008, 'unauthorized'); return; }
      const { box: boxId, cols, rows, mode } = req.query;

      // --- Local shell ---
      if (boxId === '__local__') {
        if (mode === 'provision') {
          socket.close(1008, 'provision not supported for local shell');
          return;
        }
        const size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };

        let entry;
        try {
          entry = sessions.openLocal({ key: '__local__', shell: config.localShell, size });
        } catch (err) {
          const msg = err?.message || 'session error';
          try { socket.send(msg); } catch {}
          socket.close(1011);
          return;
        }

        const off = sessions.attach(entry, (d) => {
          try { if (socket.readyState === 1) socket.send(d); } catch {}
        });
        const offExit = sessions.onExit(entry, () => { try { socket.close(1000); } catch {} });
        socket.on('message', (raw) => {
          let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
          // Drop malformed frames: pty.write throws on non-strings, and that
          // throw would escape to the process-level handler (L9). Same for
          // non-numeric resize values.
          if (msg.t === 'i' && typeof msg.d === 'string') sessions.write(entry, msg.d);
          else if (msg.t === 'r' && Number.isFinite(msg.c) && Number.isFinite(msg.r)) sessions.resize(entry, { cols: msg.c, rows: msg.r });
        });
        socket.on('close', () => {
          if (typeof off === 'function') off();
          if (typeof offExit === 'function') offExit();
          sessions.detach(entry);
        });
        return;
      }

      const box = await store.getBox(boxId);
      if (!box) { socket.close(1008, 'unknown box'); return; }

      // --- Provision mode ---
      if (mode === 'provision') {
        const { ohMyTmux, ohMyZsh, ohMyBash } = req.query;
        const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
          installOhMyTmux: ohMyTmux === '1',
          installOhMyZsh: ohMyZsh === '1',
          installOhMyBash: ohMyBash === '1',
        });

        if (!sessions?.provision) {
          try { socket.send(JSON.stringify({ t: 'x', code: 1 })); } catch {}
          socket.close(1011);
          return;
        }

        let entry;
        try {
          entry = sessions.provision({ key: `provision:${boxId}`, box, script });
        } catch (err) {
          const msg = err?.message || 'provision error';
          try { socket.send(msg); } catch {}
          socket.close(1011);
          return;
        }

        const off = sessions.attach(entry, (d) => {
          try { if (socket.readyState === 1) socket.send(d); } catch {}
        });
        const offExit = sessions.onExit(entry, () => {
          const code = entry.exitCode != null ? entry.exitCode : 1;
          try {
            if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'x', code }));
          } catch {}
          if (code !== 0 && box.source !== 'proxmox') {
            // Best-effort rollback: the exit frame already told the client
            // about the failure. If removeBox fails the box will linger in the
            // list but is unreachable — the user can remove it manually.
            // Proxmox-provisioned boxes are kept: the LXC really exists, so the
            // box is how the user reaches it to retry the setup.
            store.removeBox(boxId).catch(() => {});
          }
          try { socket.close(1000); } catch {}
        });
        socket.on('message', (raw) => {
          let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.t === 'i' && typeof msg.d === 'string') sessions.write(entry, msg.d);
        });
        socket.on('close', () => {
          if (typeof off === 'function') off();
          if (typeof offExit === 'function') offExit();
          // Kill the PTY only if this was the last socket watching the entry —
          // a replacement socket (same provision:<boxId> key) may be attached.
          if (sessions.closeIfUnwatched) sessions.closeIfUnwatched(entry);
          else sessions.close(entry);
        });
        return;
      }

      // --- Interactive mode (existing) ---
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

      // Opening a box is explicit engagement — clear any probe backoff so the
      // dot re-checks promptly instead of waiting out the 5m floor.
      if (statusChecker?.resetBackoff) statusChecker.resetBackoff(boxId);

      const off = sessions.attach(entry, (d) => {
        try { if (socket.readyState === 1) socket.send(d); } catch { /* socket closing */ }
      });
      const offExit = sessions.onExit(entry, () => { try { socket.close(1000); } catch {} });
      socket.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'i' && typeof msg.d === 'string') sessions.write(entry, msg.d);
        else if (msg.t === 'r' && Number.isFinite(msg.c) && Number.isFinite(msg.r)) sessions.resize(entry, { cols: msg.c, rows: msg.r });
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
