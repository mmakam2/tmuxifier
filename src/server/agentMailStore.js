import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './jsonFile.js';

// data/agent-mail/: one file per thread (t-xxxxxxxx.json) plus refusals.json, each written 0o600
// through jsonFile.js. One file per thread because a thread can grow for as long as two agents
// talk and a single-file store would rewrite everything on every message.
//
// State lives in memory; every method but load() and whenIdle() is synchronous on it and
// persistence trails behind. A changed thread is written by `schedule`, which coalesces: one
// write in flight per thread, and any number of changes during it cost exactly one more write.
// Thread ids come off disk filenames and are checked against ID_RE before they are ever joined
// onto a path. Callers get deep copies, so nothing they hold can corrupt the store.

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1
const ID_BODY = '[a-hj-km-np-z2-9]{8}';
const THREAD_FILE_RE = new RegExp(`^t-${ID_BODY}\\.json$`);
// The id alphabet as patterns, for whoever takes an id off the wire (the listener).
export const THREAD_ID_RE = new RegExp(`^t-${ID_BODY}$`);
export const MSG_ID_RE = new RegExp(`^m-${ID_BODY}$`);

export const MAX_MESSAGES = 500;
export const MAX_THREADS = 1000;
export const MAX_REFUSALS = 200;
export const IDLE_DELETE_MS = 30 * 24 * 60 * 60 * 1000;

const MESSAGE_STATES = ['queued', 'handed', 'delivered', 'dropped'];
const CLOSE_REASONS = ['operator', 'permission withdrawn', 'box removed'];
const SIDES = ['starter', 'peer'];
const REFUSALS_FILE = 'refusals';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (n) => Number.isFinite(n) && n >= 0;
const isParticipant = (p) => isObj(p) && typeof p.boxId === 'string' && p.boxId !== '' && typeof p.session === 'string' && p.session !== '';
const cleanParticipant = (p) => ({ boxId: p.boxId, session: p.session });
const copy = (v) => structuredClone(v);

function validMessage(m) {
  return isObj(m) && MSG_ID_RE.test(m.id) && typeof m.kind === 'string' && SIDES.includes(m.from)
    && typeof m.body === 'string' && isTime(m.at) && MESSAGE_STATES.includes(m.state);
}

function validThread(t, id) {
  return isObj(t) && t.v === 1 && t.id === id && isParticipant(t.starter) && isParticipant(t.peer)
    && (t.state === 'open' || t.state === 'closed') && isTime(t.createdAt) && isTime(t.activeAt)
    && Number.isInteger(t.dropped) && t.dropped >= 0 && Array.isArray(t.messages) && t.messages.every(validMessage);
}

function validRefusal(r) {
  return isObj(r) && isTime(r.at) && isParticipant(r.from) && typeof r.target === 'string' && typeof r.reason === 'string';
}

