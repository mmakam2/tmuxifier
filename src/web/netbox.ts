export interface NetboxSettings {
  url: string; tlsMode: 'ca' | 'pin' | 'insecure' | null;
  fingerprint256: string | null; hasToken: boolean; updatedAt: string;
}
export interface NetboxSettingsInput {
  url: string; token?: string; tlsMode?: 'ca' | 'pin' | 'insecure'; fingerprint256?: string | null;
}
export type NetboxTestResult =
  | { ok: true; version: string }
  | { ok: false; kind: 'unreachable' | 'tls' | 'auth' | 'unexpected'; error: string; fingerprint256?: string | null };

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
};
