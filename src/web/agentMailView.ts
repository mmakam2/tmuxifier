// Pure view model for agent messaging: every word the Edit Box section and the
// Messages drawer show the operator. No DOM here (vitest has none), so the
// wording is unit-tested in test/agentMailView.test.js and the DOM halves only
// place these strings with textContent.
//
// Box ids from the server are looked up, never trusted to be current: a box
// removed since reads "removed box". Server phrases (a thread's status, a
// refusal's reason) are already worded for people and pass through unchanged,
// except that a status says `waiting` where agents read `queued` (operatorStatus).
import type {
  MailMessage, MailPair, MailPairResult, MailParticipant, MailPolicy, MailRefusal, MailStatus,
  MailMirror, MailThread, MailThreadSummary,
} from './agentMail';

export interface MailBoxRef { id: string; label: string }

export function nameOf(boxId: string, boxes: readonly MailBoxRef[]): string {
  return boxes.find((b) => b.id === boxId)?.label ?? 'removed box';
}

export function participant(p: MailParticipant, boxes: readonly MailBoxRef[]): string {
  return `${nameOf(p.boxId, boxes)}/${p.session}`;
}

// Why a pair is not complete, naming the box whose setting is missing.
// sender/receiver are labels: for a `send` half the sender is this box, for a
// `receive` half the other box.
function missing(code: string, sender: string, receiver: string): string | null {
  switch (code) {
    case 'send-off': return `${sender}'s send switch is off`;
    case 'not-in-send-list': return `${sender}'s send list does not include ${receiver}`;
    case 'receive-off': return `${receiver}'s receive switch is off`;
    case 'not-in-receive-list': return `${receiver}'s receive list does not include ${sender}`;
    default: return null; // a code this bundle does not know (a newer server)
  }
}

function half(word: 'send' | 'receive', r: MailPairResult, sender: string, receiver: string): string {
  if (r.ok) return `${word} ✓`;
  const why = missing(r.code, sender, receiver);
  return why ? `${word}: waiting, ${why}` : `${word}: waiting`;
}

/** `billing   send ✓   receive ✓`, `search   send: waiting, search's receive switch is off`. */
export function pairLine(pair: MailPair, boxes: readonly MailBoxRef[], selfLabel: string): string {
  const other = nameOf(pair.boxId, boxes);
  const parts = [other];
  if (pair.send) parts.push(half('send', pair.send, selfLabel, other));
  if (pair.receive) parts.push(half('receive', pair.receive, other, selfLabel));
  return parts.join('   ');
}

const sessions = (n: number) => (n === 0 ? 'no sessions' : n === 1 ? '1 session' : `${n} sessions`);

/** The box's messaging status as one line. */
export function statusLine(status: MailStatus): string {
  switch (status.state) {
    case 'off': return 'Messaging is off';
    case 'down': return 'Socket not connected: box unreachable';
    case 'error': return status.error ? `Socket not connected: ${status.error}` : 'Socket not connected';
    case 'up': {
      if (status.installed === false) return 'Tools not installed: run setup on this box';
      const listening = `${sessions(Number(status.listening) || 0)} listening`;
      return status.installed === true
        ? `Tools installed · socket connected · ${listening}`
        : `Socket connected · ${listening}`;
    }
    default: return 'Messaging status unknown';
  }
}

