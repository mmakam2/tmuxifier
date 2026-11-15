// Per-box agent-messaging policy: pure rules, no I/O (design section 6.2).
//
//   <box id>: { send, sendTo: [box id], receive, receiveFrom: [box id] }
//
// Box ids are user-controlled keys: lookups use Object.hasOwn and maps built here have no
// prototype, so an id named `__proto__` or `constructor` is an ordinary key.

export const MAX_LIST = 200;

export const EMPTY_POLICY = Object.freeze({
  send: false,
  sendTo: Object.freeze([]),
  receive: false,
  receiveFrom: Object.freeze([]),
});

function normalizeList(raw, { selfId, knownIds }) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('list must be an array of box ids');
  if (raw.length > MAX_LIST) throw new Error('too many boxes');
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string') throw new Error('list must be an array of box ids');
    if (id === selfId || seen.has(id)) continue;
    if (!knownIds.has(id)) throw new Error(`unknown box: ${id}`);
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function normalizePolicy(raw, ctx) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy must be an object');
  return {
    send: raw.send === true,
    sendTo: normalizeList(raw.sendTo, ctx),
    receive: raw.receive === true,
    receiveFrom: normalizeList(raw.receiveFrom, ctx),
  };
}

export const isEnabled = (policy) => !!policy && (policy.send === true || policy.receive === true);

const policyOf = (policies, id) => (policies && Object.hasOwn(policies, id) ? policies[id] : EMPTY_POLICY);

// May a thread be started from box `fromId` to box `toId` (equal ids = two sessions of one box)?
export function mayStart(policies, fromId, toId) {
  const from = policyOf(policies, fromId);
  const to = policyOf(policies, toId);
  if (!from.send) return { ok: false, code: 'send-off' };
  if (fromId !== toId && !from.sendTo.includes(toId)) return { ok: false, code: 'not-in-send-list' };
  if (!to.receive) return { ok: false, code: 'receive-off' };
  if (fromId !== toId && !to.receiveFrom.includes(fromId)) return { ok: false, code: 'not-in-receive-list' };
  return { ok: true };
}
