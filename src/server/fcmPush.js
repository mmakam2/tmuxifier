import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { NOTIFY_KINDS } from './deviceStore.js';

// FCM HTTP v1 sender, dependency-free in the oidcAuth.js mold: sign the
// service-account JWT with node:crypto, trade it for an OAuth2 access token
// (cached until near expiry), POST the message. Subscribed to
// healthHistory.onEvent — the server-push seam (see healthHistory.js): this
// module is what subscribes to it when TMUXIFIER_FCM_CREDENTIALS is set,
// browser notifications still poll client-side regardless. Failure posture:
// log and continue, never reject — a push must not disturb the poll loop
// (same rule as every side-channel).

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const KINDS = new Set(NOTIFY_KINDS);
// Inline on purpose: the server must not import web code.
const AGENT_LABEL = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', pi: 'pi', agy: 'Antigravity' };
const agentLabel = (event) => (Object.hasOwn(AGENT_LABEL, event.agent) ? AGENT_LABEL[event.agent] : 'Claude');
const titleOf = (event) => {
  if (event.kind === 'agent-blocked') return `${agentLabel(event)} needs you`;
  if (event.kind === 'agent-input') return `${agentLabel(event)} is waiting`;
  if (event.kind === 'agent-done') return 'Agent finished';
  return event.kind;
};

const b64uJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function buildServiceJwt({ clientEmail, privateKeyPem, tokenUri, nowSec }) {
  const input = `${b64uJson({ alg: 'RS256', typ: 'JWT' })}.${b64uJson({
    iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: nowSec, exp: nowSec + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(input).end().sign(privateKeyPem).toString('base64url');
  return `${input}.${sig}`;
}

// Where the agent is: `<session> › <window>` (U+203A; the window is `<index>:<name>`), plus
// `.<paneIndex>` when the event carries one (only when that window held more than one agent). An
// older log entry has no window and names the session alone; with no session there is no place.
function placeOf(event) {
  if (!event.session) return '';
  let place = ` in ${event.session}`;
  if (event.window) {
    place += ` \u203A ${event.window}`;
    if (Number.isInteger(event.paneIndex)) place += `.${event.paneIndex}`;
  }
  return place;
}

function pushBody(event) {
  const where = placeOf(event);
  if (event.kind === 'agent-blocked') {
    const cause = String(event.cause || 'permission');
    return `${cause.charAt(0).toUpperCase()}${cause.slice(1)} prompt${where}`;
  }
  if (event.kind === 'agent-input') return `${agentLabel(event)} wants your input${where}.`;
  return `${agentLabel(event)} exited${where}.`;
}

// The payload the Android app jumps with: the box and kind, and where in it (session, pane, window)
// when the event knows. FCM data values must all be strings.
function dataOf(event) {
  return {
    boxId: String(event.boxId),
    kind: String(event.kind),
    ...(event.session ? { session: String(event.session) } : {}),
    ...(event.pane ? { pane: String(event.pane) } : {}),
    ...(event.windowId ? { windowId: String(event.windowId) } : {}),
  };
}

// Android posts a notification that arrives while the app is in the background itself, so the
// per-pane replacement key (a later push for the same pane replaces the earlier one) has to be
// set here, not by the app. An event with no pane has no such key.
function androidOf(event) {
  if (!event.pane) return { priority: 'HIGH' };
  return { priority: 'HIGH', notification: { tag: `${event.boxId}:${event.pane}` } };
}

export function buildFcmMessage({ projectId, fcmToken, event }) {
  return {
    url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    body: {
      message: {
        token: fcmToken,
        notification: {
          title: `${event.label} — ${titleOf(event)}`,
          body: pushBody(event),
        },
        data: dataOf(event),
        android: androidOf(event),
      },
    },
  };
}

// Minimal https JSON POST; injectable in tests via the `request` seam.
function httpsRequest(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('fcm request timeout')));
    req.end(body);
  });
}

export function createFcmPush({ credentialsPath, deviceStore, request = httpsRequest, now = () => Date.now(), log = (msg) => console.error(msg) }) {
  let creds = null;
  let cached = null; // { accessToken, expiresAtMs }

  async function loadCreds() {
    if (!creds) creds = JSON.parse(await readFile(credentialsPath, 'utf8'));
    return creds;
  }
  async function accessToken() {
    if (cached && cached.expiresAtMs - 60_000 > now()) return cached.accessToken;
    const c = await loadCreds();
    const jwt = buildServiceJwt({ clientEmail: c.client_email, privateKeyPem: c.private_key, tokenUri: c.token_uri, nowSec: Math.floor(now() / 1000) });
    const res = await request(c.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent(GRANT)}&assertion=${jwt}`,
    });
    if (res.status !== 200 || !res.json?.access_token) throw new Error(`token exchange failed (${res.status})`);
    cached = { accessToken: res.json.access_token, expiresAtMs: now() + Number(res.json.expires_in || 3600) * 1000 };
    return cached.accessToken;
  }

  return {
    async notify(event) {
      if (!KINDS.has(event?.kind)) return;
      let targets;
      try { targets = await deviceStore.listNotifiable(event.kind); } catch { return; }
      for (const d of targets) {
        try {
          const at = await accessToken();
          const { url, body } = buildFcmMessage({ projectId: (await loadCreds()).project_id, fcmToken: d.fcmToken, event });
          const res = await request(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          // FCM reports a gone registration as 404/NOT_FOUND or 400/UNREGISTERED:
          // drop that device's delivery, never its auth.
          const detail = JSON.stringify(res.json || {});
          if (res.status === 404 || (res.status === 400 && detail.includes('UNREGISTERED'))) {
            await deviceStore.clearFcmToken(d.id);
          } else if (res.status !== 200) {
            log(`fcm send to ${d.id} failed (${res.status})`);
          }
        } catch (e) {
          log(`fcm push failed: ${e?.message || e}`);
        }
      }
    },
  };
}
