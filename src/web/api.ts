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
  // Distro identity from the box's /etc/os-release (`ID`/`VERSION_ID`), or
  // `uname -s` where that file is absent. Server-allowlisted to a bare token.
  osId?: string; osVer?: string;
}
export type ProxmoxBoxState = 'running' | 'stopped' | 'missing' | 'unknown';
export interface Status {
  reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean;
  hostKeyChanged?: boolean;
  nextProbeAt?: number; sessions?: { name: string; windows: number; attached?: boolean; activity?: number; paneCmd?: string }[];
  metrics?: BoxMetrics; error?: string;
  proxmoxState?: ProxmoxBoxState; proxmoxNode?: string; proxmoxVmid?: number;
}
// One point of a box's rolling health series (a status poll projected server-side
// in healthHistory.js). A missing metric is omitted — the sparkline draws a gap.
// `stopped` marks a confirmed-by-Proxmox stopped box: `up` is true for it (see
// sampleOf), so this flag is how the sparkline/health UI tells "healthy stopped"
// apart from a genuinely reachable box.
export interface Sample {
  t: number; up: boolean; stopped?: boolean; tmux?: boolean; needsAuth?: boolean; keyChanged?: boolean;
  cpuPct?: number; memPct?: number; diskPct?: number;
  // Agent presence/idleness for the box's configured session (see healthHistory.js
  // sampleOf) and whether that session is attached. The pane header bar reads the
  // latest sample's `agent` for its working/waiting chip (paneHeader.ts).
  agent?: 'working' | 'waiting' | 'unknown'; agentAttached?: boolean;
}
export type ServiceCheckKind = 'http' | 'tcp' | 'none' | 'pihole' | 'truenas' | 'unifi' | 'immich';
export type ServiceSection = 'services' | 'infrastructure';
export type UnifiTlsMode = 'verify' | 'pin' | 'insecure';
export interface ServiceCheck {
  kind: ServiceCheckKind;
  target?: string;
  insecure?: boolean;
  // truenas only: the account the user-linked API key belongs to. Not a secret.
  username?: string;
  // unifi only: the site to read, plus the three-way TLS choice and its pin. A
  // controller is self-signed by default and its key can write, so this kind
  // gets pinning rather than the verified/insecure pair the others share.
  site?: string;
  tls?: UnifiTlsMode;
  fingerprint?: string;
}
export interface Service {
  // icon: a catalog slug, or 'none' to suppress. Absent means resolve
  // automatically from the check kind, the name, then the URL hostname.
  id: string; name: string; url: string; icon?: string; group?: string;
  // Absent on records written before sections existed — read as 'services'.
  section?: ServiceSection;
  check: ServiceCheck; createdAt: string;
  // Credentialed kinds only (pihole/truenas/unifi/immich). The secret itself
  // never reaches the browser; switching kinds clears it server-side.
  hasPassword?: boolean;
}
// icon/group/password accept null: the server's PATCH merge treats null as
// "clear", while an absent key means "leave it alone" — which is what an
// untouched password field must send.
export type ServiceSpec =
  Partial<Omit<Service, 'id' | 'createdAt' | 'icon' | 'group' | 'hasPassword'>>
  & { icon?: string | null; group?: string | null; password?: string | null };
