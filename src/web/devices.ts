// Fetch layer for enrolled Android devices (Settings → Devices).
import { jsonFetch } from './http';

export type DeviceInfo = {
  id: string;
  name: string;
  created: number | null;
  lastSeen: number | null;
  hasFcmToken: boolean;
  notify: Record<string, boolean>;
};

export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await jsonFetch<{ devices: DeviceInfo[] }>('/api/devices');
  return res.devices;
}

export function revokeDevice(id: string): Promise<{ removed: boolean }> {
  return jsonFetch<{ removed: boolean }>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type PairingCode = { code: string; expiresAt: number };

/** Mint a single-use pairing code for enrolling the Android app (2min TTL). */
export function mintPairingCode(): Promise<PairingCode> {
  return jsonFetch<PairingCode>('/api/devices/pair', { method: 'POST' });
}

export type ApkInfo = { available: boolean; size?: number; mtime?: number };

/** Whether a signed APK is published on the server (data/app) for download. */
export function apkInfo(): Promise<ApkInfo> {
  return jsonFetch<ApkInfo>('/api/devices/apk/info');
}
