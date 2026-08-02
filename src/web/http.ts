// The one HTTP helper every fetch layer routes through, and with it the central
// 401 seam.
//
// When the session cookie expires (or the server restarts with a new secret)
// every poller and action starts failing with 401s; without one place to notice,
// the dashboard silently freezes at its last-painted state. main.ts registers a
// handler that tears the workspace down and routes back to the login screen.
//
// This lived in api.ts, which meant the four other fetch layers (proxmox,
// netbox, passkeys, voice) each hand-rolled the same throw-on-not-ok pair and
// none of them reached the seam — an expired session hit them and the app went
// on believing it was signed in (C2 in the 2026-07-29 review; the root cause
// behind B6's voice poller 401ing every 2s forever after logout, and B28). It
// lives here instead so a new fetch layer inherits the behaviour rather than
// having to remember it.
//
// The handler must tolerate firing for a login endpoint's own wrong-credential
// 401 — both /api/login and the passkey login finish return one. main.ts no-ops
// when the login screen is already up.

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null) { unauthorizedHandler = fn; }

/** An Error that remembers the HTTP status that produced it. */
export interface HttpError extends Error { status: number }

/** Notify the seam and build the error for a non-ok response. */
export async function httpError(res: Response): Promise<HttpError> {
  if (res.status === 401) unauthorizedHandler?.();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  // statusText is '' over HTTP/2, which carries no reason phrase — so the bare
  // status is the last resort rather than an empty message.
  const err = new Error(body.error || res.statusText || `HTTP ${res.status}`) as HttpError;
  // Carried so a caller can tell "this is gone" from "this failed once". Set
  // here rather than at each call site: a poller that cannot distinguish a 404
  // from a transient failure retries forever (E4).
  err.status = res.status;
  return err;
}

/** The status of a thrown http error, or 0 for anything else (network, abort). */
export function statusOf(err: unknown): number {
  return typeof (err as HttpError)?.status === 'number' ? (err as HttpError).status : 0;
}

/** Parse an already-awaited Response, routing 401 through the seam. */
export async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await httpError(res);
  return res.json() as Promise<T>;
}

/** fetch + parse in one call. */
export async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  return jsonOf<T>(await fetch(input, init));
}

/** fetch raw text, routing 401 through the seam. For a caller that needs the
 *  response's literal bytes (the Boxes tab's export preview reports its true
 *  size) rather than a parsed object. */
export async function textFetch(input: string, init?: RequestInit): Promise<string> {
  const res = await fetch(input, init);
  if (!res.ok) throw await httpError(res);
  return res.text();
}

/** The JSON request init these layers all repeat. */
export const jsonBody = (method: string, value: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
