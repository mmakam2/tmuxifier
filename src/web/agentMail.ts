// Fetch layer for agent messaging (design 6.11/6.12), in the mold of
// fleetScripts.ts. Every call goes through http.ts so an expired session reaches
// the central 401 seam. The routes are browser-session only; the server answers
// 404 `agent messaging is off` when TMUXIFIER_AGENT_MAIL disables them.
//
// The types mirror what server.js returns (Task 10's "response shapes as built").
// Everything in a thread or a refusal is box output: render it as text only.
import { jsonFetch, jsonBody } from './http';

export interface MailPolicy {
  send: boolean;
  sendTo: string[];
  receive: boolean;
  receiveFrom: string[];
}

/** PUT body: the policy plus the ids whose counterpart entry the server also writes. */
/** Per list, the ids whose counterpart entry the save also writes on that box:
 *  `sendTo` ids gain this box in their receiveFrom, `receiveFrom` ids in their sendTo. */
export interface MailMirror { sendTo: string[]; receiveFrom: string[] }
export interface MailPolicyUpdate extends MailPolicy { mirror: MailMirror }

/** The four codes agentMailPolicy.mayStart returns. */
export type MailPairCode = 'send-off' | 'not-in-send-list' | 'receive-off' | 'not-in-receive-list';
export type MailPairResult = { ok: true } | { ok: false; code: MailPairCode };

/** One other box named in this box's lists: `send` is this box → it, `receive` is it → this box;
 *  null when that list does not name it. */
export interface MailPair {
  boxId: string;
  send: MailPairResult | null;
  receive: MailPairResult | null;
}

export type MailForwardState = 'off' | 'down' | 'error' | 'up';
/**
 * `shares a connection with <label>`: an earlier box in the list holds this box's ssh connection.
 * `connection not resolved`: this box's ssh connection could not be resolved, so it runs nothing.
 * `waiting for another box's connection to resolve`: no forward starts until every box resolves.
 */
export type MailForwardError = 'socket path too long' | 'bad home' | 'forward failed' | 'not verified' | 'listen failed'
  | 'connection not resolved' | "waiting for another box's connection to resolve"
  | `shares a connection with ${string}`;
export interface MailStatus {
  state: MailForwardState;
  /** null = not known yet. */
  installed: boolean | null;
  /** Agent sessions on the box with a waiter connected. */
  listening: number;
  /** Present only when state is 'error'. */
  error?: MailForwardError;
}

/** GET and PUT /api/boxes/:id/mail. */
export interface MailBoxView {
  policy: MailPolicy;
  pairs: MailPair[];
  status: MailStatus;
}

export interface MailParticipant { boxId: string; session: string }
export type MailCloseReason = 'operator' | 'permission withdrawn' | 'box removed';
export type MailThreadState = 'open' | 'closed';
export type MailMessageState = 'queued' | 'handed' | 'delivered' | 'dropped';

/** One row of GET /api/mail/threads. */
export interface MailThreadSummary {
  id: string;
  starter: MailParticipant;
  peer: MailParticipant;
  state: MailThreadState;
  /** null while open. */
  reason: MailCloseReason | null;
  createdAt: number;
  activeAt: number;
  /** Messages held. */
  count: number;
  /** Older messages trimmed from the thread. */
  dropped: number;
  /** A ready-made phrase from the server; shown as it is. */
  status: string;
}

export interface MailMessage {
  id: string;
  kind: 'task' | 'reply';
  from: 'starter' | 'peer';
  body: string;
  at: number;
  state: MailMessageState;
  handedAt?: number;
  handedPane?: string;
  deliveredAt?: number;
}

/** GET /api/mail/threads/:id: the stored copy as it is. */
export interface MailThread {
  v: number;
  id: string;
  starter: MailParticipant;
  peer: MailParticipant;
  state: MailThreadState;
  createdAt: number;
  activeAt: number;
  dropped: number;
  /** Present only once closed. */
  reason?: MailCloseReason;
  messages: MailMessage[];
}

/** One row of GET /api/mail/refusals (newest first). */
export interface MailRefusal {
  at: number;
  from: MailParticipant;
  /** What the sender typed, control-stripped and cut by the server. */
  target: string;
  /** A ready-made sentence from the server; shown as it is. */
  reason: string;
}

const boxPath = (boxId: string) => `/api/boxes/${encodeURIComponent(boxId)}/mail`;

export const mailApi = {
  async threads() { return (await jsonFetch<{ threads: MailThreadSummary[] }>('/api/mail/threads')).threads; },
  async thread(id: string) { return (await jsonFetch<{ thread: MailThread }>(`/api/mail/threads/${encodeURIComponent(id)}`)).thread; },
  close(id: string) { return jsonFetch<{ ok: true }>(`/api/mail/threads/${encodeURIComponent(id)}/close`, { method: 'POST' }); },
  async refusals() { return (await jsonFetch<{ refusals: MailRefusal[] }>('/api/mail/refusals')).refusals; },
  boxMail(boxId: string) { return jsonFetch<MailBoxView>(boxPath(boxId)); },
  saveBoxMail(boxId: string, body: MailPolicyUpdate) { return jsonFetch<MailBoxView>(boxPath(boxId), jsonBody('PUT', body)); },
};
