export interface Box {
  id: string; label: string; host: string; user?: string; port?: number;
  proxyJump?: string; sessionName: string; startupCommand?: string; tags: string[]; source: string;
}
export type AddBoxSpec = Partial<Box>;
export interface Status { reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean; nextProbeAt?: number; sessions?: { name: string; windows: number }[]; error?: string; }

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
  async importSsh() { return j<Box[]>(await fetch('/api/import', { method: 'POST' })); },
  async status() { return j<Record<string, Status>>(await fetch(`/api/status?t=${Date.now()}`)); },
  async getLocalShell() { return j<{ shell: string }>(await fetch('/api/local-shell')); },
  async updateLocalShell(shell: string) { return j<{ ok: boolean }>(await fetch('/api/local-shell', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell }) })); },
  async reconnectLocalShell() { return j<{ ok: boolean }>(await fetch('/api/local-shell/reconnect', { method: 'POST' })); },
};
