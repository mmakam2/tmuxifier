export interface PveBoxLink { hostId: string; node: string; vmid: number; endpoint: string; }
export interface Box {
  id: string; label: string; host: string; user?: string; port?: number;
  proxyJump?: string; sessionName: string; startupCommand?: string; tags: string[];
  source: string; proxmox?: PveBoxLink;
}
export type AddBoxSpec = Partial<Box>;
export interface BoxMetrics {
  load1?: number; load5?: number; load15?: number; cpus?: number;
  cpuPct?: number;        // true cgroup CPU utilization % (server-derived); preferred over load
  cpuUsageUsec?: number;  // cumulative cgroup CPU counter; presence = a cgroup host (still warming up if no cpuPct)
  memTotalKb?: number; memAvailKb?: number;
  diskTotalKb?: number; diskUsedKb?: number; diskPct?: number; uptimeSec?: number;
}
export type ProxmoxBoxState = 'running' | 'stopped' | 'missing' | 'unknown';
export interface Status {
  reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean;
  hostKeyChanged?: boolean;
  nextProbeAt?: number; sessions?: { name: string; windows: number; attached?: boolean; activity?: number }[];
  metrics?: BoxMetrics; error?: string;
  proxmoxState?: ProxmoxBoxState; proxmoxNode?: string; proxmoxVmid?: number;
}
// One point of a box's rolling health series (a status poll projected server-side
// in healthHistory.js). A missing metric is omitted — the sparkline draws a gap.
// `stopped` marks a confirmed-by-Proxmox stopped box: `up` is true for it (see
// sampleOf), so this flag is how the sparkline/health UI tells "healthy stopped"
// apart from a genuinely reachable box.
export interface Sample { t: number; up: boolean; stopped?: boolean; tmux?: boolean; needsAuth?: boolean; keyChanged?: boolean; cpuPct?: number; memPct?: number; diskPct?: number; }
export type HealthEventKind = 'down' | 'up' | 'needs-auth' | 'key-changed' | 'threshold' | 'threshold-clear';
export interface HealthEvent {
  seq: number; boxId: string; label: string; host: string; t: number;
  kind: HealthEventKind; reason?: string; metric?: 'cpu' | 'mem' | 'disk'; value?: number;
}
export type FleetTargetStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'cancelled' | 'interrupted';
export type FleetJobStatus = 'running' | 'done' | 'cancelled' | 'interrupted';
export interface FleetTarget {
  boxId: string; label: string; host: string; status: FleetTargetStatus;
  code: number | null; stdout: string; stderr: string; truncated: boolean;
  error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface FleetJob {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  concurrency: number; timeoutMs: number; targets: FleetTarget[];
}
export interface FleetJobSummary {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  targetCount: number; okCount: number; errorCount: number;
}
export type SetupStatus = 'running' | 'done' | 'error' | 'needs-interactive' | 'interrupted' | 'superseded';
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; }
export interface SetupSummary {
  id: string; boxId: string; boxLabel: string; status: SetupStatus;
  phase: 'waiting-ssh' | 'running' | null; options: SetupOptions; error: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface SetupJob extends SetupSummary { log: string; }

// Central 401 seam. When the session cookie expires (or the server restarts
// with a new secret) every poller and action starts failing with 401s; without
// one place to notice, the dashboard silently freezes at its last-painted
// state. main.ts registers a handler that tears the dashboard down and routes
// back to the login screen. The handler must tolerate firing for /api/login's
// own wrong-password 401 (main.ts no-ops when the login screen is already up).
let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null) { unauthorizedHandler = fn; }

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  }
  return res.json();
}
export const api = {
  async me() { return (await fetch('/api/me')).ok; },
  async authInfo() { return j<{ mode: 'password' | 'google' }>(await fetch('/api/auth/info')); },
  async login(password: string) { return j<{ ok: boolean }>(await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })); },
  async logout() { await fetch('/api/logout', { method: 'POST' }); },
  async boxes() { return j<Box[]>(await fetch('/api/boxes')); },
  async addBox(spec: AddBoxSpec) { return j<Box>(await fetch('/api/boxes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) })); },
  async removeBox(id: string) { return j(await fetch(`/api/boxes/${id}`, { method: 'DELETE' })); },
  async updateBox(id: string, patch: Partial<Box>) {
    return j<Box>(await fetch(`/api/boxes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
  },
  async setProxmoxLink(boxId: string, link: Omit<PveBoxLink, 'endpoint'>) {
    return j<Box>(await fetch(`/api/boxes/${boxId}/proxmox`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(link) }));
  },
  async clearProxmoxLink(boxId: string) {
    return j<Box>(await fetch(`/api/boxes/${boxId}/proxmox`, { method: 'DELETE' }));
  },
  async reconnectBox(id: string) { return j<{ ok: boolean }>(await fetch(`/api/boxes/${id}/reconnect`, { method: 'POST' })); },
  async forgetHostKey(id: string) { return j<{ ok: boolean }>(await fetch(`/api/boxes/${id}/forget-hostkey`, { method: 'POST' })); },
  async probeSessions(spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string }) {
    return j<Status>(await fetch('/api/boxes/probe-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) }));
  },
  async importBoxes(payload: unknown) {
    return j<{ added: Box[]; skipped: number }>(await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
  },
  async status() { return j<Record<string, Status>>(await fetch(`/api/status?t=${Date.now()}`)); },
  async healthSeries() { return j<Record<string, Sample[]>>(await fetch(`/api/health/series?t=${Date.now()}`)); },
  async healthEvents() { return j<{ events: HealthEvent[]; latestSeq: number }>(await fetch(`/api/health/events?t=${Date.now()}`)); },
  async uiConfig() { return j<{ termFont: string | null; termFontSize: number; uploadMaxBytes: number }>(await fetch('/api/ui-config')); },
  async uploadFile(boxId: string, name: string, blob: Blob) {
    return j<{ path: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' }>(await fetch(`/api/upload?box=${encodeURIComponent(boxId)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
    }));
  },
  async getLocalShell() { return j<{ shell: string }>(await fetch('/api/local-shell')); },
  async updateLocalShell(shell: string) { return j<{ ok: boolean }>(await fetch('/api/local-shell', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell }) })); },
  async reconnectLocalShell() { return j<{ ok: boolean }>(await fetch('/api/local-shell/reconnect', { method: 'POST' })); },
  async createFleetJob(boxIds: string[], command: string) {
    return j<FleetJob>(await fetch('/api/fleet/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxIds, command }) }));
  },
  async listFleetJobs() { return j<FleetJobSummary[]>(await fetch('/api/fleet/jobs')); },
  async getFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}?t=${Date.now()}`)); },
  async cancelFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}/cancel`, { method: 'POST' })); },
  async startSetup(boxId: string, options: SetupOptions) {
    return j<SetupSummary>(await fetch(`/api/boxes/${boxId}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) }));
  },
  async getSetup(id: string) { return j<SetupJob>(await fetch(`/api/setup/${id}?t=${Date.now()}`)); },
  async getBoxSetup(boxId: string): Promise<SetupJob | null> {
    const res = await fetch(`/api/boxes/${boxId}/setup?t=${Date.now()}`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`setup lookup failed (${res.status})`);
    return res.json() as Promise<SetupJob>;
  },
  async listSetups() { return j<SetupSummary[]>(await fetch('/api/setup')); },
};
