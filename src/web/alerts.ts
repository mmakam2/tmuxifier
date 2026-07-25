import type { Alert } from './alertFormat';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
const send = (url: string, method: string, body?: unknown) =>
  json<{ ok?: boolean }>(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export interface CheckSummary {
  id: string; label: string; type: string; target: Record<string, unknown>;
  intervalSec: number; timeoutMs: number; severity: string;
  failuresBeforeNotify: number; enabled: boolean; hasSecret: boolean;
  // Read back so an edit can carry it through: assertCheckInput resets `assert`
  // to {} for any spec that omits it, so a form that dropped it would silently
  // erase a stored assertion (a body marker, a status range, a JSON comparison)
  // and quietly weaken the check to a bare reachability probe.
  assert?: Record<string, unknown>;
}
export interface CheckRunState {
  lastRunAt: number | null; nextRunAt: number; ok: boolean | null;
  consecutiveOk: number; consecutiveFail: number; detail: string; latencyMs: number | null;
}

export const listAlerts = () => json<{ alerts: Alert[] }>('/api/alerts').then((r) => r.alerts);
export const ackAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/ack`, 'POST');
export const muteAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/mute`, 'POST');
export const unmuteAlert = (key: string) => send(`/api/alerts/${encodeURIComponent(key)}/mute`, 'DELETE');
export const listChecks = () =>
  json<{ checks: CheckSummary[]; state: Record<string, CheckRunState>; ingestPort: number | null }>('/api/checks');
export const createCheck = (spec: unknown) => send('/api/checks', 'POST', spec);
export const updateCheck = (id: string, spec: unknown) => send(`/api/checks/${encodeURIComponent(id)}`, 'PUT', spec);
export const deleteCheck = (id: string) => send(`/api/checks/${encodeURIComponent(id)}`, 'DELETE');
export const runCheck = (id: string) =>
  json<{ result: { ok: boolean; detail: string; latencyMs: number } }>(
    `/api/checks/${encodeURIComponent(id)}/run`, { method: 'POST' });
export const ingestStatus = () =>
  json<{ alive: boolean | null; lastSeenAt: number | null; staleFor: number | null }>('/api/alerts/ingest-status');
// since=0 asks the server for its default window rather than the epoch — see
// the feed route, which walks the day-partitioned log from `since` forward.
export const listFeed = (since = 0) =>
  json<{ events: Array<Record<string, unknown>> }>(`/api/alerts/feed?since=${since}`).then((r) => r.events);
export const listDecisions = (key: string) =>
  json<{ decisions: Array<Record<string, unknown>> }>(
    `/api/alerts/decisions?key=${encodeURIComponent(key)}`).then((r) => r.decisions);
