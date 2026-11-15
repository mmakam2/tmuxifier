import { SESSION_NAME_RE } from './sshCommand.js';
import { mayStart } from './agentMailPolicy.js';
import {
  cleanBody, bodyProblem, statusPhrase, refusalText, renderThread, renderWho, renderInbox,
} from './agentMailText.js';

// The agent-mail hub: what a coding agent on a box can ask of the backend (design 6.5). The
// per-box listener (agentMailListener.js) and the browser routes call exactly these names; the
// box a request comes from is the listener's identity, so `caller.boxId` is trusted and
// `caller.session` is a claim checked against the backend's own agent markers.
//
//   caller everywhere is { boxId, session }
//   who(caller)                    sessions this one may start a thread with
//   send(caller, target, body)     policy check, new thread, first message queued
//   reply(caller, threadId, body)  a post by a participant
//   read(caller, threadId)         the whole thread; the caller's messages become delivered
//   inbox(caller)                  undelivered messages for the caller; they become delivered
//
// "Running an agent" means `Object.hasOwn(marksOf(boxId), session)`: a live marker, not the
// dashboard's `present` flag (design 6.5). `marksOf` returning null means the box is
// unreachable. who/send/reply need a running agent; read/inbox need only a valid name, so an
// agent that has just exited can still collect what was sent to it.
//
// Everything a request carries is box output. Session names are validated, never rewritten;
// the typed target is control-stripped and cut to 200 characters before it reaches any text
// or the refusal log, and is matched as typed. Every word an agent reads comes from
// agentMailText.js. A refusal from a caller that fails validation is answered but not logged:
// the log records a sender, and an invalid claim is not one.
//
// Delivery is not here. `pump(recipient)` is the single seam a delivery engine fills; it is
// called after every queued message. `waitersOf` is the matching seam for "listening".

