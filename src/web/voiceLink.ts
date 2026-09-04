//
// The browser end of a voice link (spec 2026-09-04): one WebSocket per linked
// pane carrying 640-byte 16 kHz S16 frames to /voice-link. Resolves once the
// server says `ready` (the box-side writer stayed alive), so the caller keeps
// buffering for dictation until then and loses nothing on a refusal. After
// ready, every close the caller did not ask for is reported once through
// onClose — the server's codes, the 30-minute cap, and a hidden tab.
// Sockets do not pass through http.ts's 401 seam, so an auth refusal (1008)
// is reported here as 'unauthorized' for the controller to surface.

export const LINK_MAX_MS = 30 * 60 * 1000;

export type LinkCloseWhy = 'closed' | 'superseded' | 'not-set-up' | 'writer-failed' | 'stalled' | 'cap' | 'hidden' | 'unauthorized' | 'setting-up';

export function closeReason(code: number, reason: string): LinkCloseWhy {
  if (code === 4001) return 'superseded';
  if (code === 4002) return 'not-set-up';
  if (code === 4003) return 'writer-failed';
  if (code === 4004) return 'stalled';
  if (code === 1008) return reason === 'setting up' ? 'setting-up' : 'unauthorized';
  return 'closed';
}

export function voiceLinkUrl(boxId: string, loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}/voice-link?box=${encodeURIComponent(boxId)}`;
}

export interface VoiceLink { send(frame: Uint8Array): void; close(): void }

export interface LinkSocket {
  readyState: number;
  send(d: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}

interface DocLike {
  visibilityState: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface VoiceLinkDeps {
  makeSocket?: (url: string) => LinkSocket;
  doc?: DocLike | null;
  maxMs?: number;
  loc?: { protocol: string; host: string };
}

export function openVoiceLink(boxId: string, onClose: (why: LinkCloseWhy) => void, deps: VoiceLinkDeps = {}): Promise<VoiceLink> {
  return new Promise<VoiceLink>((resolve, reject) => {
    const loc = deps.loc ?? (typeof location !== 'undefined' ? location : { protocol: 'http:', host: '' });
    const ws = (deps.makeSocket ?? ((u: string) => new WebSocket(u) as unknown as LinkSocket))(voiceLinkUrl(boxId, loc));
    const doc = deps.doc === undefined ? (typeof document !== 'undefined' ? (document as unknown as DocLike) : null) : deps.doc;
    let ready = false;
    let done = false;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const onVis = (): void => {
      if (doc?.visibilityState === 'hidden') { try { ws.close(1000, 'hidden'); } catch { /* closing */ } finish('hidden'); }
    };
    const teardown = (): void => {
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
      doc?.removeEventListener('visibilitychange', onVis);
    };
    const finish = (why: LinkCloseWhy): void => {
      if (done) return;
      done = true;
      teardown();
      if (ready) onClose(why);
      else reject(Object.assign(new Error(`voice link ${why}`), { why }));
    };
    const link: VoiceLink = {
      send(frame) { if (ready && !done && ws.readyState === 1) ws.send(frame); },
      close() {
        if (done) return;
        done = true;
        teardown();
        try { ws.close(1000, 'unlink'); } catch { /* already closed */ }
      },
    };
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (ready || done || ev.data !== 'ready') return;
      ready = true;
      capTimer = setTimeout(() => { try { ws.close(1000, 'cap'); } catch { /* closing */ } finish('cap'); }, deps.maxMs ?? LINK_MAX_MS);
      doc?.addEventListener('visibilitychange', onVis);
      resolve(link);
    });
    ws.addEventListener('close', (ev: { code: number; reason: string }) => finish(closeReason(ev.code, ev.reason)));
    ws.addEventListener('error', () => { /* a close event follows */ });
  });
}