export interface PiholeMetrics {
  blocking: 'enabled' | 'disabled';
  blockingTimer: number | null;
  queriesTotal: number | null;
  queriesBlocked: number | null;
  percentBlocked: number | null;
  clientsActive: number | null;
  clientsTotal: number | null;
  gravityDomains: number | null;
  versionCore: string | null;
  versionWeb: string | null;
  versionFtl: string | null;
  updateAvailable: boolean;
  uptimeSec: number | null;
}
export interface TruenasPool {
  name: string;
  size: number | null;
  allocated: number | null;
  free: number | null;
  usedPct: number | null;
  healthy: boolean;
  status: string;
  scanning: boolean;
}
export interface TruenasMetrics {
  pools: TruenasPool[];
  alerts: { critical: number; warning: number };
  version: string | null;
  hostname: string | null;
  uptimeSec: number | null;
}
export interface UnifiDeviceClass { online: number; total: number; cpuPct: number | null }
export interface UnifiMetrics {
  clientsTotal: number;
  clientsWired: number;
  clientsWireless: number;
  networks: number | null;
  wanState: 'up' | 'down' | 'unknown';
  wanTxBps: number | null;
  wanRxBps: number | null;
  gateway: { name: string; cpuPct: number | null; memPct: number | null; uptimeSec: number | null } | null;
  switches: UnifiDeviceClass;
  aps: UnifiDeviceClass & { clients: number };
  offline: { name: string; model: string }[];
}
export interface ImmichJobs { active: number; waiting: number; failed: number; paused: string[] }
export interface ImmichMetrics {
  version: string | null;
  releaseVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  photos: number | null;
  videos: number | null;
  libraryBytes: number | null;
  users: number | null;
  topUser: { name: string; bytes: number | null } | null;
  diskUsedBytes: number | null;
  diskSizeBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPct: number | null;
  // null means the key may not read the queues, which is a different statement
  // from a rollup of zeroes meaning the queues are idle.
  jobs: ImmichJobs | null;
  maintenanceMode: boolean;
  // Immich permissions the key lacks, e.g. 'server.statistics'.
  denied: string[];
}
// One field per integration rather than a single `metrics` union: each card
// model reads its own without narrowing, and the asymmetry a generically-named
// Pi-hole-shaped payload would create never appears.
export interface ServiceResult {
  state: 'up' | 'down' | 'auth';
  latencyMs?: number;
  error?: string;
  pihole?: PiholeMetrics;
  truenas?: TruenasMetrics;
  unifi?: UnifiMetrics;
  immich?: ImmichMetrics;
}
export interface ServiceStatusSnapshot { checkedAt: string | null; results: Record<string, ServiceResult> }
export type HealthEventKind = 'down' | 'up' | 'needs-auth' | 'key-changed' | 'threshold' | 'threshold-clear' | 'agent-input' | 'agent-done';
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
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth?: boolean; claudeStatusline?: boolean }
export interface SetupSummary {
  id: string; boxId: string; boxLabel: string; status: SetupStatus;
  phase: 'waiting-ssh' | 'running' | 'seeding' | 'statusline' | null; options: SetupOptions; error: string | null;
  // Present once a job that asked for seeding has attempted it. Absent (or
  // null) on jobs that predate server-side seeding, and on jobs that never
  // asked for it.
  seed?: SeedResult[] | null;
  // Present once a job that asked for the statusline push has attempted it.
  statusline?: SeedResult | null;
  // Which credential a `needs-interactive` job stalled on: 'sudo' (the script
  // reached sudo) or 'ssh' (ssh itself could not authenticate, so only the
  // non-BatchMode interactive finish can get in). Null in every other status,
  // and absent on jobs persisted before this field existed.
  needs?: 'sudo' | 'ssh' | null;
  createdAt: string; finishedAt: string | null;
}
export interface SetupJob extends SetupSummary { log: string; }
export interface SeedResult { target: 'claude' | 'codex' | 'all' | 'statusline'; ok: boolean; skipped?: string; error?: string }
export interface AiAuthCliStatus { ready: boolean; reason?: string }
export interface AiAuthStatus { claude: AiAuthCliStatus; codex: AiAuthCliStatus }

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
  async authInfo() {
    return j<{ mode: 'password' | 'google'; passkey?: { enrolled: number; rpId: string | null; only: boolean } }>(
      await fetch('/api/auth/info'));
  },
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
  async seedAiAuth(id: string) { return j<{ results: SeedResult[] }>(await fetch(`/api/boxes/${id}/seed-ai-auth`, { method: 'POST' })); },
  async aiAuthStatus() { return j<AiAuthStatus>(await fetch('/api/ai-auth/status')); },
  async probeSessions(spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string }) {
    return j<Status>(await fetch('/api/boxes/probe-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) }));
  },
  async importBoxes(payload: unknown) {
    return j<{ added: Box[]; skipped: number }>(await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
  },
  async services() { return j<Service[]>(await fetch('/api/services')); },
  async addService(spec: ServiceSpec) { return j<Service>(await fetch('/api/services', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) })); },
  async updateService(id: string, patch: ServiceSpec) {
    return j<Service>(await fetch(`/api/services/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
  },
  async removeService(id: string) { return j(await fetch(`/api/services/${id}`, { method: 'DELETE' })); },
  async icons() { return j<{ slugs: string[] }>(await fetch('/api/icons')); },
  async refreshServiceIcon(id: string) {
    return j<{ ok: boolean; reason?: string }>(await fetch(`/api/services/${id}/icon/refresh`, { method: 'POST' }));
  },
  async servicesStatus() { return j<ServiceStatusSnapshot>(await fetch(`/api/services/status?t=${Date.now()}`)); },
  async testPihole(body: { url: string; password?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; error?: string }>(
      await fetch('/api/services/pihole/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
  async testTruenas(body: { url: string; username: string; apiKey?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; hostname?: string | null; error?: string }>(
      await fetch('/api/services/truenas/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
  async testUnifi(body: { url: string; apiKey?: string; site?: string; tls?: string; fingerprint?: string; id?: string }) {
    return j<{ ok: boolean; error?: string; fingerprint256?: string | null; sites?: { id: string; name: string; reference: string }[] }>(
      await fetch('/api/services/unifi/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
  async testImmich(body: { url: string; apiKey?: string; insecure?: boolean; id?: string }) {
    return j<{ ok: boolean; version?: string | null; denied?: string[]; error?: string }>(
      await fetch('/api/services/immich/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
  },
  async status() { return j<Record<string, Status>>(await fetch(`/api/status?t=${Date.now()}`)); },
  async healthSeries() { return j<Record<string, Sample[]>>(await fetch(`/api/health/series?t=${Date.now()}`)); },
  async healthEvents() { return j<{ events: HealthEvent[]; latestSeq: number }>(await fetch(`/api/health/events?t=${Date.now()}`)); },
  async uiConfig() { return j<{ termFont: string | null; termFontSize: number; uploadMaxBytes: number; voice: boolean; voiceMaxSeconds: number }>(await fetch('/api/ui-config')); },
  async uploadFile(boxId: string, name: string, blob: Blob) {
    return j<{ path: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' }>(await fetch(`/api/upload?box=${encodeURIComponent(boxId)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
    }));
  },
  async postVoice(boxId: string, blob: Blob) {
    return j<{ text: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' | 'empty' }>(
      await fetch(`/api/voice?box=${encodeURIComponent(boxId)}`, {
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
