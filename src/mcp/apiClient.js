// The only thing in src/mcp/ that touches the network. Implements ONLY the
// routes in ROUTES — deprovision, every delete, forget-hostkey, and all
// settings/credential CRUD have no code path here. Not a flag, not a
// permission check; absent. Widening ROUTES is a reviewed edit.
import http from 'node:http';
import https from 'node:https';

export const ROUTES = {
  listBoxes: ['GET', '/api/boxes'],
  addBox: ['POST', '/api/boxes'],
  getStatus: ['GET', '/api/status'],
  getSeries: ['GET', '/api/health/series'],
  getEvents: ['GET', '/api/health/events'],
  getPane: ['GET', '/api/boxes/:id/pane'],
  sendKeys: ['POST', '/api/boxes/:id/keys'],
  startSetup: ['POST', '/api/boxes/:id/setup'],
  listSetupJobs: ['GET', '/api/setup'],
  getSetupJob: ['GET', '/api/setup/:id'],
  listFleetScripts: ['GET', '/api/fleet/scripts'],
  createFleetJob: ['POST', '/api/fleet/jobs'],
  listFleetJobs: ['GET', '/api/fleet/jobs'],
  getFleetJob: ['GET', '/api/fleet/jobs/:id'],
  cancelFleetJob: ['POST', '/api/fleet/jobs/:id/cancel'],
  listPresets: ['GET', '/api/proxmox/presets'],
  listProxmoxHosts: ['GET', '/api/proxmox/hosts'],
  listGuests: ['GET', '/api/proxmox/guests'],
  createProvision: ['POST', '/api/proxmox/provisions'],
  listProvisions: ['GET', '/api/proxmox/provisions'],
  getProvision: ['GET', '/api/proxmox/provisions/:id'],
  createLifecycleJob: ['POST', '/api/proxmox/lifecycle-jobs'],
  listLifecycleJobs: ['GET', '/api/proxmox/lifecycle-jobs'],
  getLifecycleJob: ['GET', '/api/proxmox/lifecycle-jobs/:id'],
};

export class ApiError extends Error {
  constructor(kind, message, { status, path, baseUrl } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; this.status = status; this.path = path; this.baseUrl = baseUrl;
  }
}

export function httpRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 15000, insecure = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    // Fixed Content-Length, never chunked — the netboxApi.js/proxmoxApi.js lesson:
    // reverse proxies in front of the server may reject chunked request bodies.
    const payload = body == null ? null : JSON.stringify(body);
    const reqHeaders = payload == null ? headers : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method, headers: reqHeaders, timeout: timeoutMs,
      ...(secure ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch {} resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

export function createApiClient({ baseUrl, token, insecure = false, timeoutMs = 15000, request = httpRequest }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const fill = (template, id) => template.replace(':id', encodeURIComponent(String(id)));

  async function call(name, { id, query, body } = {}) {
    const [method, template] = ROUTES[name];
    const path = id === undefined ? template : fill(template, id);
    // encodeURIComponent, not URLSearchParams: the latter spells a space as '+'.
    const pairs = Object.entries(query || {}).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    const qs = pairs.length ? `?${pairs.join('&')}` : '';
    let res;
    try {
      res = await request({ url: `${base}${path}${qs}`, method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body, timeoutMs, insecure });
    } catch (e) {
      throw new ApiError('unreachable', e?.code || e?.message || String(e), { path, baseUrl: base });
    }
    if (res.status === 401) throw new ApiError('unauthorized', res.json?.error || 'unauthorized', { status: 401, path, baseUrl: base });
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError('http', res.json?.error || `HTTP ${res.status}`, { status: res.status, path, baseUrl: base });
    }
    return res.json ?? null;
  }

  return {
    listBoxes: () => call('listBoxes'),
    addBox: (body) => call('addBox', { body }),
    getStatus: () => call('getStatus'),
    getSeries: (boxId) => call('getSeries', { query: boxId ? { box: boxId } : undefined }),
    getEvents: () => call('getEvents'),
    getPane: (boxId, { lines } = {}) => call('getPane', { id: boxId, query: { lines } }),
    sendKeys: (boxId, body) => call('sendKeys', { id: boxId, body }),
    startSetup: (boxId, options) => call('startSetup', { id: boxId, body: options }),
    listSetupJobs: () => call('listSetupJobs'),
    getSetupJob: (id) => call('getSetupJob', { id }),
    listFleetScripts: () => call('listFleetScripts'),
    createFleetJob: (body) => call('createFleetJob', { body }),
    listFleetJobs: () => call('listFleetJobs'),
    getFleetJob: (id) => call('getFleetJob', { id }),
    cancelFleetJob: (id) => call('cancelFleetJob', { id }),
    listPresets: () => call('listPresets'),
    listProxmoxHosts: () => call('listProxmoxHosts'),
    listGuests: () => call('listGuests'),
    createProvision: (body) => call('createProvision', { body }),
    listProvisions: () => call('listProvisions'),
    getProvision: (id) => call('getProvision', { id }),
    createLifecycleJob: (body) => call('createLifecycleJob', { body }),
    listLifecycleJobs: () => call('listLifecycleJobs'),
    getLifecycleJob: (id) => call('getLifecycleJob', { id }),
  };
}