const TARGET_MAX = 200;
// C0, DEL, C1 and the bidi controls (as status.js cleanWindowName strips).
// eslint-disable-next-line no-control-regex
const TARGET_CONTROL_RE = /[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g;

// marker state -> the word `who` shows (the dashboard's words for a session with no new turn)
const STATE_WORD = Object.assign(Object.create(null), { ready: 'idle', working: 'working', blocked: 'blocked' });
const CLOSED_KIND = Object.assign(Object.create(null), {
  operator: 'closed-operator',
  'permission withdrawn': 'closed-withdrawn',
  'box removed': 'closed-box-removed',
});
const UNDELIVERED = ['queued', 'handed'];

// The target as it may appear in text and in the refusal log.
export function cleanTarget(raw) {
  const s = typeof raw === 'string' ? raw.replace(TARGET_CONTROL_RE, '') : '';
  if (s.length <= TARGET_MAX) return s;
  return Array.from(s).slice(0, TARGET_MAX).join('');
}

const canon = (s) => s.trim().toLowerCase(); // as store.js compares labels

// Target grammar (design 6.5): `.` / `./<session>` is the caller's own box; otherwise the whole
// string is a label (case-insensitive), else it splits at the LAST `/` into label and session.
// A bare label means the box's configured session. No match, or more than one, is null.
export function resolveTarget(target, boxes, callerBoxId) {
  if (typeof target !== 'string' || !Array.isArray(boxes)) return null;
  const t = target.trim();
  if (t === '') return null;
  const at = (box, session) => (typeof session === 'string' && SESSION_NAME_RE.test(session) ? { box, session } : null);
  if (t === '.' || t.startsWith('./')) {
    const own = boxes.find((b) => b && b.id === callerBoxId);
    if (!own) return null;
    return at(own, t === '.' ? own.sessionName : t.slice(2));
  }
  const byLabel = (label) => {
    const want = canon(label);
    return want === '' ? [] : boxes.filter((b) => b && typeof b.label === 'string' && canon(b.label) === want);
  };
  const whole = byLabel(t);
  if (whole.length === 1) return at(whole[0], whole[0].sessionName);
  if (whole.length > 1) return null;
  const cut = t.lastIndexOf('/');
  if (cut <= 0) return null;
  const left = byLabel(t.slice(0, cut));
  return left.length === 1 ? at(left[0], t.slice(cut + 1)) : null;
}

// `holdMs` (the waiter hold, design 6.7) is the delivery engine's; it is accepted here so the
// factory's signature does not change when delivery lands.
export function createAgentMailHub({ store, policyStore, listBoxes, marksOf, now = () => Date.now(), holdMs = 300000 }) {
  // ---- callers ----

  // A copy of the caller when it is well formed, else null.
  function callerOf(caller) {
    if (caller === null || typeof caller !== 'object') return null;
    const { boxId, session } = caller;
    if (typeof boxId !== 'string' || boxId === '' || typeof session !== 'string' || !SESSION_NAME_RE.test(session)) return null;
    return { boxId, session };
  }
  const badCaller = () => ({ ok: false, text: refusalText('no-agent', { who: 'this session' }) });

  // Refusal text when `me` is not running an agent, else null.
  function agentCheck(me, boxes) {
    return readMark(me).running ? null : refusalText('no-agent', { who: nameOf(boxes, me) });
  }

  // Logs the refusal and answers with it. `target` is what the caller typed (or the thread id).
  function refuse(me, target, text) {
    store.addRefusal({ from: me, target: cleanTarget(target), reason: text });
    return { ok: false, text };
  }

  // ---- agent state ----

  // { reachable, running, mark }: `running` is the brief's own-key test; mark is that marker.
  function readMark({ boxId, session }) {
    const marks = marksOf(boxId);
    if (marks === null || typeof marks !== 'object') return { reachable: false, running: false, mark: null };
    const running = Object.hasOwn(marks, session);
    return { reachable: true, running, mark: running ? marks[session] : null };
  }

  // Connected waiters of one session. Nothing connects yet: the delivery engine fills this.
  function waitersOf(boxId, session) {
    return 0;
  }

  // ---- labels ----

  function labelOf(boxes, boxId) {
    const box = boxes.find((b) => b && b.id === boxId);
    return box && typeof box.label === 'string' && box.label !== '' ? box.label : undefined;
  }
  const nameOf = (boxes, p) => `${labelOf(boxes, p.boxId) || 'removed box'}/${p.session}`;
  const namesFn = (boxes) => (boxId) => labelOf(boxes, boxId);

  // ---- threads ----

  // 'starter' | 'peer' | null
  function sideOf(thread, me) {
    if (!thread) return null;
    for (const side of ['starter', 'peer']) {
      if (thread[side].boxId === me.boxId && thread[side].session === me.session) return side;
    }
    return null;
  }
  const otherSide = (side) => (side === 'starter' ? 'peer' : 'starter');

  const readPolicies = () => policyStore.all();

  // Does the permission that started this thread still hold? (design 6.2)
  const permitted = (thread, policies) => mayStart(policies, thread.starter.boxId, thread.peer.boxId).ok;

  // Every close the hub makes goes through here, so ending the waits on a thread has one home.
  function endThread(threadId, reason) {
    return store.closeThread(threadId, reason);
  }

  // Closes an open thread whose permission is gone. True when the thread may carry mail.
  function keepIfPermitted(thread, policies) {
    if (thread.state !== 'open') return false;
    if (permitted(thread, policies)) return true;
    endThread(thread.id, 'permission withdrawn');
    return false;
  }

  // The status phrase of a closed thread, or null.
  function closedPhrase(thread) {
    return thread && Object.hasOwn(CLOSED_KIND, thread.reason) ? statusPhrase(CLOSED_KIND[thread.reason]) : null;
  }
  function closedText(thread) {
    const why = closedPhrase(thread);
    return why ? `${refusalText('closed')}\n${why}` : refusalText('closed');
  }

  // Where a message just queued for `recipient` stands, as the sender is told.
  function queuedStatus(boxes, recipient) {
    const who = nameOf(boxes, recipient);
    const { reachable, running, mark } = readMark(recipient);
    if (!reachable) return statusPhrase('queued');
    if (!running) return statusPhrase('queued-no-agent', { who });
    if (mark?.state === 'working') return statusPhrase('queued-working', { who });
    if (mark?.state === 'blocked') return statusPhrase('queued-blocked', { who });
    return waitersOf(recipient.boxId, recipient.session) > 0 ? statusPhrase('queued') : statusPhrase('queued-not-listening', { who });
  }
  const sentText = (boxes, threadId, recipient) => `Sent. Thread ${threadId}. ${queuedStatus(boxes, recipient)}`;

  // Undelivered messages of `thread` addressed to the participant on `side`.
  const undeliveredFor = (thread, side) => thread.messages.filter((m) => m.from !== side && UNDELIVERED.includes(m.state));

  function markDelivered(threadId, messageId) {
    store.setMessageState(threadId, messageId, 'delivered', { deliveredAt: now() });
  }

  // ---- delivery seam ----

  // Offer the queued mail of `recipient` ({ boxId, session }) to whoever can take it. The
  // delivery engine fills this; called after every message the hub queues.
  function pump(recipient) {}

  // ---- operations ----

  async function who(caller) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await listBoxes();
    const policies = await readPolicies();
    const denied = agentCheck(me, boxes);
    if (denied) return refuse(me, '', denied);
    const rows = [];
    for (const box of boxes) {
      if (!box || typeof box.id !== 'string') continue;
      if (!mayStart(policies, me.boxId, box.id).ok) continue;
      const marks = marksOf(box.id);
      if (marks === null || typeof marks !== 'object') continue;
      for (const session of Object.keys(marks).filter((s) => SESSION_NAME_RE.test(s)).sort()) {
        if (box.id === me.boxId && session === me.session) continue;
        const state = marks[session]?.state;
        if (!Object.hasOwn(STATE_WORD, state)) continue;
        rows.push({ box: labelOf(boxes, box.id) || box.id, session, state: STATE_WORD[state], listening: waitersOf(box.id, session) > 0 });
      }
    }
    return { ok: true, text: renderWho(rows) };
  }

  async function send(caller, target, rawBody) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const typed = cleanTarget(target);
    const boxes = await listBoxes();
    const policies = await readPolicies();
    const denied = agentCheck(me, boxes);
    if (denied) return refuse(me, typed, denied);
    const to = resolveTarget(target, boxes, me.boxId);
    if (!to) return refuse(me, typed, refusalText('unknown-box', { target: typed }));
    const peer = { boxId: to.box.id, session: to.session };
    if (peer.boxId === me.boxId && peer.session === me.session) return refuse(me, typed, refusalText('own-session'));
    const body = cleanBody(rawBody);
    const problem = bodyProblem(body);
    if (problem) return refuse(me, typed, refusalText(problem === 'empty' ? 'empty' : 'too-large'));
    const allowed = mayStart(policies, me.boxId, peer.boxId);
    if (!allowed.ok) return refuse(me, typed, refusalText(allowed.code, { target: typed }));
    const { reachable, running } = readMark(peer);
    if (!reachable) return refuse(me, typed, refusalText('unreachable'));
    if (!running) return refuse(me, typed, refusalText('no-agent', { who: nameOf(boxes, peer) }));
    const thread = store.createThread({ starter: me, peer });
    store.addMessage(thread.id, { from: 'starter', body });
    pump(peer);
    return { ok: true, threadId: thread.id, text: sentText(boxes, thread.id, peer) };
  }

  async function reply(caller, threadId, rawBody) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await listBoxes();
    const policies = await readPolicies();
    // Everything below is synchronous on the store, so the thread cannot change under it.
    const denied = agentCheck(me, boxes);
    if (denied) return refuse(me, threadId, denied);
    const thread = store.thread(threadId);
    const side = sideOf(thread, me);
    if (!side) return refuse(me, threadId, refusalText('not-a-participant'));
    if (thread.state !== 'open') return refuse(me, threadId, closedText(thread));
    if (!keepIfPermitted(thread, policies)) return refuse(me, threadId, closedText(store.thread(thread.id)));
    const body = cleanBody(rawBody);
    const problem = bodyProblem(body);
    if (problem) return refuse(me, threadId, refusalText(problem === 'empty' ? 'empty' : 'too-large'));
    const recipient = thread[otherSide(side)];
    store.addMessage(thread.id, { from: side, body });
    pump(recipient);
    return { ok: true, text: sentText(boxes, thread.id, recipient) };
  }

  async function read(caller, threadId) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await listBoxes();
    const policies = await readPolicies();
    const thread = store.thread(threadId);
    const side = sideOf(thread, me);
    if (!side) return refuse(me, threadId, refusalText('not-a-participant'));
    if (thread.state === 'open' && keepIfPermitted(thread, policies)) {
      for (const m of undeliveredFor(thread, side)) markDelivered(thread.id, m.id);
    }
    return { ok: true, text: renderThread(store.thread(thread.id), namesFn(boxes)) };
  }

  async function inbox(caller) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await listBoxes();
    const policies = await readPolicies();
    const items = [];
    for (const thread of store.threads()) {
      const side = sideOf(thread, me);
      if (!side) continue;
      const pending = undeliveredFor(thread, side);
      if (pending.length === 0 || !keepIfPermitted(thread, policies)) continue;
      const from = nameOf(boxes, thread[otherSide(side)]);
      for (const m of pending) items.push({ messageId: m.id, threadId: thread.id, from, body: m.body, at: m.at });
    }
    items.sort((a, b) => a.at - b.at); // oldest first; stable within one timestamp
    for (const i of items) markDelivered(i.threadId, i.messageId);
    return { ok: true, text: renderInbox(items.map(({ messageId, threadId, from, body }) => ({ messageId, threadId, from, body }))) };
  }

  return { who, send, reply, read, inbox };
}
