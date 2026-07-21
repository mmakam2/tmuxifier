import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { verifyPassword, COOKIE_NAME, cookieOptions, sessionValue, sessionValueValid } from './auth.js';
import { createLoginRateLimiter } from './rateLimit.js';
import { createGoogleAuth, pkcePair, randomState } from './googleAuth.js';
import { buildEnsureTmuxRemote, resolveTools } from './boxActions.js';
import { assertBoxSafe } from './sshCommand.js';
import { upsertConfigFile } from './configFile.js';
import { readJsonSync, writeJsonSync } from './jsonFile.js';
import { parseEndpoint, assertProxmoxLinkInput } from './proxmoxValidate.js';
import { assertSettingsInput as assertNetboxSettings } from './netboxValidate.js';
import { testNetbox } from './netboxApi.js';
import { validUploadName, storedUploadName, saveLocalUpload } from './uploads.js';
import { injectLocalUploadPath, injectLocalText as injectLocalTextDefault } from './tmuxInject.js';
import { normalizeTranscript } from './voiceText.js';
import { MODEL_IDS, resolveModel } from './voiceCatalog.js';
import { vendorModelPath } from './voicePaths.js';
import { verifyAssertion, verifyRegistration, makeOriginCheck, SUPPORTED_ALGS } from './webauthn.js';
import { createPasskeyChallenges } from './passkeyChallenges.js';

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    // voiceRecorder.ts's AudioWorklet loads voiceWorklet.js as a Vite-emitted,
    // content-hashed, same-origin static asset (`?url` import) rather than a
    // blob: URL, so it's already covered by 'self' — no widening needed here.
    // Keep it that way: 'blob:' in script-src would be a standing invitation
    // for any future feature that blobs semi-trusted text to become a silent
    // script-execution gadget, on an app with no unsafe-inline/unsafe-eval.
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
};

// permissions-policy is computed per-server (not a static header) because the
// microphone token depends on config.voiceEnabled: an empty allowlist
// (`microphone=()`) disables the microphone for the top-level document itself,
// not merely embedded frames, so it must never ship that way while voice
// dictation is on or getUserMedia() rejects with a policy error regardless of
// HTTPS/user consent. `(self)` grants only this app's own origin — never
// embedded third-party frames — and this app already sends `frame-ancestors
// 'none'`, so that stays tight. camera/geolocation remain locked down always.
function permissionsPolicyHeader(voiceEnabled) {
  return `camera=(), microphone=(${voiceEnabled ? 'self' : ''}), geolocation=()`;
}

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

// Exact-match target: tmux's -t falls back to PREFIX matching when no session
// has the exact name, so a bare 'local' could kill an unrelated 'local-dev'
// session on this host. The '=' prefix forces an exact match.
export function killSessionArgs(sessionName) {
  return ['kill-session', '-t', `=${sessionName}`];
}

// Async on purpose: a synchronous child process here (up to its 5s timeout)
// would stall the event loop and freeze every open terminal's keystrokes.
async function killTmuxSession(sessionName) {
  await execFileAsync('tmux', killSessionArgs(sessionName), { timeout: 5000 });
}

