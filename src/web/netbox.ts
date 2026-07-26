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

async function jr<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
  return res.json() as Promise<T>;
}
const jsonBody = (method: string, v: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });

export const nbx = {
  get() { return jr<{ settings: NetboxSettings | null }>(fetch('/api/netbox/settings')); },
  save(spec: NetboxSettingsInput) { return jr<{ settings: NetboxSettings }>(fetch('/api/netbox/settings', jsonBody('PUT', spec))); },
  clear() { return jr<{ ok: boolean }>(fetch('/api/netbox/settings', { method: 'DELETE' })); },
  test(spec: Partial<NetboxSettingsInput>) { return jr<NetboxTestResult>(fetch('/api/netbox/test', jsonBody('POST', spec))); },
  nextIp(vlan: number) { return jr<NetboxNextIp>(fetch(`/api/netbox/next-ip?vlan=${vlan}`)); },
  summary() { return jr<NetboxSummary>(fetch(`/api/netbox/summary?t=${Date.now()}`)); },
};
