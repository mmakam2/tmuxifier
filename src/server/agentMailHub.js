import { SESSION_NAME_RE } from './sshCommand.js';
import { mayStart } from './agentMailPolicy.js';
import {
  cleanBody, bodyProblem, statusPhrase, refusalText, renderThread, renderWho, renderInbox, renderReply, wakeText,
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
//   read(caller, threadId)         the whole thread; the caller's messages become delivered, and a
//                                  dropped message addressed to it shows as [not delivered]
//   inbox(caller)                  undelivered messages for the caller; they become delivered
//   waitMail(caller, pane, signal) the waiter's held request (design 6.7): { text, messageId } or
//                                  { idle: true } after `holdMs` / on abort / when the box goes
//   waitReplies(caller, threadIds, timeoutMs, signal)
//                                  `tmx wait`: { got: true, text } with the replies, or
//                                  { got: false, text } with one status line per thread
//   ack(caller, messageId)         the prompt hook's confirmation of a handed message
//   boxChanged(boxId)              the box's markers were re-read (sweep, real-time refresh)
//   policyChanged()                closes every open thread whose permission is gone
//   boxRemoved(boxId)              closes the box's threads, ends its waiters
//   closeThread(threadId, reason)  the operator's close; false for an unknown or closed thread
//   listening(boxId)               { [session]: connected waiters }
//   threadStatus(thread, viewer)   where a thread stands, as one status phrase
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
// Delivery (design 6.7). A queued message for a session goes, oldest first, to an open
// `waitReplies` of that session on its thread (state `delivered`), else to ONE connected waiter of
// that session, and only while the session's marker reads `ready` (state `handed`, with
// `handedAt`/`handedPane`). Either way the thread's permission is re-checked at that moment, and a
// thread whose permission is gone is closed instead. `ack` confirms a handed message; a waiter
// that connects puts back to `queued` the session's handed messages that were handed on its own
// pane or more than REOFFER_MS ago, so a wake lost inside a dying Claude Code is offered again.
// It also ends, idle, any older held waiter of the same session and pane: the box runs one
// waiter per pane, so an older one is an orphan and must not be handed anything. The check runs
// when a message is queued (synchronously, inside send/reply), when a waiter or a reply wait
// connects, and on `boxChanged`.
//
// Every held request (waiter or reply wait) settles exactly once: whichever of delivery, its
// timer, its abort signal, or its thread's close (box removal for a waiter) comes first. Settling
// clears the timer and the abort listener and takes it out of its registry in the same
// synchronous step, so nothing can be handed to a request that has already answered.
//
// `pending` is the hub's index of where undelivered mail may be: per recipient session, the ids
// of threads that may hold a `queued`/`handed` message addressed to it. It is a SUPERSET: built
// from the store once, when the hub is created (the store must be loaded by then), an id is added
// on every message the hub queues (the hub is the only writer of messages), and an id is removed
// only after reading that thread from the store and finding nothing undelivered for that session
// (or the thread gone or closed). So the hot paths (boxChanged after every sweep, a waiter
// connecting) copy only the threads that have mail for that one session, and only when someone
// can take it; read/inbox delivering behind the index's back just leaves an entry to drop later.

const TARGET_MAX = 200;
// C0, DEL, C1 and the bidi controls (as status.js cleanWindowName strips).
// eslint-disable-next-line no-control-regex
const TARGET_CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// marker state -> the word `who` shows (the dashboard's words for a session with no new turn)
const STATE_WORD = Object.assign(Object.create(null), { ready: 'idle', working: 'working', blocked: 'blocked' });
const CLOSED_KIND = Object.assign(Object.create(null), {
  operator: 'closed-operator',
  'permission withdrawn': 'closed-withdrawn',
  'box removed': 'closed-box-removed',
});
const UNDELIVERED = ['queued', 'handed'];
// What a recipient sees in place of a message that was dropped before it reached it.
const NOT_DELIVERED = '[not delivered]';
const SIDES = ['starter', 'peer'];
const PANE_RE = /^%\d{1,9}$/; // a tmux pane id; it only tells one session's waiters apart
const MSG_ID_RE = /^m-[a-hj-km-np-z2-9]{8}$/;
// A handed message no ack confirmed is offered to any waiter of its session after this long.
const REOFFER_MS = 600_000;
const WAIT_MIN_MS = 1000;
const WAIT_MAX_MS = 540_000;
const IDLE = () => ({ idle: true });

// `tmx wait`'s timeout, clamped; anything that is not a number is the minimum.
function clampWait(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, n)) : WAIT_MIN_MS;
}

