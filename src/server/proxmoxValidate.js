const SAFE_HOST = /^[A-Za-z0-9_.-]+$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const TOKEN_ID = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/; // user@realm!name
const SAFE_ID = /^[A-Za-z0-9_.:/+-]+$/;                                // storage / bridge / template volid
const FINGERPRINT = /^[0-9A-Fa-f:]+$/;
const PUBKEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[A-Za-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-[A-Za-z0-9-]+)@openssh\.com)\s+[A-Za-z0-9+/=]+(\s+\S+)?$/;
const VERIFY_MODES = ['pin', 'ca', 'insecure'];

export function isIp(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}
export function isCidr(s) {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(String(s));
  return !!m && isIp(m[1]) && Number(m[2]) >= 0 && Number(m[2]) <= 32;
}

export function parseEndpoint(value) {
  let s = String(value || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!s) throw new Error('endpoint is required');
  let host = s;
  let port = 8006;
  const idx = s.lastIndexOf(':');
  if (idx !== -1) {
    host = s.slice(0, idx);
    port = Number(s.slice(idx + 1));
  }
  if (!SAFE_HOST.test(host)) throw new Error(`invalid endpoint host: ${JSON.stringify(host)}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid endpoint port: ${JSON.stringify(port)}`);
  return { host, port };
}

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function intInRange(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

export function assertHostInput(spec, { requireSecret = true } = {}) {
  if (!nonEmpty(spec.name)) throw new Error('host name is required');
  parseEndpoint(spec.endpoint);
  if (!TOKEN_ID.test(String(spec.tokenId || ''))) throw new Error('token id must look like user@realm!name');
  if (requireSecret && !nonEmpty(spec.tokenSecret)) throw new Error('token secret is required');
  const mode = spec.verifyMode || 'pin';
  if (!VERIFY_MODES.includes(mode)) throw new Error(`invalid verifyMode: ${JSON.stringify(mode)}`);
  if (mode === 'pin' && !FINGERPRINT.test(String(spec.fingerprint256 || ''))) {
    throw new Error('pin mode requires a fingerprint256');
  }
}

export function assertKeyInput(spec) {
  if (!nonEmpty(spec.name)) throw new Error('key name is required');
  const pk = String(spec.publicKey || '').trim();
  if (/\r?\n/.test(pk)) throw new Error('paste a single public key line');
  if (!PUBKEY.test(pk)) throw new Error('not a valid public key');
}

export function assertPresetInput(spec, { keyIds = [], hostIds = [] } = {}) {
  if (!nonEmpty(spec.name)) throw new Error('preset name is required');
  if (!hostIds.includes(spec.hostId)) throw new Error('preset host is unknown');
  if (!SAFE_ID.test(String(spec.template || ''))) throw new Error('invalid template');
  if (!SAFE_ID.test(String(spec.storage || ''))) throw new Error('invalid storage');
  if (!intInRange(spec.diskGiB, 1, 8192)) throw new Error('disk must be 1..8192 GiB');
  if (!intInRange(spec.cores, 1, 512)) throw new Error('cores must be 1..512');
  if (!intInRange(spec.memoryMiB, 16, 1048576)) throw new Error('memory must be >= 16 MiB');
  if (!intInRange(spec.swapMiB, 0, 1048576)) throw new Error('swap must be >= 0 MiB');
  const net = spec.net || {};
  if (!SAFE_ID.test(String(net.bridge || ''))) throw new Error('invalid bridge');
  if (net.vlan != null && !intInRange(net.vlan, 1, 4094)) throw new Error('vlan must be 1..4094');
  if (!['dhcp', 'static'].includes(net.ipMode)) throw new Error('ipMode must be dhcp or static');
  if (net.ipMode === 'static') {
    if (!isCidr(net.cidr)) throw new Error('static network requires a cidr like 192.168.1.50/24');
    if (!isIp(net.gateway)) throw new Error('static network requires a gateway ip');
  }
  // Keys are no longer preset-scoped: provisioning injects the host default key + all stored keys.
}

export function assertRootPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 5) throw new Error('root password must be at least 5 characters');
}

export function assertProvisionInput(spec) {
  if (!DNS_LABEL.test(String(spec.hostname || ''))) throw new Error('hostname must be a DNS label');
  if (spec.vmid != null && !intInRange(Number(spec.vmid), 100, 999999999)) throw new Error('vmid must be 100..999999999');
  if (spec.ip != null && spec.ip !== '' && !isCidr(spec.ip)) throw new Error('ip must be a CIDR like 192.168.1.50/24');
  if (spec.tags != null && (!Array.isArray(spec.tags) || spec.tags.some((t) => typeof t !== 'string'))) throw new Error('tags must be an array of strings');
}
