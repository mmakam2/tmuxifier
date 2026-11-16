import { test, expect } from 'vitest';
import {
  verifyFace, hostStateOf, formatVersion, splitPublicKey, certFace, validateAddHost, validateAddKey, validatePassword,
  ROOT_PASSWORD_MIN,
} from '../src/web/settingsProxmoxView.ts';

// --- TLS mode legend -------------------------------------------------------

test('verifyFace: pin and ca are neutral, insecure is the only warning', () => {
  expect(verifyFace('pin')).toMatchObject({ label: 'pinned', tone: 'plain' });
  expect(verifyFace('ca')).toMatchObject({ label: 'CA verified', tone: 'plain' });
  expect(verifyFace('insecure')).toMatchObject({ label: 'not verified', tone: 'warn' });
});

test('verifyFace: every face explains itself in a title', () => {
  for (const mode of ['pin', 'ca', 'insecure']) expect(verifyFace(mode).title.length).toBeGreaterThan(20);
});

test('verifyFace: an unknown mode from a stale store degrades to a warning, never a clean bill', () => {
  expect(verifyFace('bogus')).toMatchObject({ tone: 'warn' });
});

// --- Host state ------------------------------------------------------------

test('hostStateOf: checking is an off lamp with no claim', () => {
  expect(hostStateOf({ phase: 'checking' })).toEqual({ lamp: 'off', text: 'Checking…', tone: 'plain' });
});

test('hostStateOf: a good test is a green lamp and names the version when PVE reported one', () => {
  expect(hostStateOf({ phase: 'ok', version: { version: '8.2.4', release: '8.2', repoid: 'abc' } }))
    .toEqual({ lamp: 'green', text: 'Reachable · PVE 8.2.4', tone: 'plain' });
  expect(hostStateOf({ phase: 'ok', version: null })).toMatchObject({ lamp: 'green', text: 'Reachable' });
});

test('hostStateOf: a failure is a red lamp carrying the server message verbatim', () => {
  expect(hostStateOf({ phase: 'error', message: 'connect ECONNREFUSED 192.168.1.20:8006' }))
    .toEqual({ lamp: 'red', text: 'connect ECONNREFUSED 192.168.1.20:8006', tone: 'err' });
});

test('hostStateOf: an empty failure message still says something', () => {
  expect(hostStateOf({ phase: 'error', message: '' }).text).toBe('Test failed');
});

// --- Version ---------------------------------------------------------------

test('formatVersion: only a short, plain version string passes — box and PVE output are untrusted', () => {
  expect(formatVersion({ version: '8.2.4' })).toBe('PVE 8.2.4');
  expect(formatVersion({ version: '9.0.0~rc1' })).toBe('PVE 9.0.0~rc1');
  expect(formatVersion({ version: 'x'.repeat(40) })).toBeNull();
  expect(formatVersion({ version: '8.2 <b>' })).toBeNull();
  expect(formatVersion({ version: 8 })).toBeNull();
  expect(formatVersion('8.2.4')).toBeNull();
  expect(formatVersion(null)).toBeNull();
  expect(formatVersion(undefined)).toBeNull();
});

// --- Public key display ----------------------------------------------------

test('splitPublicKey: type, shortened body, comment', () => {
  const body = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExample';
  const k = splitPublicKey(`ssh-ed25519 ${body} root@tmuxifier`);
  expect(k).toEqual({ type: 'ssh-ed25519', body: `${body.slice(0, 12)}…${body.slice(-8)}`, comment: 'root@tmuxifier' });
});

test('splitPublicKey: a short body is shown whole, a missing comment is empty', () => {
  expect(splitPublicKey('ssh-ed25519 AAAAshort')).toEqual({ type: 'ssh-ed25519', body: 'AAAAshort', comment: '' });
});

test('splitPublicKey: a comment with spaces survives', () => {
  expect(splitPublicKey('ssh-rsa AAAAB3Nza me at laptop')?.comment).toBe('me at laptop');
});

test('splitPublicKey: anything that is not "<type> <base64> [comment]" is null, so the caller falls back to raw text', () => {
  expect(splitPublicKey('')).toBeNull();
  expect(splitPublicKey('just words')).toBeNull();
  expect(splitPublicKey('ssh-ed25519')).toBeNull();
  expect(splitPublicKey('ssh-ed25519 not*base64! c')).toBeNull();
  expect(splitPublicKey(null)).toBeNull();
});

