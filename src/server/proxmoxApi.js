import https from 'node:https';

// Default transport. Tests inject `request` instead, so this is never exercised in unit tests.
function httpsRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 15000, tls = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 8006,
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: tls.rejectUnauthorized !== false,
      checkServerIdentity: tls.checkServerIdentity,
      timeout: timeoutMs,
    }, (res) => {
      const cert = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      const authorized = res.socket.authorized === true;
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, text: data, cert, authorized });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function normFp(s) { return String(s || '').toUpperCase().replace(/[^0-9A-F]/g, ''); }

function tlsOptionsFor(host) {
  if (host.verifyMode === 'ca') return { rejectUnauthorized: true };
  if (host.verifyMode === 'insecure') return { rejectUnauthorized: false };
  const want = normFp(host.fingerprint256);
  return {
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const got = normFp(cert && cert.fingerprint256);
      if (!got || got !== want) return new Error('TLS fingerprint mismatch — the Proxmox host cert changed');
      return undefined;
    },
  };
}

function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}

export function createProxmoxClient({ host, request = httpsRequest, timeoutMs = 15000 }) {
  const base = `https://${host.endpoint}/api2/json`;
  const tls = tlsOptionsFor(host);

  async function call(method, p, params) {
    const opts = {
      url: `${base}${p}`,
      method,
      headers: { Authorization: `PVEAPIToken=${host.tokenId}=${host.tokenSecret}` },
      timeoutMs,
      tls,
    };
    if (params) {
      opts.body = new URLSearchParams(cleanParams(params)).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await request(opts);
    if (res.status === 401) throw new Error('Proxmox token rejected (401)');
    if (res.status === 403) throw new Error('Proxmox token lacks permission (403)');
    if (res.status >= 400) throw new Error(`Proxmox API error ${res.status}`);
    return res.json ? res.json.data : null;
  }

  const enc = encodeURIComponent;
  return {
    version: () => call('GET', '/version'),
    nodes: () => call('GET', '/nodes'),
    storages: (node) => call('GET', `/nodes/${enc(node)}/storage`),
    templates: (node, storage) => call('GET', `/nodes/${enc(node)}/storage/${enc(storage)}/content?content=vztmpl`),
    bridges: (node) => call('GET', `/nodes/${enc(node)}/network?type=bridge`),
    nextId: () => call('GET', '/cluster/nextid'),
    createLxc: (node, params) => call('POST', `/nodes/${enc(node)}/lxc`, params),
    startLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/start`, {}),
    taskStatus: (node, upid) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/status`),
    taskLog: (node, upid, start = 0) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/log?start=${start}&limit=500`),
    lxcInterfaces: (node, vmid) => call('GET', `/nodes/${enc(node)}/lxc/${enc(vmid)}/interfaces`),
  };
}

export async function inspectEndpoint(endpoint, { request = httpsRequest, timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await request({ url: `https://${endpoint}/api2/json/version`, method: 'GET', timeoutMs, tls: { rejectUnauthorized: false } });
  } catch (e) {
    return { reachable: false, error: e.message };
  }
  const cert = res.cert || {};
  return {
    reachable: true,
    fingerprint256: cert.fingerprint256 || null,
    subject: cert.subject ? cert.subject.CN || '' : '',
    issuer: cert.issuer ? cert.issuer.CN || '' : '',
    validTo: cert.valid_to || null,
    caValid: res.authorized === true,
  };
}