export function createAgentMailStore({ dataDir, now = () => Date.now(), randomBytes = crypto.randomBytes }) {
  const dir = path.join(dataDir, 'agent-mail');
  const fileOf = (key) => path.join(dir, `${key}.json`);

  const threadsById = Object.create(null);
  let refusalList = [];

  function mintId(prefix, taken) {
    for (;;) {
      let body = '';
      while (body.length < 8) {
        for (const b of randomBytes(16)) {
          if (b >= 248) continue; // 248 = 31 * 8: reject the tail so every character is equally likely
          body += ALPHABET[b % 31];
          if (body.length === 8) break;
        }
      }
      const id = `${prefix}-${body}`;
      if (!taken(id)) return id;
    }
  }

  // ---- persistence: at most one write in flight per key, changes during it coalesce ----
  const writers = new Map(); // key -> { running: Promise, again: boolean }

  function schedule(key) {
    const w = writers.get(key);
    if (w) { w.again = true; return; }
    const entry = { again: false, running: null };
    entry.running = (async () => {
      try {
        do {
          entry.again = false;
          try {
            await persistOnce(key);
          } catch (e) {
            console.error(`[tmuxifier] agent mail: could not write ${fileOf(key)}: ${e.message}`);
          }
        } while (entry.again);
      } finally {
        writers.delete(key);
      }
    })();
    writers.set(key, entry);
  }

  async function persistOnce(key) {
    if (key === REFUSALS_FILE) {
      await writeJson(fileOf(key), { v: 1, refusals: copy(refusalList) });
      return;
    }
    const t = threadsById[key];
    if (t) await writeJson(fileOf(key), copy(t));
    else await fsp.unlink(fileOf(key)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  async function whenIdle() {
    while (writers.size) await Promise.all([...writers.values()].map((w) => w.running));
  }

  // ---- load ----
  async function load() {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const name of names) {
      if (!THREAD_FILE_RE.test(name)) continue;
      const id = name.slice(0, -'.json'.length);
      const t = await readJson(path.join(dir, name), { fallback: null, validate: (v) => validThread(v, id) });
      if (!t) continue;
      let changed = false;
      for (const m of t.messages) {
        if (m.state === 'handed') {
          m.state = 'queued'; // no waiter survived the restart
          delete m.handedAt;
          delete m.handedPane;
          changed = true;
        }
      }
      threadsById[id] = t;
      if (changed) schedule(id);
    }
    const doc = await readJson(fileOf(REFUSALS_FILE), {
      fallback: null,
      validate: (v) => isObj(v) && v.v === 1 && Array.isArray(v.refusals) && v.refusals.every(validRefusal),
    });
    refusalList = doc ? doc.refusals.slice(0, MAX_REFUSALS) : [];
  }

  // ---- threads ----
  const getLive = (id) => (typeof id === 'string' && Object.hasOwn(threadsById, id) ? threadsById[id] : null);

  function createThread({ starter, peer } = {}) {
    if (!isParticipant(starter) || !isParticipant(peer)) throw new Error('createThread: starter and peer need a boxId and a session');
    const at = now();
    const t = {
      v: 1,
      id: mintId('t', (id) => Object.hasOwn(threadsById, id)),
      starter: cleanParticipant(starter),
      peer: cleanParticipant(peer),
      state: 'open',
      createdAt: at,
      activeAt: at,
      dropped: 0,
      messages: [],
    };
    threadsById[t.id] = t;
    schedule(t.id);
    return copy(t);
  }

  function addMessage(threadId, { from, body } = {}) {
    const t = getLive(threadId);
    if (!t) throw new Error('addMessage: unknown thread');
    if (t.state !== 'open') throw new Error('addMessage: thread is closed');
    if (!SIDES.includes(from)) throw new Error("addMessage: from must be 'starter' or 'peer'");
    if (typeof body !== 'string') throw new Error('addMessage: body must be a string');
    const at = now();
    const taken = (id) => t.messages.some((m) => m.id === id);
    const m = { id: mintId('m', taken), kind: t.messages.length === 0 && t.dropped === 0 ? 'task' : 'reply', from, body, at, state: 'queued' };
    t.messages.push(m);
    if (t.messages.length > MAX_MESSAGES) {
      const extra = t.messages.length - MAX_MESSAGES;
      t.messages.splice(0, extra);
      t.dropped += extra;
    }
    t.activeAt = at;
    schedule(t.id);
    return copy(m);
  }

  function setMessageState(threadId, messageId, state, patch = {}) {
    if (!MESSAGE_STATES.includes(state)) throw new Error(`setMessageState: bad state ${String(state)}`);
    const t = getLive(threadId);
    const m = t && t.messages.find((x) => x.id === messageId);
    if (!m) return; // trimmed or pruned meanwhile
    m.state = state;
    for (const k of ['handedAt', 'handedPane', 'deliveredAt']) {
      if (patch && Object.hasOwn(patch, k) && patch[k] !== undefined) m[k] = patch[k];
    }
    schedule(t.id);
  }

  function closeThread(threadId, reason) {
    const t = getLive(threadId);
    if (!t) return false;
    if (!CLOSE_REASONS.includes(reason)) throw new Error(`closeThread: bad reason ${String(reason)}`);
    if (t.state === 'closed') return true; // idempotent: the first reason stands
    t.state = 'closed';
    t.reason = reason;
    for (const m of t.messages) if (m.state === 'queued' || m.state === 'handed') m.state = 'dropped';
    t.activeAt = now();
    schedule(t.id);
    return true;
  }

  const threads = () => Object.values(threadsById).sort((a, b) => b.activeAt - a.activeAt).map(copy);
  const thread = (id) => { const t = getLive(id); return t ? copy(t) : null; };

  // ---- refusals ----
  function addRefusal({ from, target, reason } = {}) {
    if (!isParticipant(from) || typeof target !== 'string' || typeof reason !== 'string') throw new Error('addRefusal: bad refusal');
    refusalList.unshift({ at: now(), from: cleanParticipant(from), target, reason });
    if (refusalList.length > MAX_REFUSALS) refusalList.length = MAX_REFUSALS;
    schedule(REFUSALS_FILE);
  }
  const refusals = () => copy(refusalList);

  // ---- retention ----
  function prune() {
    const at = now();
    const drop = (id) => { delete threadsById[id]; schedule(id); };
    for (const t of Object.values(threadsById)) if (at - t.activeAt > IDLE_DELETE_MS) drop(t.id);
    const all = Object.values(threadsById);
    let excess = all.length - MAX_THREADS;
    if (excess > 0) {
      const closed = all.filter((t) => t.state === 'closed').sort((a, b) => a.activeAt - b.activeAt);
      for (const t of closed) {
        if (excess-- <= 0) break;
        drop(t.id);
      }
    }
  }

  return { load, threads, thread, createThread, addMessage, setMessageState, closeThread, addRefusal, refusals, prune, whenIdle };
}
