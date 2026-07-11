import https from 'node:https';
import { tlsProbe, derToPem, normFp } from './tlsPin.js';

function httpsRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 15000, tls: tlsOpts = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Send a fixed Content-Length. Without it, req.write() makes Node use chunked
    // transfer-encoding, which PVE's pveproxy rejects with "501 chunked transfer encoding
    // not supported" — so every POST with a body (e.g. createLxc) would fail.
    const reqHeaders = body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) };
    const req = https.request({ hostname: u.hostname, port: u.port || 8006, path: u.pathname + u.search, method, headers: reqHeaders, timeout: timeoutMs,
      rejectUnauthorized: tlsOpts.rejectUnauthorized !== false,
      ...(tlsOpts.ca ? { ca: tlsOpts.ca } : {}),
      ...(typeof tlsOpts.checkServerIdentity === 'function' ? { checkServerIdentity: tlsOpts.checkServerIdentity } : {}),
    }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, statusMessage: res.statusMessage, json, text: data }); }); });
    req.on('timeout', () => req.destroy(new Error('Proxmox request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cleanParams(params) { const out = {}; for (const [k, v] of Object.entries(params || {})) { if (v === undefined || v === null) continue; out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v; } return out; }

export function createProxmoxClient({ host, request = httpsRequest, connect = tlsProbe, timeoutMs = 15000 }) {
  const base = `https://${host.endpoint}/api2/json`;
  const idx = String(host.endpoint).lastIndexOf(':');
  const hostName = idx === -1 ? host.endpoint : host.endpoint.slice(0, idx);
  const port = idx === -1 ? 8006 : Number(host.endpoint.slice(idx + 1)) || 8006;
  let tlsPromise = null;
  function resolveTls() {
    if (tlsPromise) return tlsPromise;
    tlsPromise = (async () => {
      if (host.verifyMode === 'ca') return { rejectUnauthorized: true };
      if (host.verifyMode === 'insecure') return { rejectUnauthorized: false };
      const want = normFp(host.fingerprint256);
      const probe = await connect({ host: hostName, port, timeoutMs });
      if (!want || normFp(probe.fingerprint256) !== want) throw new Error('TLS fingerprint mismatch — the Proxmox host certificate changed; re-add the host to accept the new certificate');
      const trust = probe.chain && probe.chain.length ? probe.chain : [probe.raw];
      return { ca: trust.map(derToPem), rejectUnauthorized: true, checkServerIdentity: () => undefined };
    })().catch((e) => { tlsPromise = null; throw e; });
    return tlsPromise;
  }
  async function call(method, p, params) {
    const tlsOpts = await resolveTls();
    const opts = { url: `${base}${p}`, method, headers: { Authorization: `PVEAPIToken=${host.tokenId}=${host.tokenSecret}` }, timeoutMs, tls: tlsOpts };
    if (params) { opts.body = new URLSearchParams(cleanParams(params)).toString(); opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const res = await request(opts);
    if (res.status >= 400) {
      // PVE puts the real reason in the HTTP status message (and sometimes the body);
      // surface it so errors like 501 aren't opaque ("Proxmox API error 501" alone is useless).
      const detail = res.statusMessage
        || (res.json && (res.json.message || (res.json.errors && JSON.stringify(res.json.errors))))
        || (res.text || '').trim().slice(0, 300);
      const base = res.status === 401 ? 'Proxmox token rejected (401)'
        : res.status === 403 ? 'Proxmox token lacks permission (403)'
        : `Proxmox API error ${res.status}`;
      throw new Error(detail ? `${base}: ${detail}` : base);
    }
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
    clusterResources: () => call('GET', '/cluster/resources?type=vm'),
    createLxc: (node, params) => call('POST', `/nodes/${enc(node)}/lxc`, params),
    startLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/start`, {}),
    listLxc: (node) => call('GET', `/nodes/${enc(node)}/lxc`),
    shutdownLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/shutdown`, { forceStop: false }),
    stopLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/stop`, {}),
    rebootLxc: (node, vmid) => call('POST', `/nodes/${enc(node)}/lxc/${enc(vmid)}/status/reboot`, {}),
    destroyLxc: (node, vmid) => call('DELETE', `/nodes/${enc(node)}/lxc/${enc(vmid)}`, {
      purge: true,
      'destroy-unreferenced-disks': true,
    }),
    taskStatus: (node, upid) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/status`),
    taskLog: (node, upid, start = 0) => call('GET', `/nodes/${enc(node)}/tasks/${enc(upid)}/log?start=${enc(start)}&limit=500`),
    lxcInterfaces: (node, vmid) => call('GET', `/nodes/${enc(node)}/lxc/${enc(vmid)}/interfaces`),
  };
}
export async function inspectEndpoint(endpoint, { connect = tlsProbe, timeoutMs = 8000 } = {}) {
  const idx = String(endpoint).lastIndexOf(':');
  const host = idx === -1 ? endpoint : endpoint.slice(0, idx);
  const port = idx === -1 ? 8006 : Number(endpoint.slice(idx + 1)) || 8006;
  let probe; try { probe = await connect({ host, port, timeoutMs }); } catch (e) { return { reachable: false, error: e.message }; }
  return { reachable: true, fingerprint256: probe.fingerprint256 || null, subject: probe.subject ? probe.subject.CN || '' : '', issuer: probe.issuer ? probe.issuer.CN || '' : '', validTo: probe.valid_to || null, caValid: probe.authorized === true };
}
