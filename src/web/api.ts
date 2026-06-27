export interface Box {
  id: string; label: string; host: string; user?: string; port?: number;
  proxyJump?: string; sessionName: string; startupCommand?: string; tags: string[]; source: string;
}
export type AddBoxSpec = Partial<Box>;
export interface Status { reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean; nextProbeAt?: number; sessions?: { name: string; windows: number }[]; error?: string; }
export type FleetTargetStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted';
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

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
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
  async reconnectBox(id: string) { return j<{ ok: boolean }>(await fetch(`/api/boxes/${id}/reconnect`, { method: 'POST' })); },
  async probeSessions(spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string }) {
    return j<Status>(await fetch('/api/boxes/probe-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) }));
  },
  async importBoxes(payload: unknown) {
    return j<{ added: Box[]; skipped: number }>(await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
  },
  async status() { return j<Record<string, Status>>(await fetch(`/api/status?t=${Date.now()}`)); },
  async uiConfig() { return j<{ termFont: string | null; termFontSize: number }>(await fetch('/api/ui-config')); },
  async getLocalShell() { return j<{ shell: string }>(await fetch('/api/local-shell')); },
  async updateLocalShell(shell: string) { return j<{ ok: boolean }>(await fetch('/api/local-shell', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell }) })); },
  async reconnectLocalShell() { return j<{ ok: boolean }>(await fetch('/api/local-shell/reconnect', { method: 'POST' })); },
  async createFleetJob(boxIds: string[], command: string) {
    return j<FleetJob>(await fetch('/api/fleet/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxIds, command }) }));
  },
  async listFleetJobs() { return j<FleetJobSummary[]>(await fetch('/api/fleet/jobs')); },
  async getFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}?t=${Date.now()}`)); },
  async cancelFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}/cancel`, { method: 'POST' })); },
};