/** Coarse age of a millisecond timestamp: `just now`, `2 min ago`, `1 h ago`, `3 d ago`. */
export function relAge(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const CLOSED: Record<string, string> = {
  'operator': 'closed by you', 'permission withdrawn': 'closed: permission withdrawn', 'box removed': 'closed: box removed',
  'storage limit': 'closed: storage limit',
};

function threadState(state: string, reason: string | null | undefined): string {
  if (state === 'open') return 'open';
  return reason && Object.hasOwn(CLOSED, reason) ? CLOSED[reason] : 'closed';
}

/** A server status phrase as the operator reads it. The phrases are written for
 *  agents (`queued: billing/main is working`, agentMailText.js); the drawer says
 *  `waiting` where they say `queued`, as the per-message states do. Only that
 *  leading word changes; test/agentMailView.test.js builds every server phrase. */
export function operatorStatus(phrase: string): string {
  return /^queued(?=$|:)/.test(phrase) ? `waiting${phrase.slice('queued'.length)}` : phrase;
}

export interface MailThreadRow { title: string; meta: string; state: string; status: string }

export function threadRow(t: MailThreadSummary, boxes: readonly MailBoxRef[], now: number): MailThreadRow {
  const count = `${t.count} ${t.count === 1 ? 'message' : 'messages'}`;
  const older = t.dropped > 0 ? `, ${t.dropped} older dropped` : '';
  return {
    title: `${participant(t.starter, boxes)} → ${participant(t.peer, boxes)}`,
    meta: `${count}${older} · ${relAge(t.activeAt, now)}`,
    state: threadState(t.state, t.reason),
    status: operatorStatus(t.status),
  };
}

export interface MailThreadHead { title: string; state: string; dropped: string | null }

/** The thread view's head: who talks to whom, the thread's state as in the list,
 *  and how many older messages the store trimmed (null when none). */
export function threadHead(t: Pick<MailThread, 'starter' | 'peer' | 'state' | 'reason' | 'dropped'>, boxes: readonly MailBoxRef[]): MailThreadHead {
  const n = Number(t.dropped) || 0;
  return {
    title: `${participant(t.starter, boxes)} → ${participant(t.peer, boxes)}`,
    state: threadState(t.state, t.reason),
    dropped: n > 0 ? `${n} older ${n === 1 ? 'message is' : 'messages are'} no longer kept` : null,
  };
}

// The Messages drawer's empty states and its one-line failures.
export const MAIL_NO_THREADS = 'No messages yet.';
export const MAIL_NO_REFUSALS = 'Nothing refused.';
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export function messagesLoadError(message: string): string { return `Messages could not be loaded: ${oneLine(message)}`; }
export function stopFailedLine(message: string): string { return `Could not stop this thread: ${oneLine(message)}`; }

const MESSAGE_STATE: Record<string, string> = { queued: 'waiting', handed: 'handed over', delivered: 'delivered', dropped: 'dropped' };

const pad = (n: number) => String(n).padStart(2, '0');
/** Local `YYYY-MM-DD HH:MM`. */
function clock(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface MailMessageRow { who: string; when: string; state: string; body: string }

export function messageRow(m: MailMessage, thread: Pick<MailThread, 'starter' | 'peer'>, boxes: readonly MailBoxRef[]): MailMessageRow {
  const side = m.from === 'peer' ? thread.peer : thread.starter;
  return {
    who: participant(side, boxes),
    when: clock(m.at),
    state: Object.hasOwn(MESSAGE_STATE, m.state) ? MESSAGE_STATE[m.state] : String(m.state),
    body: m.body,
  };
}

export interface MailRefusalRow { when: string; who: string; target: string; reason: string }

export function refusalRow(r: MailRefusal, boxes: readonly MailBoxRef[], now: number): MailRefusalRow {
  return { when: relAge(r.at, now), who: participant(r.from, boxes), target: r.target, reason: r.reason };
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** Whether saving `b` would change `a`. List order does not count. */
export function policyChanged(a: MailPolicy, b: MailPolicy): boolean {
  return a.send !== b.send || a.receive !== b.receive
    || !sameSet(a.sendTo, b.sendTo) || !sameSet(a.receiveFrom, b.receiveFrom);
}

// The "also write the matching entry" choice, kept per list entry: it follows
// the tick at the moment the box is added to that list, and leaves with the box
// when it is removed. A single set of ids used to outlive a removal, so a box
// added back with the tick off still had its counterpart written.
export type MailListKey = 'sendTo' | 'receiveFrom';
export type MailMirrorMarks = Readonly<Record<MailListKey, readonly string[]>>;
export const NO_MIRROR: MailMirrorMarks = { sendTo: [], receiveFrom: [] };

/** `listed` is that list as the modal opened it: a box already there has no new entry to mirror. */
export function mirrorOnAdd(marks: MailMirrorMarks, list: MailListKey, id: string, at: { tick: boolean; listed: readonly string[] }): MailMirrorMarks {
  const rest = marks[list].filter((x) => x !== id);
  return { ...marks, [list]: at.tick && !at.listed.includes(id) ? [...rest, id] : rest };
}

export function mirrorOnRemove(marks: MailMirrorMarks, list: MailListKey, id: string): MailMirrorMarks {
  return { ...marks, [list]: marks[list].filter((x) => x !== id) };
}

/** The PUT's `mirror`: per list, the ids marked there and still in that list. The
 *  server mirrors each list only from its own key, so an entry added with the tick
 *  off (or already listed when the modal opened) is never mirrored. */
export function mirrorToSend(marks: MailMirrorMarks, draft: Pick<MailPolicy, MailListKey>): MailMirror {
  return {
    sendTo: marks.sendTo.filter((id) => draft.sendTo.includes(id)),
    receiveFrom: marks.receiveFrom.filter((id) => draft.receiveFrom.includes(id)),
  };
}

/** Whether GET /api/ui-config says the server runs agent messaging. Only an
 *  explicit `true` counts: an older server, a malformed value or a failed read is off. */
export function mailEnabledFrom(cfg: unknown): boolean {
  return !!cfg && typeof cfg === 'object' && (cfg as { agentMail?: unknown }).agentMail === true;
}
