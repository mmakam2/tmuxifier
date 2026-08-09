import { test, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServiceJwt, buildFcmMessage, createFcmPush } from '../src/server/fcmPush.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('buildServiceJwt: verifiable RS256, correct claims', () => {
  const jwt = buildServiceJwt({ clientEmail: 'svc@p.iam.gserviceaccount.com', privateKeyPem: pem, tokenUri: 'https://oauth2.example.com/token', nowSec: 1000 });
  const [h, c, s] = jwt.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(c, 'base64url'))).toEqual({
    iss: 'svc@p.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.example.com/token', iat: 1000, exp: 4600,
  });
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).end().verify(publicKey, Buffer.from(s, 'base64url'));
  expect(ok).toBe(true);
});

test('buildFcmMessage: v1 shape with data payload for tap-through', () => {
  const { url, body } = buildFcmMessage({
    projectId: 'proj-1', fcmToken: 'tok-1',
    event: { boxId: 'b1', label: 'workbox', kind: 'agent-input', t: 5 },
  });
  expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
  expect(body.message.token).toBe('tok-1');
  expect(body.message.notification.title).toContain('workbox');
  expect(body.message.data).toEqual({ boxId: 'b1', kind: 'agent-input' });
  expect(body.message.android.priority).toBe('HIGH');
});

async function credsFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fcm-'));
  const p = path.join(dir, 'sa.json');
  await fs.writeFile(p, JSON.stringify({
    project_id: 'proj-1', client_email: 'svc@p.iam.gserviceaccount.com',
    private_key: pem, token_uri: 'https://oauth2.example.com/token',
  }));
  return p;
}

function fakeDeviceStore(targets) {
  const cleared = [];
  return {
    cleared,
    listNotifiable: async () => targets,
    clearFcmToken: async (id) => { cleared.push(id); },
  };
}

test('notify: token exchange once, one send per target, UNREGISTERED clears the token', async () => {
  const requests = [];
  const request = async (url, opts) => {
    requests.push({ url, opts });
    if (url.includes('oauth2')) return { status: 200, json: { access_token: 'at-1', expires_in: 3600 } };
    if (opts.body.includes('dead-token')) return { status: 404, json: { error: { status: 'NOT_FOUND' } } };
    return { status: 200, json: {} };
  };
  const ds = fakeDeviceStore([{ id: 'd1', fcmToken: 'live-token' }, { id: 'd2', fcmToken: 'dead-token' }]);
  const push = createFcmPush({ credentialsPath: await credsFile(), deviceStore: ds, request, now: () => 1_000_000 });
  await push.notify({ boxId: 'b1', label: 'workbox', kind: 'agent-input', t: 1 });
  const tokenCalls = requests.filter((r) => r.url.includes('oauth2'));
  const sends = requests.filter((r) => r.url.includes('fcm.googleapis.com'));
  expect(tokenCalls.length).toBe(1); // cached across the fan-out
  expect(sends.length).toBe(2);
  expect(sends[0].opts.headers.authorization).toBe('Bearer at-1');
  expect(ds.cleared).toEqual(['d2']);
});

test('notify ignores non-agent kinds and never rejects on transport failure', async () => {
  const ds = fakeDeviceStore([{ id: 'd1', fcmToken: 't' }]);
  const boom = async () => { throw new Error('network down'); };
  const push = createFcmPush({ credentialsPath: await credsFile(), deviceStore: ds, request: boom, now: () => 1 });
  await expect(push.notify({ kind: 'down', boxId: 'b', label: 'x', t: 1 })).resolves.toBeUndefined();
  await expect(push.notify({ kind: 'agent-input', boxId: 'b', label: 'x', t: 1 })).resolves.toBeUndefined();
});