export function buildServer({ config, store, sessions, statusChecker, statusPoller, history, boxActions, localShellActions, fleetManager, proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, netboxStore, netboxTest = testNetbox, defaultPublicKey = () => null, googleAuth, localSession = 'local', killLocalSession = killTmuxSession, removeBox = null, proxmoxInventory, lifecycleManager, saveUploadLocally = saveLocalUpload, injectLocalUpload = injectLocalUploadPath, injectLocalText = injectLocalTextDefault, knownHosts, setupManager, aiAuthSeeder, passkeyStore = null, passkeyChallenges = null, voiceEngine = null, voiceStore = null, voiceInstallManager = null, resolveVoice = null, getVoiceEngine = null, modelInstalled = null, voiceEnabledInitial = null, log = (msg) => console.error(msg) }) {
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

  // Terminal uploads POST their raw bytes; keep them as a Buffer. Scoped to
  // this content type only — JSON handling everywhere else is untouched.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
  const uploadMaxBytes = Number(config.uploadMaxBytes) || 25 * 1024 * 1024;
  const voiceMaxBytes = Number(config.voiceMaxBytes) || 8 * 1024 * 1024;

  // data/voice.json is authoritative for whether voice is on and which model
  // is selected, and it is read per request so a Settings change applies
  // without a restart. `voiceEnabledCache` exists because the
  // permissions-policy header is set in a SYNCHRONOUS onSend hook and cannot
  // await the store — it is refreshed on every path that could change the
  // answer. Note the header is per-document: a browser tab loaded while voice
  // was off keeps `microphone=()` until it is reloaded, which is why the
  // Settings tab tells the operator to reload after enabling.
  // Seeded from the resolved store state when the caller supplies it. Falling
  // back to config.voiceEnabled would serve the FIRST page load of a fresh
  // boot with microphone=() whenever voice is enabled via data/voice.json
  // rather than .env — and since Permissions-Policy is per-document, that tab
  // would have the mic blocked until reloaded.
  let voiceEnabledCache = voiceEnabledInitial === null
    ? Boolean(config.voiceEnabled)
    : Boolean(voiceEnabledInitial);
  async function voiceState() {
    if (!resolveVoice) {
      // No store wired (older callers, and most unit tests): fall back to the
      // boot-time config so stage 1's behaviour is unchanged.
      return { bin: null, model: null, enabled: Boolean(config.voiceEnabled), pinned: { bin: null, model: null } };
    }
    const s = await resolveVoice();
    voiceEnabledCache = s.enabled;
    return s;
  }
  // Whether a given model FILE is present on disk. Injectable so route tests
  // stay filesystem-free; defaults to the vendored models directory.
  const modelInstalledFn = modelInstalled
    || ((file) => fs.existsSync(vendorModelPath(process.cwd(), file)));

  // The engine is rebuilt when the selected model changes, so callers must ask
  // for the current one rather than closing over a value that goes stale.
  async function currentEngine() {
    return getVoiceEngine ? getVoiceEngine() : voiceEngine;
  }

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

  // --- passkeys (WebAuthn) ---
  // A third login path alongside password/Google. It mints exactly the same
  // session cookie, so the session TTL, revocation watermark and WebSocket auth
  // all apply unchanged.
  const PK_COOKIE = 'tmuxifier_pk';
  const PK_TTL_SECONDS = 120;
  const LABEL_RE = /^[A-Za-z0-9 ._-]{1,32}$/;
  const pkChallenges = passkeyChallenges ?? createPasskeyChallenges({ ttlMs: PK_TTL_SECONDS * 1000 });
  const rpId = config.rpId || null;
  const passkeyOriginOk = rpId ? makeOriginCheck(rpId) : () => false;

  // Separate bounded stores per ceremony by default. login/begin is
  // unauthenticated, so a flood of anonymous challenges must not be able to
  // evict the enrollment challenge of an authenticated operator mid-ceremony.
  // A caller that injects its own passkeyChallenges (e.g. a test wanting a
  // deterministic clock) gets it applied to BOTH ceremonies — an injected
  // store silently controlling only enrollment would be a seam a caller
  // could easily miss.
  const pkLoginChallenges = passkeyChallenges ?? createPasskeyChallenges({ ttlMs: PK_TTL_SECONDS * 1000 });
  const challengeStoreFor = (kind) => (kind === 'auth' ? pkLoginChallenges : pkChallenges);

  // Whether the configured rpId could ever complete a passkey login right
  // now: a real domain name is set, AND (nothing is pinned yet OR the pin
  // matches it). pkReady() below layers store-existence and per-route status
  // codes/messages on top of this same test for the login/enroll routes; the
  // arming guard in POST /api/passkeys/only reuses it unchanged so both
  // places agree on what "usable" means — arming while this is false would
  // strand the operator with zero working logins.
  function rpIdCurrentlyUsable(pinnedRpId) {
    return !!rpId && (!pinnedRpId || pinnedRpId === rpId);
  }

  // Replies with the reason and returns false when passkeys cannot be used.
  // exposeStoredRpId gates the specific 409 message naming the previously
  // pinned hostname: fine on the authenticated enroll routes (operationally
  // useful, and the caller already runs the dashboard), but the two
  // unauthenticated login routes must not hand an anonymous caller a
  // hostname it isn't currently talking to.
  async function pkReady(reply, { exposeStoredRpId = true } = {}) {
    if (!passkeyStore) {
      reply.code(503).send({ error: 'passkeys are not configured' });
      return false;
    }
    if (!rpId) {
      reply.code(503).send({ error: 'passkeys need a domain name — set TMUXIFIER_RP_ID, or point TMUXIFIER_BASE_EXTERNAL_URL at a hostname (an IP address cannot be a WebAuthn relying party)' });
      return false;
    }
    const pinned = await passkeyStore.getRpId();
    if (!rpIdCurrentlyUsable(pinned)) {
      reply.code(409).send(
        exposeStoredRpId
          ? { error: `these passkeys were enrolled for ${pinned}, but this server is configured for ${rpId}` }
          : { error: 'passkeys are not available for this server configuration' },
      );
      return false;
    }
    return true;
  }

  // owner is the requester's IP: an outstanding-challenge quota keyed to it
  // is what stops an anonymous flood from evicting a different caller's
  // in-flight challenge (see passkeyChallenges.js).
  function issueChallenge(req, reply, kind) {
    const { token, challenge } = challengeStoreFor(kind).issue(kind, { owner: req.ip });
    reply.setCookie(PK_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: !!config.secureCookie,
      path: '/', signed: true, maxAge: PK_TTL_SECONDS,
    });
    return challenge;
  }

  function takeChallenge(req, kind) {
    const raw = req.cookies?.[PK_COOKIE];
    if (!raw) return null;
    const unsigned = app.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    return challengeStoreFor(kind).take(unsigned.value, kind);
  }

  // Combines the persisted flag with the kill switch, given an already-
  // fetched store snapshot rather than reading the store itself — the
  // snapshot is still fetched fresh per request by the caller (never
  // captured at boot), so toggling either the kill switch or the stored flag
  // still takes effect at once. Sharing the snapshot lets a caller that also
  // needs other passkeyStore fields (GET /api/auth/info below) do one
  // readAll() instead of one per field.
  function passkeyOnlyArmed(pk) {
    return !!pk && !config.passkeyOnlyKillSwitch && pk.passkeyOnly === true;
  }

  // The fresh-per-request snapshot fetch that feeds passkeyOnlyArmed() above,
  // factored out once so the login gate, both Google routes below, and
  // GET /api/auth/info share one fail-open implementation instead of four
  // separately hand-written try/catch copies — a lockout-adjacent gate is
  // exactly the wrong place for four chances to typo the failure behavior.
  // A store read error degrades to "not armed" / "no credentials" (fail
  // open), never to a 500 or an unhandled rejection.
  async function passkeySnapshot() {
    if (!passkeyStore) return null;
    try { return await passkeyStore.snapshot(); } catch { return null; }
  }

  app.get('/api/passkeys', { preHandler: requireAuth }, async () => ({
    credentials: passkeyStore ? await passkeyStore.list() : [],
    rpId,
    storedRpId: passkeyStore ? await passkeyStore.getRpId() : null,
    passkeyOnly: passkeyStore ? await passkeyStore.getPasskeyOnly() : false,
    killSwitch: !!config.passkeyOnlyKillSwitch,
  }));

  app.post('/api/passkeys/register/begin', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await pkReady(reply))) return reply;
    const challenge = issueChallenge(req, reply, 'reg');
    const enrolled = await passkeyStore.listRaw();
    return {
      challenge: challenge.toString('base64url'),
      rp: { id: rpId, name: 'Tmuxifier' },
      user: { id: await passkeyStore.getUserHandle(), name: `tmuxifier@${rpId}`, displayName: 'Tmuxifier' },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      // Discoverable so login needs no username; user verification so the
      // passkey is a real second factor on the device itself.
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: PK_TTL_SECONDS * 1000,
      excludeCredentials: enrolled.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports ?? [] })),
    };
  });

  app.post('/api/passkeys/register/finish', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await pkReady(reply))) return reply;
    const label = String(req.body?.label ?? '').trim() || 'passkey';
    if (!LABEL_RE.test(label)) {
      return reply.code(400).send({ error: 'label must be 1-32 characters of letters, digits, space, dot, underscore or hyphen' });
    }
    const challenge = takeChallenge(req, 'reg');
    reply.clearCookie(PK_COOKIE, { path: '/' });
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — start again' });
    let reg;
    try {
      reg = verifyRegistration({ response: req.body?.response ?? {}, expectedChallenge: challenge, rpId, originOk: passkeyOriginOk });
    } catch (e) {
      // This endpoint is authenticated, so a specific reason is safe and useful.
      return reply.code(400).send({ error: `passkey registration failed: ${String(e.message).slice(0, 160)}` });
    }
    const transports = Array.isArray(req.body?.response?.transports)
      ? [...new Set(req.body.response.transports.filter((t) => typeof t === 'string' && /^[a-z-]{1,16}$/.test(t)))].slice(0, 8)
      : [];
    const credential = await passkeyStore.add({
      id: reg.credentialId.toString('base64url'),
      publicKey: reg.publicKey.toString('base64url'),
      alg: reg.alg, signCount: reg.signCount, label, transports,
    }, { rpId });
    return { credential };
  });

  app.delete('/api/passkeys/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!passkeyStore) return reply.code(503).send({ error: 'passkeys are not configured' });
    const result = await passkeyStore.remove(req.params.id);
    if (!result.removed) return reply.code(404).send({ error: 'passkey not found' });
    return { ok: true, disarmed: result.disarmed };
  });

  app.post('/api/passkeys/only', { preHandler: requireAuth }, async (req, reply) => {
    if (!passkeyStore) return reply.code(503).send({ error: 'passkeys are not configured' });
    if (config.passkeyOnlyKillSwitch) {
      return reply.code(409).send({ error: 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart before arming this' });
    }
    // Require an explicit boolean: a missing/malformed body must not be
    // silently interpreted as `enabled: false` and disarm a security control
    // that forgot its payload.
    const enabled = req.body?.enabled;
    if (enabled !== true && enabled !== false) {
      return reply.code(400).send({ error: 'enabled must be true or false' });
    }
    // Arming only — disarming is the recovery path and must stay
    // unconditional, so this guard is skipped entirely when enabled is false.
    // A credential *count* is not the same as a *usable* login: reuse the
    // same rpId conditions pkReady() already checks for the login/enroll
    // routes, so arming refuses (409) instead of succeeding into a state
    // where every enrolled passkey is unverifiable (rpId changed since
    // enrollment, or never configured at all).
    if (enabled) {
      const pinned = await passkeyStore.getRpId();
      if (!rpIdCurrentlyUsable(pinned)) {
        return reply.code(409).send({
          error: !rpId
            ? 'passkeys need a domain name — set TMUXIFIER_RP_ID (or TMUXIFIER_BASE_EXTERNAL_URL) before requiring passkey sign-in'
            : `these passkeys were enrolled for ${pinned}, but this server is configured for ${rpId} — fix the configuration before requiring passkey sign-in`,
        });
      }
    }
    try {
      const result = await passkeyStore.setPasskeyOnly(enabled);
      // The fleet's most consequential auth setting just flipped — worth an
      // audit line. No attacker-controlled text: this is a fixed string.
      log(`[tmuxifier] passkey-only mode ${result ? 'armed' : 'disarmed'}`);
      return { passkeyOnly: result };
    } catch (e) {
      return reply.code(409).send({ error: e.message });
    }
  });

  app.post('/api/auth/passkey/login/begin', async (req, reply) => {
    if (loginLimiter.limited(req.ip)) return reply.code(429).send({ error: 'too many attempts' });
    if (!(await pkReady(reply, { exposeStoredRpId: false }))) return reply;
    if ((await passkeyStore.listRaw()).length === 0) return reply.code(503).send({ error: 'no passkey enrolled' });
    const challenge = issueChallenge(req, reply, 'auth');
    return {
      challenge: challenge.toString('base64url'),
      rpId,
      timeout: PK_TTL_SECONDS * 1000,
      userVerification: 'required',
      // Discoverable credentials identify the user themselves; an empty list
      // also avoids handing out credential ids before authentication.
      allowCredentials: [],
    };
  });

  app.post('/api/auth/passkey/login/finish', async (req, reply) => {
    const ip = req.ip;
    if (loginLimiter.limited(ip)) return reply.code(429).send({ error: 'too many attempts' });
    if (!(await pkReady(reply, { exposeStoredRpId: false }))) return reply;
    const challenge = takeChallenge(req, 'auth');
    reply.clearCookie(PK_COOKIE, { path: '/' });
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — start again' });
    const credential = (await passkeyStore.listRaw()).find((c) => c.id === req.body?.id);
    let result;
    try {
      if (!credential) throw new Error('unknown credential');
      result = verifyAssertion({
        response: req.body?.response ?? {},
        expectedChallenge: challenge, rpId, originOk: passkeyOriginOk,
        // NOT `credential.signCount ?? 0`: verifyAssertion rejects a non-numeric
        // stored count on purpose, and `??` would launder a null straight past
        // that guard, silently disabling the cloned-authenticator check.
        // passkeyStore.listRaw() guarantees a number — see Task 7.
        publicKey: credential.publicKey, storedSignCount: credential.signCount,
      });
    } catch (e) {
      loginLimiter.fail(ip);
      // A stalled counter is the one failure worth naming in the log; the
      // response stays generic so a caller cannot enumerate credential ids.
      // Match the stall message specifically, NOT /sign count/ — that would also
      // match 'invalid stored sign count', logging a corrupt-store lockout as a
      // cloned authenticator, the exact mislabel this log line exists to avoid.
      if (credential && /did not increase/.test(e.message)) {
        log(`[tmuxifier] passkey "${credential.label}" sign count did not increase — possible cloned authenticator`);
      }
      return reply.code(401).send({ error: 'passkey verification failed' });
    }
    loginLimiter.succeed(ip);
    await passkeyStore.touch(credential.id, { signCount: result.signCount });
    reply.setCookie(COOKIE_NAME, sessionValue(), cookieOptions(config.secureCookie));
    return { ok: true };
  });

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
    if (!reply.hasHeader('permissions-policy')) {
      reply.header('permissions-policy', permissionsPolicyHeader(voiceEnabledCache));
    }
    // Same predicate as the Secure cookie flag: local TLS counts, not only an
    // https external URL — the self-hosted TLS mode the docs recommend was the
    // one deployment NOT getting HSTS.
    if (config.secureCookie || String(config.publicUrl || '').toLowerCase().startsWith('https://')) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (req.raw.url?.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Server-side session revocation: logout advances this watermark, and any
  // cookie issued before it is rejected — so a captured cookie actually dies
  // on logout instead of staying valid for the rest of its 7-day TTL.
  // Persisted under data/ so it survives restarts.
  const authStateFile = path.join(config.dataDir || '.', 'auth-state.json');
  let sessionsInvalidBeforeMs = 0;
  try {
    const st = readJsonSync(authStateFile, { fallback: null, validate: (v) => !!v && typeof v === 'object' });
    sessionsInvalidBeforeMs = Number(st?.sessionsInvalidBeforeMs) || 0;
  } catch { sessionsInvalidBeforeMs = 0; }

  function isAuthed(req) {
    // Primary: use req.cookies if populated (normal case)
    const raw = req.cookies?.[COOKIE_NAME];
    if (raw) {
      const r = app.unsignCookie(raw);
      return r.valid && sessionValueValid(r.value, Date.now(), { notBeforeMs: sessionsInvalidBeforeMs });
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
        return r.valid && sessionValueValid(r.value, Date.now(), { notBeforeMs: sessionsInvalidBeforeMs });
      }
    }
    return false;
  }
  function requireAuth(req, reply, done) {
    if (!isAuthed(req)) { reply.code(401).send({ error: 'unauthorized' }); return; }
    done();
  }

  app.get('/api/auth/info', async () => {
    // Same fetch-and-fail-open logic as the login gate and Google routes
    // below, via the shared passkeySnapshot() helper (see its comment) — one
    // disk read + JSON parse instead of a hand-rolled second copy. A read
    // failure degrades to "no passkeys" rather than 500ing the login page.
    const pk = await passkeySnapshot();
    return {
      mode: config.authMode === 'google' ? 'google' : 'password',
      // Unauthenticated on purpose: the login screen needs to know whether to
      // draw the passkey button. It exposes only the hostname the client is
      // already talking to, plus a count.
      passkey: {
        enrolled: pk ? pk.credentials.length : 0,
        rpId,
        only: passkeyOnlyArmed(pk),
      },
    };
  });

  if (config.authMode !== 'google') {
    app.post('/api/login', async (req, reply) => {
      if (passkeyOnlyArmed(await passkeySnapshot())) return reply.code(403).send({ error: 'passkey required' });
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
      if (passkeyOnlyArmed(await passkeySnapshot())) return reply.redirect('/?error=passkey-only');
      const state = randomState();
      const { verifier, challenge } = pkcePair();
      // SameSite=lax lets this short-lived state cookie survive Google's top-level redirect back.
      reply.setCookie(OAUTH_COOKIE, `${state}.${verifier}`, {
        httpOnly: true, sameSite: 'lax', secure: config.secureCookie, path: '/', signed: true, maxAge: 300,
      });
      return reply.redirect(google.authorizationUrl({ state, codeChallenge: challenge }));
    });

    app.get('/api/auth/google/callback', async (req, reply) => {
      if (passkeyOnlyArmed(await passkeySnapshot())) return reply.redirect('/?error=passkey-only');
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
    // Advance the revocation watermark so every previously issued cookie is
    // dead server-side, not just cleared in this browser. Best-effort persist
    // — a write failure still leaves the in-memory watermark active.
    sessionsInvalidBeforeMs = Date.now();
    try { writeJsonSync(authStateFile, { sessionsInvalidBeforeMs }); } catch { /* keep in-memory watermark */ }
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
      const patch = req.body || {};
      if ('source' in patch || 'proxmox' in patch) {
        return reply.code(400).send({ error: 'proxmox linkage must use the dedicated link route' });
      }
      const before = await store.getBox(req.params.id);
      const updated = await store.updateBox(req.params.id, patch);
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
  app.delete('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (lifecycleManager?.hasActiveJob(req.params.id)) {
      return reply.code(409).send({ error: 'box has an active lifecycle job' });
    }
    try { setupManager?.cancelForBox(req.params.id); } catch {}
    if (removeBox) return removeBox(req.params.id);
    await store.removeBox(req.params.id);
    return { ok: true };
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
  // Explicit user consent replaces lifecycle proof: this is the only path that
  // removes a known_hosts entry for a machine Tmuxifier didn't create or
  // destroy. See docs/superpowers/specs/2026-07-18-stale-hostkey-handling-design.md.
  app.post('/api/boxes/:id/forget-hostkey', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (knownHosts?.forget) {
      try { await knownHosts.forget(box.host, box.port); } catch {}
    }
    // Drop the ControlMaster so the next connect performs a fresh key exchange,
    // and clear probe backoff so the dot recovers promptly.
    if (boxActions?.exitMaster) {
      try { await boxActions.exitMaster(box); } catch {}
    }
    if (statusChecker?.resetBackoff) statusChecker.resetBackoff(box.id);
    return { ok: true };
  });
  // Seeds subscription credentials for the AI CLIs onto the box (opt-in
  // checkbox in the provision flows). Response is redacted to target/ok/skip —
  // secret material never appears in any API body.
  app.post('/api/boxes/:id/seed-ai-auth', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (!aiAuthSeeder?.seed) return reply.code(503).send({ error: 'seeding unavailable' });
    let results;
    try {
      results = await aiAuthSeeder.seed(box);
    } catch {
      // Last line of defense for this API surface: a rejection must never
      // echo its message (it could carry secret-adjacent material) into the
      // response body.
      return reply.code(500).send({ error: 'seeding failed' });
    }
    return { results };
  });

  // Host-side AI-auth readiness for the provision forms: is there anything to
  // seed? Reasons are the seeder's fixed skip strings — never secret material,
  // and a rejection must never echo its message into the body.
  app.get('/api/ai-auth/status', { preHandler: requireAuth }, async (req, reply) => {
    if (!aiAuthSeeder?.status) return reply.code(503).send({ error: 'seeding unavailable' });
    try {
      return await aiAuthSeeder.status();
    } catch {
      return reply.code(500).send({ error: 'status failed' });
    }
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
  app.get('/api/proxmox/hosts/:id/nodes/:node/templates', { preHandler: requireAuth }, async (req, reply) => {
    // Without this, a missing param builds /storage/undefined/content upstream
    // and surfaces as a confusing PVE 502 instead of a clear client error.
    if (!req.query.storage) return reply.code(400).send({ error: 'storage query parameter is required' });
    return callHost(reply, req.params.id, (c) => c.templates(req.params.node, req.query.storage));
  });
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
  app.put('/api/proxmox/presets/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const preset = await proxmoxStore.updatePreset(req.params.id, req.body || {});
      if (!preset) return reply.code(404).send({ error: 'preset not found' });
      return preset;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
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

  // --- Box setup jobs (server-side, resumable) ---
  app.post('/api/boxes/:id/setup', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'unknown box' });
    const b = req.body || {};
    let tools;
    try { tools = resolveTools(Array.isArray(b.tools) ? b.tools.join(',') : (typeof b.tools === 'string' ? b.tools : '')); }
    catch { return reply.code(400).send({ error: 'invalid tools' }); }
    const options = { ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools, seedAiAuth: !!b.seedAiAuth };
    return reply.code(201).send(setupManager.start(box, options));
  });
  app.get('/api/setup', { preHandler: requireAuth }, async () => setupManager.listJobs());
  app.get('/api/setup/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = setupManager.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'setup job not found' });
    return job;
  });
  app.get('/api/boxes/:id/setup', { preHandler: requireAuth }, async (req, reply) => {
    const job = setupManager.currentForBox(req.params.id);
    if (!job) return reply.code(204).send();
    return job;
  });

  // --- Proxmox linked-container inventory and lifecycle jobs ---
  const serviceFailure = (reply, error, fallback = 400) => reply
    .code(Number.isInteger(error?.statusCode) ? error.statusCode : fallback)
    .send({ error: error?.message || 'request failed' });

  app.get('/api/proxmox/containers', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const records = await proxmoxInventory.getLinkedContainers(await store.listBoxes());
      const active = new Map(lifecycleManager.listJobs()
        .filter((job) => job.status === 'running')
        .map((job) => [job.boxId, job]));
      return records.map((record) => ({ ...record, activeJob: active.get(record.boxId) || null }));
    } catch (error) { return serviceFailure(reply, error, 502); }
  });

  app.get('/api/proxmox/hosts/:id/nodes/:node/containers', { preHandler: requireAuth }, async (req, reply) => {
    const host = await proxmoxStore.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'proxmox host not found' });
    try {
      assertProxmoxLinkInput(
        { hostId: host.id, node: req.params.node, vmid: 100 },
        { hostIds: [host.id] },
      );
    } catch (error) { return serviceFailure(reply, error, 400); }
    try { return await proxmoxInventory.listNodeContainers(req.params.id, req.params.node, await store.listBoxes()); }
    catch (error) { return serviceFailure(reply, error, 502); }
  });

  app.put('/api/boxes/:id/proxmox', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (box.proxmox && lifecycleManager.hasActiveTarget(box.proxmox)) return reply.code(409).send({ error: 'container has an active lifecycle job' });
    if (!req.body || typeof req.body.hostId !== 'string' || !req.body.hostId.trim()) {
      return reply.code(400).send({ error: 'proxmox host is required' });
    }
    const host = await proxmoxStore.getHost(req.body.hostId, { withSecret: true });
    if (!host) return reply.code(404).send({ error: 'proxmox host not found' });
    try { assertProxmoxLinkInput(req.body, { hostIds: [host.id] }); }
    catch (error) { return serviceFailure(reply, error, 400); }
    let containers;
    try { containers = await proxmoxInventory.listNodeContainers(host.id, req.body.node, await store.listBoxes()); }
    catch (error) { return serviceFailure(reply, error, 502); }
    const target = containers.find((item) => item.vmid === Number(req.body.vmid));
    if (!target) return reply.code(404).send({ error: 'proxmox container not found' });
    if (target.linkedBoxId && target.linkedBoxId !== box.id) return reply.code(409).send({ error: 'proxmox container is already linked' });
    try {
      return await store.setProxmoxLink(box.id, { hostId: host.id, node: req.body.node, vmid: Number(req.body.vmid), endpoint: host.endpoint });
    } catch (error) {
      return serviceFailure(reply, error, /already linked/i.test(error?.message || '') ? 409 : 400);
    }
  });

  app.delete('/api/boxes/:id/proxmox', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const box = await store.getBox(req.params.id);
      if (!box) return reply.code(404).send({ error: 'box not found' });
      if (box.proxmox && lifecycleManager.hasActiveTarget(box.proxmox)) return reply.code(409).send({ error: 'container has an active lifecycle job' });
      return await store.clearProxmoxLink(box.id);
    } catch (error) { return serviceFailure(reply, error); }
  });

  app.post('/api/proxmox/lifecycle-jobs', { preHandler: requireAuth }, async (req, reply) => {
    if (['hostId', 'node', 'vmid'].some((key) => key in (req.body || {}))) {
      return reply.code(400).send({ error: 'lifecycle targets are resolved from the box link' });
    }
    try { return reply.code(201).send(await lifecycleManager.createJob(req.body || {})); }
    catch (error) { return serviceFailure(reply, error); }
  });
  app.get('/api/proxmox/lifecycle-jobs', { preHandler: requireAuth }, async () => lifecycleManager.listJobs());
  app.get('/api/proxmox/lifecycle-jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = lifecycleManager.getJob(req.params.id);
    return job || reply.code(404).send({ error: 'lifecycle job not found' });
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
        }, { requirePinFingerprint: false }),
        token,
      };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
    return netboxTest(candidate);
  });
  app.get('/api/status', { preHandler: requireAuth }, async (req, reply) => {
    // Serve the shared, server-side poll snapshot: every open tab reads the
    // same cache instead of driving its own SSH probe cycle, so connection
    // volume is independent of how many tabs are watching. See
    // src/server/statusPoller.js. index.js always wires a poller; tests stub
    // one — there is no on-demand probing fallback anymore.
    if (!statusPoller) return reply.code(503).send({ error: 'status poller unavailable' });
    return statusPoller.getSnapshot();
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

  // Client UI settings the browser needs at boot: terminal font/size
  // (validated/normalized server-side in config.js; the name is not secret),
  // the upload size limit, and voice dictation readiness.
  app.get('/api/ui-config', { preHandler: requireAuth }, async () => {
    return {
      termFont: config.termFont ?? null,
      termFontSize: config.termFontSize ?? 12,
      uploadMaxBytes,
      // The client renders no microphone at all unless voice is usable, so a
      // half-installed host never shows a button that only 503s.
      voice: (await voiceState()).enabled && Boolean(await currentEngine()),
      voiceMaxSeconds: config.voiceMaxSeconds ?? 120,
    };
  });

  // Land a pasted/dropped file on a box (or the Tmuxifier host for the local
  // shell), then type the absolute path into the tmux pane server-side when
  // the pane is a Claude/shell prompt (see tmuxInject.js) — the client no
  // longer types it. Fastify enforces uploadMaxBytes via bodyLimit (413);
  // filenames are allowlist-validated here and re-validated/quoted in
  // uploads.js. Auth runs at onRequest (before Fastify buffers the body) so
  // an unauthenticated client can't make the server buffer up to
  // uploadMaxBytes before the 401.
  app.post('/api/upload', { onRequest: requireAuth, bodyLimit: uploadMaxBytes }, async (req, reply) => {
    const name = String(req.query?.name || '');
    if (!validUploadName(name)) return reply.code(400).send({ error: 'invalid filename' });
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return reply.code(400).send({ error: 'missing file body' });
    const boxId = String(req.query?.box || '');
    if (boxId === '__local__') {
      try {
        const p = await saveUploadLocally(storedUploadName(name), body);
        const inj = await injectLocalUpload(localSession, p).catch(() => ({ injected: false, mode: 'error' }));
        return { path: p, ...inj };
      } catch (e) {
        return reply.code(500).send({ error: e?.message || 'could not save upload' });
      }
    }
    const box = await store.getBox(boxId);
    if (!box) return reply.code(400).send({ error: 'unknown box' });
    if (!boxActions?.uploadFile) return reply.code(500).send({ error: 'upload not supported' });
    let res;
    try {
      res = await boxActions.uploadFile(box, name, body);
    } catch (e) {
      return reply.code(502).send({ error: `upload failed: ${e?.message || 'error'}` });
    }
    if (!res.ok) return reply.code(502).send({ error: `upload failed: ${res.error}` });
    const inj = typeof boxActions.injectUploadPath === 'function'
      ? await boxActions.injectUploadPath(box, box.sessionName, res.path).catch(() => ({ injected: false, mode: 'error' }))
      : { injected: false, mode: 'error' };
    return { path: res.path, ...inj };
  });

  // --- Voice management (Settings -> Voice) ---------------------------------
  // All authenticated. Model ids are validated against the catalog allowlist
  // before reaching the install job, which shells out to apt/git/cmake.

  app.get('/api/voice/status', { preHandler: requireAuth }, async () => {
    const state = await voiceState();
    const settings = voiceStore ? await voiceStore.read() : { enabled: false, model: null };
    // Each model's own on-disk presence — NOT "is this the selected one".
    // Conflating the two would make an already-downloaded model read as
    // "will download" and re-trigger an install the operator did not need.
    const models = MODEL_IDS.map((id) => {
      const m = resolveModel(id);
      return { id, file: m.file, bytes: m.bytes, installed: modelInstalledFn(m.file) };
    });
    return {
      installed: Boolean(state.bin && state.model),
      enabled: state.enabled,
      model: settings.model,
      pinned: state.pinned,
      engine: (await currentEngine())?.state?.() ?? 'stopped',
      models,
      job: voiceInstallManager ? voiceInstallManager.current() : null,
    };
  });

  app.post('/api/voice/install', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceInstallManager) return reply.code(503).send({ error: 'install manager unavailable' });
    const model = String(req.body?.model || '');
    if (!resolveModel(model)) return reply.code(400).send({ error: 'unknown model' });
    try {
      return await voiceInstallManager.start(model);
    } catch (e) {
      // Single-flight: a concurrent install is a conflict, not a server error.
      const msg = e?.message || 'install failed';
      return reply.code(/already/i.test(msg) ? 409 : 500).send({ error: msg });
    }
  });

  app.get('/api/voice/install/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceInstallManager) return reply.code(503).send({ error: 'install manager unavailable' });
    const job = voiceInstallManager.getJob(String(req.params.id));
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return job;
  });

  app.patch('/api/voice/settings', { preHandler: requireAuth }, async (req, reply) => {
    if (!voiceStore) return reply.code(503).send({ error: 'voice settings unavailable' });
    const patch = {};
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
    if (req.body?.model !== undefined) {
      if (!resolveModel(String(req.body.model))) return reply.code(400).send({ error: 'unknown model' });
      patch.model = String(req.body.model);
    }
    try {
      const next = await voiceStore.update(patch);
      // Refresh the cached flag the permissions-policy hook reads, so a newly
      // loaded page gets microphone=(self) without waiting for another call.
      await voiceState();
      return next;
    } catch (e) {
      return reply.code(400).send({ error: e?.message || 'could not save voice settings' });
    }
  });

  // Transcribe a browser-recorded WAV with the local whisper engine and type
  // the result into the box's tmux pane, using the same pane-aware guard as
  // uploads (tmuxInject.js). Audio never leaves this host.
  //
  // The transcript is returned even when injection is refused — the client
  // puts it on the clipboard, so a busy pane never costs the user what they
  // just said. Fastify enforces voiceMaxBytes via bodyLimit (413).
  app.post('/api/voice', { onRequest: requireAuth, bodyLimit: voiceMaxBytes }, async (req, reply) => {
    const engine = await currentEngine();
    if (!(await voiceState()).enabled || !engine) {
      return reply.code(503).send({ error: 'voice dictation is not enabled' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return reply.code(400).send({ error: 'missing audio body' });

    const boxId = String(req.query?.box || '');
    const box = boxId === '__local__' ? null : await store.getBox(boxId);
    if (boxId !== '__local__' && !box) return reply.code(400).send({ error: 'unknown box' });

    let raw;
    try {
      raw = await engine.transcribe(body);
    } catch (e) {
      // Only pass through a genuine 4xx/5xx integer from the engine — an
      // out-of-range or non-numeric status (e.g. a hypothetical e.status =
      // 200) must not turn an engine failure into a non-error response.
      const rawStatus = Number(e?.status);
      const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502;
      return reply.code(status).send({ error: `transcription failed: ${e?.message || 'error'}` });
    }

    const text = normalizeTranscript(raw);
    if (!text) return { text: '', injected: false, mode: 'empty' };

    const session = box ? box.sessionName : localSession;
    let inj = { injected: false, mode: 'error' };
    if (boxId === '__local__') {
      inj = typeof injectLocalText === 'function'
        ? await injectLocalText(session, text).catch(() => ({ injected: false, mode: 'error' }))
        : { injected: false, mode: 'error' };
    } else if (typeof boxActions?.injectText === 'function') {
      inj = await boxActions.injectText(box, session, text).catch(() => ({ injected: false, mode: 'error' }));
    }
    return { text, ...inj };
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
        const { ohMyTmux, ohMyZsh, ohMyBash, tools } = req.query;
        // Reject unknown ids outright — catalog ids are the only strings that
        // may reach the generated script (see resolveTools in boxActions.js).
        // A repeated `tools=` parses to an array: fail closed (like an unknown
        // id) rather than silently coercing it to '' and provisioning no tools.
        if (tools !== undefined && typeof tools !== 'string') {
          socket.close(1008, 'invalid tools');
          return;
        }
        let toolIds;
        try {
          toolIds = resolveTools(tools ?? '');
        } catch {
          socket.close(1008, 'invalid tools');
          return;
        }
        const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
          installOhMyTmux: ohMyTmux === '1',
          installOhMyZsh: ohMyZsh === '1',
          installOhMyBash: ohMyBash === '1',
          tools: toolIds,
          // Same ordering rule as the non-interactive run: the session is
          // created by setupManager's ensureSession step once this finish has
          // been reported and any seeding has happened.
          createSession: false,
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
          // The interactive PTY is the setup job's manual-finish path. Report the
          // outcome to the manager (0 -> done; non-zero leaves needs-interactive).
          // No auto-rollback: a failed setup keeps the box (Retry / Remove in the UI).
          try { setupManager?.markInteractiveResult(boxId, code); } catch {}
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
      // A shell reads its rc files once, at startup: a terminal opened while
      // setup is still running gets an environment predating the seeded
      // credentials and the installed tools. Only 'running' gates — parked and
      // failed jobs must stay reachable — and provision mode above is
      // deliberately ungated so the interactive finish still works.
      if (setupManager?.currentForBox(boxId)?.status === 'running') {
        socket.close(1008, 'setting up');
        return;
      }
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
