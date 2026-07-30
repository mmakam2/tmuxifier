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
export interface PveClusterNode {
  hostId: string; hostName: string | null; node: string | null;
  status: 'online' | 'offline' | 'unknown' | 'error';
  cpuPct: number | null; memPct: number | null; diskPct: number | null;
  uptimeSec: number | null; error: string | null;
}
export interface LifecycleJobSummary { id: string; action: LifecycleAction; boxId: string; boxLabel: string; hostId: string; hostName: string; node: string; vmid: number; status: LifecycleStatus; phase: string; error: string | null; createdAt: string; finishedAt: string | null; }
export interface LifecycleJob extends LifecycleJobSummary { log: string; }

import { jsonFetch as jr, jsonBody as json } from './http';

const post = (value: unknown) => json('POST', value);

export const pve = {
  hosts() { return jr<PveHost[]>('/api/proxmox/hosts'); },
  inspect(endpoint: string) { return jr<InspectResult>('/api/proxmox/inspect', post({ endpoint })); },
  addHost(spec: Partial<PveHost> & { tokenSecret: string }) { return jr<PveHost>('/api/proxmox/hosts', post(spec)); },
  removeHost(id: string) { return jr(`/api/proxmox/hosts/${id}`, { method: 'DELETE' }); },
  testHost(id: string) { return jr<{ ok: boolean; version?: unknown }>(`/api/proxmox/hosts/${id}/test`, { method: 'POST' }); },
  nodes(id: string) { return jr<{ node: string }[]>(`/api/proxmox/hosts/${id}/nodes`); },
  storage(id: string, node: string) { return jr<StorageGroups>(`/api/proxmox/hosts/${id}/nodes/${node}/storage`); },
  templates(id: string, node: string, storage: string) { return jr<{ volid: string }[]>(`/api/proxmox/hosts/${id}/nodes/${node}/templates?storage=${encodeURIComponent(storage)}`); },
  bridges(id: string, node: string) { return jr<{ iface: string }[]>(`/api/proxmox/hosts/${id}/nodes/${node}/bridges`); },
  keys() { return jr<PveKey[]>('/api/proxmox/keys'); },
  addKey(spec: { name: string; publicKey: string }) { return jr<PveKey>('/api/proxmox/keys', post(spec)); },
  removeKey(id: string) { return jr(`/api/proxmox/keys/${id}`, { method: 'DELETE' }); },
  defaultKey() { return jr<{ publicKey: string | null }>('/api/proxmox/default-key'); },
  rootPasswordStatus() { return jr<{ set: boolean }>('/api/proxmox/root-password'); },
  setRootPassword(password: string) { return jr<{ set: boolean }>('/api/proxmox/root-password', json('PUT', { password })); },
  clearRootPassword() { return jr<{ set: boolean }>('/api/proxmox/root-password', { method: 'DELETE' }); },
  presets() { return jr<PvePreset[]>('/api/proxmox/presets'); },
  addPreset(spec: unknown) { return jr<PvePreset>('/api/proxmox/presets', post(spec)); },
  updatePreset(id: string, spec: unknown) { return jr<PvePreset>(`/api/proxmox/presets/${id}`, json('PUT', spec)); },
  removePreset(id: string) { return jr(`/api/proxmox/presets/${id}`, { method: 'DELETE' }); },
  createProvision(spec: { presetId: string; hostname: string; vmid?: number; ip?: string; tags?: string[]; setupOptions?: SetupOptions }) { return jr<ProvisionSummary>('/api/proxmox/provisions', post(spec)); },
  provisions() { return jr<ProvisionSummary[]>('/api/proxmox/provisions'); },
  provision(id: string) { return jr<ProvisionJob>(`/api/proxmox/provisions/${id}?t=${Date.now()}`); },
  linkedContainers() { return jr<PveLinkedContainer[]>('/api/proxmox/containers'); },
  clusterNodes() { return jr<PveClusterNode[]>('/api/proxmox/nodes'); },
  nodeContainers(hostId: string, node: string) { return jr<PveNodeContainer[]>(`/api/proxmox/hosts/${hostId}/nodes/${encodeURIComponent(node)}/containers`); },
  createLifecycleJob(spec: { boxId: string; action: LifecycleAction; confirmName?: string }) { return jr<LifecycleJobSummary>('/api/proxmox/lifecycle-jobs', post(spec)); },
  lifecycleJobs() { return jr<LifecycleJobSummary[]>('/api/proxmox/lifecycle-jobs'); },
  lifecycleJob(id: string) { return jr<LifecycleJob>(`/api/proxmox/lifecycle-jobs/${id}?t=${Date.now()}`); },
};
