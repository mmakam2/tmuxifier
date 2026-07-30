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

// The install poller runs for the length of a whisper.cpp build. Before this
// went through the shared seam (C2) a logout mid-install left it 401ing every
// 2s forever, because nothing here could tell the app the session was gone.
import { jsonFetch, jsonBody } from './http';

export const voiceApi = {
  status: () => jsonFetch<VoiceStatus>('/api/voice/status'),
  install: (model: string) => jsonFetch<VoiceJob>('/api/voice/install', jsonBody('POST', { model })),
  // Cache-busted: a poll that reads a stale job would freeze the log mid-build.
  job: (id: string) => jsonFetch<VoiceJob>(`/api/voice/install/${encodeURIComponent(id)}?t=${Date.now()}`),
  saveSettings: (patch: { enabled?: boolean; model?: string }) =>
    jsonFetch<{ enabled: boolean; model: string }>('/api/voice/settings', jsonBody('PATCH', patch)),
};