// --- Inspect result --------------------------------------------------------

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

test('certFace: a CA-valid endpoint verifies normally, mode ca', () => {
  expect(certFace({ reachable: true, caValid: true, fingerprint256: FP }))
    .toEqual({ tone: 'ok', mode: 'ca', fingerprint: FP, text: 'Certificate is CA-valid, so it verifies normally.' });
});

test('certFace: a self-signed endpoint is pinned and shows the fingerprint it will pin', () => {
  expect(certFace({ reachable: true, caValid: false, fingerprint256: FP }))
    .toEqual({ tone: 'pin', mode: 'pin', fingerprint: FP, text: 'Self-signed certificate. Adding the host pins this fingerprint.' });
});

test('certFace: unreachable carries the reason and no mode, so nothing downstream can save a pin', () => {
  expect(certFace({ reachable: false, caValid: false, fingerprint256: null, error: 'ECONNREFUSED' }))
    .toEqual({ tone: 'err', mode: null, fingerprint: null, text: 'ECONNREFUSED' });
  expect(certFace({ reachable: false, caValid: false, fingerprint256: null }).text).toBe('Endpoint unreachable.');
});

test('certFace: reachable but no fingerprint cannot be pinned', () => {
  expect(certFace({ reachable: true, caValid: false, fingerprint256: null }))
    .toMatchObject({ tone: 'err', mode: null, fingerprint: null });
});

// --- Add host --------------------------------------------------------------

const GOOD = { name: 'lab-pve', endpoint: 'pve.example.com:8006', tokenId: 'root@pam!tmuxifier', tokenSecret: 'secret', mode: 'ca' };

test('validateAddHost: a complete draft with a resolved certificate passes', () => {
  expect(validateAddHost(GOOD)).toBeNull();
  expect(validateAddHost({ ...GOOD, mode: 'pin', fingerprint256: FP })).toBeNull();
});

test('validateAddHost: names the first missing field, in form order, with the field to focus', () => {
  expect(validateAddHost({ ...GOOD, endpoint: '  ' })).toEqual({ field: 'endpoint', message: 'Enter the endpoint, like pve.example.com:8006.' });
  expect(validateAddHost({ ...GOOD, name: '' })).toEqual({ field: 'name', message: 'Give the host a name.' });
  expect(validateAddHost({ ...GOOD, tokenId: '' })).toEqual({ field: 'tokenId', message: 'Enter the API token id, like user@pam!tmuxifier.' });
  expect(validateAddHost({ ...GOOD, tokenSecret: '' })).toEqual({ field: 'tokenSecret', message: 'Enter the API token secret.' });
});

test('validateAddHost: an uninspected endpoint sends the operator to Inspect, not to a server error', () => {
  expect(validateAddHost({ ...GOOD, mode: null })).toEqual({ field: 'inspect', message: 'Inspect the endpoint first. Its certificate decides how Tmuxifier verifies it.' });
});

test('validateAddHost: a pin with no fingerprint is refused', () => {
  expect(validateAddHost({ ...GOOD, mode: 'pin', fingerprint256: null })?.field).toBe('inspect');
});

// --- Add key / password ----------------------------------------------------

test('validateAddKey: both fields, name first', () => {
  expect(validateAddKey({ name: '', publicKey: 'ssh-ed25519 AAAA' })).toEqual({ field: 'name', message: 'Name the key so you can tell it apart later.' });
  expect(validateAddKey({ name: 'laptop', publicKey: '  ' })).toEqual({ field: 'publicKey', message: 'Paste the public key (the one ending in .pub).' });
  expect(validateAddKey({ name: 'laptop', publicKey: 'ssh-ed25519 AAAA' })).toBeNull();
});

test('validatePassword: empty, short, mismatch — in that order; the minimum matches the server', () => {
  expect(ROOT_PASSWORD_MIN).toBe(5);
  expect(validatePassword('', '')).toEqual({ field: 'password', message: `Enter a password of at least ${ROOT_PASSWORD_MIN} characters.` });
  expect(validatePassword('abcd', 'abcd')).toEqual({ field: 'password', message: `Use at least ${ROOT_PASSWORD_MIN} characters.` });
  expect(validatePassword('abcde', 'abcdf')).toEqual({ field: 'confirm', message: 'The two passwords do not match.' });
  expect(validatePassword('abcde', 'abcde')).toBeNull();
});
