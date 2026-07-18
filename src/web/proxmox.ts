import type { SetupOptions } from './api';

export interface PveHost {
  id: string; name: string; endpoint: string; tokenId: string; hasToken: boolean;
  verifyMode: 'pin' | 'ca' | 'insecure'; fingerprint256: string | null; defaultNode: string | null; createdAt: string;
}
export interface PveKey { id: string; name: string; hasKey: boolean; createdAt: string; }
export interface PvePresetNet { bridge: string; vlan: number | null; ipMode: 'dhcp' | 'static' | 'auto-static'; cidr: string | null; gateway: string | null; }
export interface PveMount { id: string; storage: string; sizeGiB: number; path: string; backup: boolean; }
export interface PvePreset {
  id: string; name: string; hostId: string; node: string | null; template: string; storage: string;
  diskGiB: number; cores: number; memoryMiB: number; swapMiB: number; unprivileged: boolean;
  features: Record<string, boolean>; net: PvePresetNet; dns: { nameserver: string | null; searchdomain: string | null };
  mounts: PveMount[]; onboot: boolean; startAfterCreate: boolean;
  boxDefaults: { user: string; sessionName: string; tags: string[] }; createdAt: string;
}
export interface InspectResult { reachable: boolean; fingerprint256: string | null; subject: string; issuer: string; validTo: string | null; caValid: boolean; error?: string; }
export type ProvisionStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type ProvisionPhase = 'allocate' | 'allocate-ip' | 'create' | 'start' | 'discover' | 'link' | 'done';
export interface ProvisionSummary { id: string; presetName: string; hostname: string; vmid: number | null; status: ProvisionStatus; phase: ProvisionPhase; createdAt: string; finishedAt: string | null; boxId: string | null; needsHost: boolean; }
export interface ProvisionJob extends ProvisionSummary { log: string; error: string | null; }
export interface StorageGroups { rootdir: { storage: string }[]; vztmpl: { storage: string }[]; }

export type PveContainerState = 'running' | 'stopped' | 'missing' | 'unknown';
export type LifecycleAction = 'start' | 'shutdown' | 'stop' | 'reboot' | 'deprovision';
export type LifecycleStatus = 'running' | 'done' | 'error' | 'interrupted';
export interface PveLinkedContainer { boxId: string; boxLabel: string; hostId: string; hostName: string | null; node: string; vmid: number; containerName: string | null; state: PveContainerState; fetchedAt: number; error: string | null; activeJob: LifecycleJobSummary | null; }
export interface PveNodeContainer { hostId: string; node: string; vmid: number; name: string; state: PveContainerState; linkedBoxId: string | null; }
export interface LifecycleJobSummary { id: string; action: LifecycleAction; boxId: string; boxLabel: string; hostId: string; hostName: string; node: string; vmid: number; status: LifecycleStatus; phase: string; error: string | null; createdAt: string; finishedAt: string | null; }
export interface LifecycleJob extends LifecycleJobSummary { log: string; }

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const json = (method: 'POST' | 'PUT', value: unknown) => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
const post = (value: unknown) => json('POST', value);

export const pve = {
  hosts() { return jr<PveHost[]>(fetch('/api/proxmox/hosts')); },
  inspect(endpoint: string) { return jr<InspectResult>(fetch('/api/proxmox/inspect', post({ endpoint }))); },
  addHost(spec: Partial<PveHost> & { tokenSecret: string }) { return jr<PveHost>(fetch('/api/proxmox/hosts', post(spec))); },
  removeHost(id: string) { return jr(fetch(`/api/proxmox/hosts/${id}`, { method: 'DELETE' })); },
  testHost(id: string) { return jr<{ ok: boolean; version?: unknown }>(fetch(`/api/proxmox/hosts/${id}/test`, { method: 'POST' })); },
  nodes(id: string) { return jr<{ node: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes`)); },
  storage(id: string, node: string) { return jr<StorageGroups>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/storage`)); },
  templates(id: string, node: string, storage: string) { return jr<{ volid: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/templates?storage=${encodeURIComponent(storage)}`)); },
  bridges(id: string, node: string) { return jr<{ iface: string }[]>(fetch(`/api/proxmox/hosts/${id}/nodes/${node}/bridges`)); },
  keys() { return jr<PveKey[]>(fetch('/api/proxmox/keys')); },
  addKey(spec: { name: string; publicKey: string }) { return jr<PveKey>(fetch('/api/proxmox/keys', post(spec))); },
  removeKey(id: string) { return jr(fetch(`/api/proxmox/keys/${id}`, { method: 'DELETE' })); },
  defaultKey() { return jr<{ publicKey: string | null }>(fetch('/api/proxmox/default-key')); },
  rootPasswordStatus() { return jr<{ set: boolean }>(fetch('/api/proxmox/root-password')); },
  setRootPassword(password: string) { return jr<{ set: boolean }>(fetch('/api/proxmox/root-password', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })); },
  clearRootPassword() { return jr<{ set: boolean }>(fetch('/api/proxmox/root-password', { method: 'DELETE' })); },
  presets() { return jr<PvePreset[]>(fetch('/api/proxmox/presets')); },
  addPreset(spec: unknown) { return jr<PvePreset>(fetch('/api/proxmox/presets', post(spec))); },
  updatePreset(id: string, spec: unknown) { return jr<PvePreset>(fetch(`/api/proxmox/presets/${id}`, json('PUT', spec))); },
  removePreset(id: string) { return jr(fetch(`/api/proxmox/presets/${id}`, { method: 'DELETE' })); },
  createProvision(spec: { presetId: string; hostname: string; vmid?: number; ip?: string; tags?: string[]; setupOptions?: SetupOptions }) { return jr<ProvisionSummary>(fetch('/api/proxmox/provisions', post(spec))); },
  provisions() { return jr<ProvisionSummary[]>(fetch('/api/proxmox/provisions')); },
  provision(id: string) { return jr<ProvisionJob>(fetch(`/api/proxmox/provisions/${id}?t=${Date.now()}`)); },
  linkedContainers() { return jr<PveLinkedContainer[]>(fetch('/api/proxmox/containers')); },
  nodeContainers(hostId: string, node: string) { return jr<PveNodeContainer[]>(fetch(`/api/proxmox/hosts/${hostId}/nodes/${encodeURIComponent(node)}/containers`)); },
  createLifecycleJob(spec: { boxId: string; action: LifecycleAction; confirmName?: string }) { return jr<LifecycleJobSummary>(fetch('/api/proxmox/lifecycle-jobs', post(spec))); },
  lifecycleJobs() { return jr<LifecycleJobSummary[]>(fetch('/api/proxmox/lifecycle-jobs')); },
  lifecycleJob(id: string) { return jr<LifecycleJob>(fetch(`/api/proxmox/lifecycle-jobs/${id}?t=${Date.now()}`)); },
};
