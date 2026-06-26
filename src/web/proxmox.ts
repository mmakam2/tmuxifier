export interface PveHost {
  id: string; name: string; endpoint: string; tokenId: string; hasToken: boolean;
  verifyMode: 'pin' | 'ca' | 'insecure'; fingerprint256: string | null; defaultNode: string | null; createdAt: string;
}
export interface PveKey { id: string; name: string; publicKey: string; createdAt: string; }
export interface PvePresetNet { bridge: string; vlan: number | null; ipMode: 'dhcp' | 'static'; cidr: string | null; gateway: string | null; }
export interface PvePreset {
  id: string; name: string; hostId: string; node: string | null; template: string; storage: string;
  diskGiB: number; cores: number; memoryMiB: number; swapMiB: number; unprivileged: boolean;
  features: Record<string, boolean>; net: PvePresetNet; dns: { nameserver: string | null; searchdomain: string | null };
  keyIds: string[]; onboot: boolean; startAfterCreate: boolean;
  boxDefaults: { user: string; sessionName: string; tags: string[] }; createdAt: string;
}
export interface InspectResult { reachable: boolean; fingerprint256: string | null; subject: string; issuer: string; validTo: string | null; caValid: boolean; error?: string; }
export type ProvisionStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type ProvisionPhase = 'allocate' | 'create' | 'start' | 'discover' | 'link' | 'done';
export interface ProvisionSummary { id: string; presetName: string; hostname: string; vmid: number | null; status: ProvisionStatus; phase: ProvisionPhase; createdAt: string; finishedAt: string | null; boxId: string | null; needsHost: boolean; }
export interface ProvisionJob extends ProvisionSummary { log: string; error: string | null; }
export interface StorageGroups { rootdir: { storage: string }[]; vztmpl: { storage: string }[]; }

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const post = (v: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
const patch = (v: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

export const pve = {
  hosts() { return jr<PveHost[]>(fetch('/api/proxmox/hosts')); },
  inspect(endpoint: string) { return jr<InspectResult>(fetch('/api/proxmox/inspect', post({ endpoint }))); },
  addHost(spec: Partial<PveHost> & { tokenSecret: string }) { return jr<PveHost>(fetch('/api/proxmox/hosts', post(spec))); },
  updateHost(id: string, p: Partial<PveHost> & { tokenSecret?: string }) { return jr<PveHost>(fetch(`/api/proxmox/hosts/${id}`, patch(p))); },
  removeHost(id: string) { return jr(fetch(`/api/proxmox/hosts/${id}`, { method: 'DELETE' })); },
  testHost(id: string) { return jr<{ ok: boolean; version?: unknown }>(fetch(`/api/proxmox/hosts/${id}/test`, { method: 'POST' })); },
  nodes(id: string) { return jr<{ node: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes`)); },
  storage(id: string, node: string) { return jr<StorageGroups>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/storage`)); },
  templates(id: string, node: string, storage: string) { return jr<{ volid: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/templates?storage=${encodeURIComponent(storage)}`)); },
  bridges(id: string, node: string) { return jr<{ iface: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/bridges`)); },
  nextId(id: string) { return jr<{ vmid: string }>(fetch(`/api/proxmox/hosts/${id}/nextid`)); },
  keys() { return jr<PveKey[]>(fetch('/api/proxmox/keys')); },
  addKey(spec: { name: string; publicKey: string }) { return jr<PveKey>(fetch('/api/proxmox/keys', post(spec))); },
  removeKey(id: string) { return jr(fetch(`/api/proxmox/keys/${id}`, { method: 'DELETE' })); },
  presets() { return jr<PvePreset[]>(fetch('/api/proxmox/presets')); },
  addPreset(spec: unknown) { return jr<PvePreset>(fetch('/api/proxmox/presets', post(spec))); },
  updatePreset(id: string, spec: unknown) { return jr<PvePreset>(fetch(`/api/proxmox/presets/${id}`, patch(spec))); },
  removePreset(id: string) { return jr(fetch(`/api/proxmox/presets/${id}`, { method: 'DELETE' })); },
  createProvision(spec: { presetId: string; hostname: string; vmid?: number; ip?: string }) { return jr<ProvisionSummary>(fetch('/api/proxmox/provisions', post(spec))); },
  provisions() { return jr<ProvisionSummary[]>(fetch('/api/proxmox/provisions')); },
  provision(id: string) { return jr<ProvisionJob>(fetch(`/api/proxmox/provisions/${id}?t=${Date.now()}`)); },
  cancelProvision(id: string) { return jr<ProvisionSummary>(fetch(`/api/proxmox/provisions/${id}/cancel`, { method: 'POST' })); },
};
