export interface NetboxSettings {
  url: string; tlsMode: 'ca' | 'pin' | 'insecure' | null;
  fingerprint256: string | null; dnsSuffix: string | null; hasToken: boolean; updatedAt: string;
}
export interface NetboxSettingsInput {
  url: string; token?: string; tlsMode?: 'ca' | 'pin' | 'insecure'; fingerprint256?: string | null; dnsSuffix?: string;
}
export type NetboxNextIp = { ok: true; address: string; prefix: string } | { ok: false; error: string };
export type NetboxTestResult =
  | { ok: true; version: string }
  | { ok: false; kind: 'unreachable' | 'tls' | 'auth' | 'unexpected'; error: string; fingerprint256?: string | null };
export interface NetboxPrefixSummary { prefix: string; used: number; total: number }
export type NetboxSummary =
  | { configured: false }
  | { configured: true; ok: boolean; error?: string; prefixes: NetboxPrefixSummary[] };

import { jsonFetch, jsonBody } from './http';

export const nbx = {
  get() { return jsonFetch<{ settings: NetboxSettings | null }>('/api/netbox/settings'); },
  save(spec: NetboxSettingsInput) { return jsonFetch<{ settings: NetboxSettings }>('/api/netbox/settings', jsonBody('PUT', spec)); },
  clear() { return jsonFetch<{ ok: boolean }>('/api/netbox/settings', { method: 'DELETE' }); },
  test(spec: Partial<NetboxSettingsInput>) { return jsonFetch<NetboxTestResult>('/api/netbox/test', jsonBody('POST', spec)); },
  nextIp(vlan: number) { return jsonFetch<NetboxNextIp>(`/api/netbox/next-ip?vlan=${vlan}`); },
  summary() { return jsonFetch<NetboxSummary>(`/api/netbox/summary?t=${Date.now()}`); },
};
