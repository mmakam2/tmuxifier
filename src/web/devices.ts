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
