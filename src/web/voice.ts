// Fetch layer for the Settings -> Voice tab, mirroring netbox.ts's shape.
export interface VoiceModel { id: string; file: string; bytes: number; installed: boolean }

export interface VoiceJob {
  id: string;
  model: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  phase: string | null;
  log: string;
  error: string | null;
}

export interface VoiceStatus {
  installed: boolean;
  enabled: boolean;
  model: string | null;
  // Which control (if any) is fixed by an .env override, so the UI can explain
  // an inert picker rather than appearing broken.
  pinned: { bin: 'env' | 'vendor' | null; model: 'env' | 'store' | null };
  engine: string;
  models: VoiceModel[];
  job: VoiceJob | null;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const voiceApi = {
  status: () => fetch('/api/voice/status').then((r) => j<VoiceStatus>(r)),
  install: (model: string) => fetch('/api/voice/install', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
  }).then((r) => j<VoiceJob>(r)),
  // Cache-busted: a poll that reads a stale job would freeze the log mid-build.
  job: (id: string) => fetch(`/api/voice/install/${encodeURIComponent(id)}?t=${Date.now()}`).then((r) => j<VoiceJob>(r)),
  saveSettings: (patch: { enabled?: boolean; model?: string }) => fetch('/api/voice/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  }).then((r) => j<{ enabled: boolean; model: string }>(r)),
};