// boxId -> session -> Set. Maps, so a box id or session name is never a property name.
function bySession() {
  const top = new Map();
  return {
    get: (boxId, session) => top.get(boxId)?.get(session),
    box: (boxId) => top.get(boxId),
    add(boxId, session, item) {
      let m = top.get(boxId);
      if (!m) top.set(boxId, (m = new Map()));
      let set = m.get(session);
      if (!set) m.set(session, (set = new Set()));
      set.add(item);
    },
    delete(boxId, session, item) {
      const m = top.get(boxId);
      const set = m?.get(session);
      if (!set) return;
      set.delete(item);
      if (set.size === 0) m.delete(session);
      if (m.size === 0) top.delete(boxId);
    },
    dropBox: (boxId) => { top.delete(boxId); },
    *all() { for (const m of top.values()) for (const set of m.values()) yield* set; },
  };
}

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

// `holdMs` is how long a waiter is held before it is answered idle (design 6.7: five minutes).
// Create the hub after `store.load()`: its delivery index is built from the store here.
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

  // ---- held requests ----

  const waiters = bySession(); // recipient -> held waitMail requests, oldest first
  const replyWaits = bySession(); // caller -> held waitReplies requests
  const pending = bySession(); // recipient -> thread ids that may hold mail for it (see header)

  // Connected waiters of one session.
  const waitersOf = (boxId, session) => waiters.get(boxId, session)?.size ?? 0;

  // Registers one held request of `me` in `registry` and returns it with its promise. `onEnd()`
  // makes the answer when the timer or the abort signal ends it; if it throws, `fallback` is the
  // answer, so the request still settles.
  function hold(registry, me, ms, signal, onEnd, fallback) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const held = { me, settled: false };
    const end = () => {
      let value = fallback;
      try { value = onEnd(); } catch (e) { console.error(`[tmuxifier] agent mail: ${e.message}`); }
      held.settle(value);
    };
    const timer = setTimeout(end, ms);
    held.settle = (value) => {
      if (held.settled) return;
      held.settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', end);
      registry.delete(me.boxId, me.session, held);
      resolve(value);
    };
    signal?.addEventListener('abort', end, { once: true });
    registry.add(me.boxId, me.session, held);
    return { held, promise };
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
    for (const side of SIDES) {
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
    const ok = store.closeThread(threadId, reason);
    if (ok) {
      const ended = [...replyWaits.all()].filter((w) => w.threadIds.includes(threadId));
      for (const w of ended) w.settle({ got: false, text: statusLines(w.me, w.threadIds, lastBoxes) });
    }
    return ok;
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

  // Where a queued message for `recipient` stands.
  function queuedStatus(boxes, recipient) {
    const who = nameOf(boxes, recipient);
    const { reachable, running, mark } = readMark(recipient);
    if (!reachable) return statusPhrase('queued');
    if (!running) return statusPhrase('queued-no-agent', { who });
    if (mark?.state === 'working') return statusPhrase('queued-working', { who });
    if (mark?.state === 'blocked') return statusPhrase('queued-blocked', { who });
    return waitersOf(recipient.boxId, recipient.session) > 0 ? statusPhrase('queued') : statusPhrase('queued-not-listening', { who });
  }

  // Where one message stands: queued (with why), handed to a listening waiter and not yet
  // confirmed (plain `queued`), delivered, or its thread's close.
  function messageStatus(thread, m, boxes) {
    if (thread.state !== 'open') return closedPhrase(thread) ?? refusalText('closed');
    if (m.state === 'queued') return queuedStatus(boxes, thread[otherSide(m.from)]);
    if (m.state === 'delivered') {
      const seconds = Math.max(0, Math.floor((now() - (m.deliveredAt ?? m.at)) / 1000));
      return statusPhrase('delivered-no-reply', { seconds });
    }
    return statusPhrase('queued');
  }

  // Where a thread stands: its newest message's status. With the phrases there are, that reads
  // the same from either side, so `viewer` changes nothing today. `boxes` (for names) defaults
  // to the list the hub read last.
  function threadStatus(thread, viewer, boxes = lastBoxes) {
    if (thread.state !== 'open') return closedPhrase(thread) ?? refusalText('closed');
    const last = thread.messages[thread.messages.length - 1];
    return last ? messageStatus(thread, last, boxes) : statusPhrase('queued');
  }

  // One `thread <id>: <status>` line per thread id, for `me` (a participant of each).
  function statusLines(me, threadIds, boxes) {
    return threadIds.map((id) => {
      const t = store.thread(id);
      const side = sideOf(t, me);
      return `thread ${cleanTarget(id)}: ${side ? threadStatus(t, side, boxes) : refusalText('not-a-participant')}`;
    }).join('\n');
  }

  // The answer to a send or reply: the status of the message it just queued.
  function sentText(boxes, threadId, messageId) {
    const t = store.thread(threadId);
    const m = t.messages.find((x) => x.id === messageId);
    return `Sent. Thread ${threadId}. ${m ? messageStatus(t, m, boxes) : threadStatus(t, 'starter', boxes)}`;
  }

  // The thread as the participant on `side` may read it: a dropped message it did not send never
  // reached it, so its body is withheld. The sender still sees its own words.
  function viewFor(thread, side) {
    return {
      ...thread,
      messages: thread.messages.map((m) => (m.state === 'dropped' && m.from !== side ? { ...m, body: NOT_DELIVERED } : m)),
    };
  }

  // Undelivered messages of `thread` addressed to the participant on `side`.
  const undeliveredFor = (thread, side) => thread.messages.filter((m) => m.from !== side && UNDELIVERED.includes(m.state));

  function markDelivered(threadId, messageId) {
    store.setMessageState(threadId, messageId, 'delivered', { deliveredAt: now() });
  }

  // ---- delivery ----

  let lastBoxes = [];
  async function boxesNow() {
    const boxes = await listBoxes();
    if (Array.isArray(boxes)) lastBoxes = boxes;
    return boxes;
  }
  // For rare operations whose only use of boxes is naming: a failed read keeps the last list.
  const refreshBoxes = () => boxesNow().catch(() => lastBoxes);

  // The open threads that hold undelivered mail for `me`, each read from the store once; index
  // entries that no longer do are dropped here (and only here, apart from boxRemoved).
  function pendingThreads(me) {
    const ids = pending.get(me.boxId, me.session);
    if (!ids) return [];
    const out = [];
    for (const id of [...ids]) {
      const thread = store.thread(id);
      const side = thread && thread.state === 'open' ? sideOf(thread, me) : null;
      if (!side || undeliveredFor(thread, side).length === 0) {
        pending.delete(me.boxId, me.session, id);
        continue;
      }
      out.push({ thread, side });
    }
    return out;
  }

  const replyWaitOn = (me, threadId) => {
    const set = replyWaits.get(me.boxId, me.session);
    if (set) for (const w of set) if (w.threadIds.includes(threadId)) return w;
    return null;
  };
  const firstWaiter = (me) => {
    const set = waiters.get(me.boxId, me.session);
    if (set) for (const w of set) return w;
    return null;
  };

  // Could anything of `me`'s take a message right now? Cheap: no store reads.
  function canTake(me) {
    if (!pending.get(me.boxId, me.session)) return false;
    if (replyWaits.get(me.boxId, me.session)) return true;
    return waitersOf(me.boxId, me.session) > 0 && readMark(me).mark?.state === 'ready';
  }

  // Hands `me`'s queued mail, oldest first, to whoever can take it. Synchronous on the store.
  function deliverTo(me, boxes, policies) {
    const queue = [];
    for (const { thread, side } of pendingThreads(me)) {
      for (const m of thread.messages) if (m.from !== side && m.state === 'queued') queue.push({ thread, side, m });
    }
    queue.sort((a, b) => a.m.at - b.m.at); // stable: one thread's messages keep their order
    const ready = readMark(me).mark?.state === 'ready';
    const allowed = new Map(); // thread id -> the permission re-check, made once per thread
    for (const { thread, side, m } of queue) {
      const wait = replyWaitOn(me, thread.id);
      const waiter = wait || !ready ? null : firstWaiter(me);
      if (!wait && !waiter) continue;
      if (!allowed.has(thread.id)) allowed.set(thread.id, keepIfPermitted(thread, policies));
      if (!allowed.get(thread.id)) continue;
      const from = nameOf(boxes, thread[otherSide(side)]);
      if (wait) {
        markDelivered(thread.id, m.id);
        wait.settle({ got: true, text: renderReply({ from, threadId: thread.id, body: m.body }) });
      } else {
        store.setMessageState(thread.id, m.id, 'handed', { handedAt: now(), handedPane: waiter.pane });
        waiter.settle({ text: wakeText({ messageId: m.id, threadId: thread.id, from, body: m.body }), messageId: m.id });
      }
    }
  }

  // Offer the queued mail of `recipient` ({ boxId, session }) to whoever can take it. Reads the
  // box list and the policy only when someone can.
  async function pump(recipient) {
    try {
      if (!canTake(recipient)) return;
      const boxes = await boxesNow();
      const policies = await readPolicies();
      deliverTo(recipient, boxes, policies);
    } catch (e) {
      console.error(`[tmuxifier] agent mail: delivery failed: ${e.message}`);
    }
  }

  // A message the hub just queued for `recipient` on `threadId`: index it, offer it at once.
  function queued(recipient, threadId, boxes, policies) {
    pending.add(recipient.boxId, recipient.session, threadId);
    if (canTake(recipient)) deliverTo(recipient, boxes, policies);
  }

  // The index, from the store as loaded.
  for (const t of store.threads()) {
    if (t.state !== 'open') continue;
    for (const side of SIDES) if (undeliveredFor(t, side).length > 0) pending.add(t[side].boxId, t[side].session, t.id);
  }

  // ---- operations ----

  async function who(caller) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await boxesNow();
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
    const boxes = await boxesNow();
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
    if (!reachable) return refuse(me, typed, refusalText('unreachable', { target: typed }));
    if (!running) return refuse(me, typed, refusalText('no-agent', { who: nameOf(boxes, peer) }));
    const thread = store.createThread({ starter: me, peer });
    const m = store.addMessage(thread.id, { from: 'starter', body });
    queued(peer, thread.id, boxes, policies);
    return { ok: true, threadId: thread.id, text: sentText(boxes, thread.id, m.id) };
  }

  async function reply(caller, threadId, rawBody) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await boxesNow();
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
    const m = store.addMessage(thread.id, { from: side, body });
    queued(recipient, thread.id, boxes, policies);
    return { ok: true, text: sentText(boxes, thread.id, m.id) };
  }

  async function read(caller, threadId) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await boxesNow();
    const policies = await readPolicies();
    const thread = store.thread(threadId);
    const side = sideOf(thread, me);
    if (!side) return refuse(me, threadId, refusalText('not-a-participant'));
    if (thread.state === 'open' && keepIfPermitted(thread, policies)) {
      for (const m of undeliveredFor(thread, side)) markDelivered(thread.id, m.id);
    }
    return { ok: true, text: renderThread(viewFor(store.thread(thread.id), side), namesFn(boxes)) };
  }

  async function inbox(caller) {
    const me = callerOf(caller);
    if (!me) return badCaller();
    const boxes = await boxesNow();
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

  // The waiter's held request. A malformed caller or pane, or an aborted signal, is answered idle
  // at once and never listens. No marker is required: a waiter armed at SessionStart may connect
  // before the first sweep sees the agent, and handing needs a `ready` marker anyway.
  function waitMail(caller, pane, signal) {
    const me = callerOf(caller);
    if (!me || typeof pane !== 'string' || !PANE_RE.test(pane) || signal?.aborted) return Promise.resolve(IDLE());
    // One waiter runs per pane (the box-side lock), so a new one proves the older waiters of
    // this session's pane dead (an orphaned request): they end idle now, and mail is only ever
    // handed to the newest waiter of a pane.
    for (const w of [...(waiters.get(me.boxId, me.session) ?? [])]) if (w.pane === pane) w.settle(IDLE());
    const { held, promise } = hold(waiters, me, holdMs, signal, IDLE, IDLE());
    held.pane = pane;
    // Offer again: what was handed on this pane (that request has ended without an ack), or so
    // long ago that its waiter is surely gone, goes back in the queue.
    const at = now();
    for (const { thread, side } of pendingThreads(me)) {
      for (const m of undeliveredFor(thread, side)) {
        if (m.state === 'handed' && (m.handedPane === pane || !(at - m.handedAt <= REOFFER_MS))) {
          store.setMessageState(thread.id, m.id, 'queued');
        }
      }
    }
    void pump(me);
    return promise;
  }

  // `tmx wait`. Answers at once with every reply already queued for the caller on those threads,
  // or with the status lines when one of them is closed (or its permission is gone); otherwise
  // holds until a message for the caller arrives on one of them (the first one is returned), a
  // thread closes, the timeout, or the abort. The caller must be a participant of every thread.
  async function waitReplies(caller, threadIds, timeoutMs, signal) {
    const me = callerOf(caller);
    if (!me) return { got: false, text: badCaller().text };
    const ids = Array.isArray(threadIds) ? [...new Set(threadIds)] : [];
    const ms = clampWait(timeoutMs);
    const boxes = await boxesNow();
    const policies = await readPolicies();
    // Synchronous on the store from here.
    const notMine = (target) => ({ got: false, text: refuse(me, target, refusalText('not-a-participant')).text });
    if (ids.length === 0) return notMine('');
    for (const id of ids) if (!sideOf(store.thread(id), me)) return notMine(id);
    // A caller that has gone takes nothing: what it would take could never reach it.
    if (signal?.aborted) return { got: false, text: statusLines(me, ids, boxes) };
    for (const id of ids) {
      const t = store.thread(id);
      if (t.state === 'open') keepIfPermitted(t, policies);
    }
    const taken = [];
    let closed = false;
    for (const id of ids) {
      const t = store.thread(id);
      if (t.state !== 'open') { closed = true; continue; }
      const side = sideOf(t, me);
      for (const m of t.messages) if (m.from !== side && m.state === 'queued') taken.push({ t, side, m });
    }
    if (taken.length > 0) {
      taken.sort((a, b) => a.m.at - b.m.at);
      for (const { t, m } of taken) markDelivered(t.id, m.id);
      const text = taken.map(({ t, side, m }) => renderReply({ from: nameOf(boxes, t[otherSide(side)]), threadId: t.id, body: m.body }));
      return { got: true, text: text.join('\n\n') };
    }
    if (closed) return { got: false, text: statusLines(me, ids, boxes) };
    const lines = () => ({ got: false, text: statusLines(me, ids, lastBoxes) });
    const { held, promise } = hold(replyWaits, me, ms, signal, lines, { got: false, text: '' });
    held.threadIds = ids;
    return promise;
  }

  // The prompt hook's confirmation. Only a `handed` message addressed to the caller moves; the id
  // comes from text the agent read, which may quote another message's tag.
  async function ack(caller, messageId) {
    const me = callerOf(caller);
    if (!me || typeof messageId !== 'string' || !MSG_ID_RE.test(messageId)) return false;
    for (const { thread, side } of pendingThreads(me)) {
      const m = thread.messages.find((x) => x.id === messageId && x.from !== side && x.state === 'handed');
      if (m) {
        markDelivered(thread.id, m.id);
        return true;
      }
    }
    return false;
  }

  // The box's markers were re-read: a session that turned `ready` may take its mail now.
  function boxChanged(boxId) {
    const sessions = pending.box(boxId);
    if (!sessions) return;
    for (const session of [...sessions.keys()]) {
      const me = { boxId, session };
      if (canTake(me)) void pump(me);
    }
  }

  async function policyChanged() {
    await refreshBoxes();
    const policies = await readPolicies();
    for (const t of store.threads()) if (t.state === 'open') keepIfPermitted(t, policies);
  }

  async function boxRemoved(boxId) {
    await refreshBoxes();
    for (const t of store.threads()) {
      if (t.state === 'open' && (t.starter.boxId === boxId || t.peer.boxId === boxId)) endThread(t.id, 'box removed');
    }
    for (const w of [...(waiters.box(boxId)?.values() ?? [])].flatMap((set) => [...set])) w.settle(IDLE());
    pending.dropBox(boxId);
  }

  // The operator's close. False for an unknown thread and for one already closed.
  async function closeThread(threadId, reason = 'operator') {
    await refreshBoxes();
    const t = store.thread(threadId);
    if (!t || t.state !== 'open') return false;
    return endThread(t.id, reason);
  }

  function listening(boxId) {
    const out = Object.create(null);
    for (const [session, set] of waiters.box(boxId) ?? []) out[session] = set.size;
    return out;
  }

  return {
    who, send, reply, read, inbox,
    waitMail, waitReplies, ack, boxChanged, policyChanged, boxRemoved, closeThread, listening, threadStatus,
  };
}
