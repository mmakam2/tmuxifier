import crypto from 'node:crypto';
import path from 'node:path';
import {
  buildProbeArgv, buildControlCheckArgv, buildControlForwardArgv, buildControlCancelArgv,
} from './sshCommand.js';
import { isEnabled } from './agentMailPolicy.js';
import { createAgentMailListener } from './agentMailListener.js';
import { mapWithConcurrency } from './concurrency.js';

// The forward (design 6.4): for every box with a messaging switch on, the backend's per-box
// listener (agentMailListener.js, data/mail/<12 hex of sha256(box id)>.sock) is put on the box as
// ~/.tmuxifier-mail/sock by a remote unix-socket forward on the box's ControlMaster
// (`ssh -O forward -R <box path>:<local path>`). The socket a request arrives on is the box's
// identity, so a forward exists only on the master of the box it names.
//
// `sync(boxes, snapshot)` is called after every status sweep, beside agentWatch.sync(). Per box:
//   - switches off, or the box gone from the list: if a forward was ever made, `-O cancel` and a
//     remote `rm -f` of the box-side file; the listener is closed; state `off` (entry dropped).
//   - switches on, not reachable in the sweep's snapshot: the listener stays, state `down`.
//   - switches on, reachable: listener up, then `-O check` for the master's pid. The same pid the
//     forward was last made on means nothing to do, except a recheck every `recheckMs` when the
//     listener has had no request since the last check: the nonce call alone; on failure, the
//     full ensure.
//   - otherwise the full ensure, below. Success records the pid: state `up`.
//   - any failure: `-O cancel` (when a forward was made), state `error` with a short reason, and
//     no attempt for `retryBaseMs`, doubling per consecutive failure up to `retryCapMs`.
//
// The ensure, and why it has a cancel the design's step 3 does not name. Measured behaviour of
// OpenSSH (spike 2, "The forward's lifecycle"): the box-side file outlives every end of a master
// and every cancel, and `-O forward` onto a leftover file fails; so the file is removed first.
// But `-O forward` on a master that ALREADY holds the forward is exit 0 and does nothing, and
// after the file was removed under it the forward stays broken until a cancel. That is exactly the
// state after the remove whenever the master outlived the process that made the forward (a
// Tmuxifier restart over a surviving master, a dev `--watch` reload) or a recheck found it broken.
// So the ensure is: remote mkdir + remove + print $HOME, then cancel (its result is ignored: on a
// fresh master there is nothing to cancel), then forward, then the nonce call. The forward counts
// as up only when this listener itself received the nonce: re-issuing a forward proves nothing.
//
// One forward per ssh master. Two box entries for one machine whose ssh names resolve to the same
// HostName, port and user share a ControlPath (%C), so one master. Measured (Task 16, real sshd):
// the second box's `-O forward` onto the same box path exits 0 and adds a second entry, but the
// master routes the box's connections to the FIRST entry, so the second never verifies; and its
// failure path (the ensure's rm, then its own cancel, which closes the server's listener at the
// box path) leaves no listener at all, while the first still reads `up`. On the master an entry
// is found by its whole spec, box path and local path: `-O cancel` removes only the entry naming
// that local path. So the sync runs in two parts. First, every box in parallel up to its
// `-O check` (after this sync's teardowns, so a forward leaving a master is gone first). Then the
// claim (syncAll): a box holds a master by its claim, kept through a check that says nothing, a
// failed ensure and its hold-off, until it is turned off, removed, changes connection fields or
// sees a DIFFERENT pid. Every unclaimed master goes to the first box in list order that sees it;
// a box seeing a master another box holds is refused with state `error`, reason
// `shares a connection with <holder's label>`, and nothing run for it: no ensure, cancel or rm.
// A refused box's listener is closed and its `made` dropped, so nothing answers as it and no later
// teardown of it can close the holder's listener on the box. A claimant's ensure also cancels the
// entries other boxes seen on that master may have left there in a previous run (a master that
// outlived a Tmuxifier restart), which would otherwise take its box path's connections. A check
// that gives no pid either way (a timeout, a mux error) runs nothing that sync and reads
// `forward failed`; ssh's own "no master" answer leads to the ensure that brings one up, for
// those boxes after the others, one at a time, holders first, each checked again if an ensure
// ran since: that ensure may have brought up the very master it shares.
//
// Everything that reaches a shell is a constant except the nonce, generated here and re-validated
// immediately before it is interpolated. The box's $HOME is box output: it is accepted only as an
// absolute path of safe characters, and used only as an argv element of `-O forward`/`-O cancel`,
// where sshCommand.js checks the whole path again (at most 101 characters, so a home over 80
// characters is refused there). Remote commands run under the box's login shell, often zsh: every
// expansion is quoted and there is no glob.
//
// Bounded: boxes are handled four at a time, and those that had no master at their check one at
// a time; every ssh call has a timeout (6 s for a control command, 10 s for a remote one), one
// box's failure is its own, and a sync that arrives while one runs is skipped. State is keyed by
// box id; a box whose connection fields (host, user, port, proxyJump) changed is a new machine:
// the old master's forward is cancelled and the new one is ensured, so the old host can never
// keep speaking as this box.

export const ENSURE_REMOTE = 'mkdir -p "$HOME/.tmuxifier-mail" && chmod 700 "$HOME/.tmuxifier-mail" && rm -f "$HOME/.tmuxifier-mail/sock" && printf \'__MAILHOME__ %s\\n\' "$HOME" && if [ -x "$HOME/.tmuxifier-mail/tmx" ]; then echo \'__MAILTOOLS__ yes\'; else echo \'__MAILTOOLS__ no\'; fi';
export const REMOVE_REMOTE = 'rm -f "$HOME/.tmuxifier-mail/sock"';

const NONCE_RE = /^[a-f0-9]{16}$/;
const HOME_RE = /^\/[A-Za-z0-9_./-]{1,80}$/;
const BOX_SOCK = '/.tmuxifier-mail/sock';
const CONTROL_TIMEOUT_MS = 6000;
const REMOTE_TIMEOUT_MS = 10000;
const CONCURRENCY = 4;

// The verify call through the box-side socket, for one nonce.
export function verifyRemote(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new Error('bad nonce');
  return `curl -s -m 3 --unix-socket "$HOME/.tmuxifier-mail/sock" "http://mail/v1/ping?n=${nonce}"`;
}

const sigOf = (box) => JSON.stringify([box.host ?? null, box.user ?? null, box.port ?? null, box.proxyJump ?? null]);

function pidOf(res) {
  const m = /pid=(\d+)/.exec(String(res?.stdout ?? '')) || /pid=(\d+)/.exec(String(res?.stderr ?? ''));
  return m ? m[1] : null;
}

// What one `-O check` says: the master's pid; `none` when ssh reports that no master listens on
// the control socket (nothing there, or a stale socket file); anything else (a timeout, a mux
// error, ssh missing) is `unknown`, which proves nothing either way.
const NO_MASTER_RE = /Control socket connect\([^)\n]*\): (?:No such file or directory|Connection refused)/;
function checkOf(res) {
  const pid = pidOf(res);
  if (pid) return { check: 'pid', pid };
  return { check: NO_MASTER_RE.test(String(res?.stderr ?? '')) ? 'none' : 'unknown', pid: null };
}

// { home, installed } from the ensure command's output: exactly one home line, validated.
function parseEnsure(stdout) {
  const homes = [];
  let installed = null;
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('__MAILHOME__ ')) homes.push(line.slice('__MAILHOME__ '.length));
    else if (line === '__MAILTOOLS__ yes') installed = true;
    else if (line === '__MAILTOOLS__ no') installed = false;
  }
  const h = homes.length === 1 ? homes[0] : null;
  return { home: h !== null && HOME_RE.test(h) && !h.includes('..') ? h : null, installed };
}

export function createAgentMailForward({
  run, policyStore, hub, dataDir, sshOpts,
  makeListener = createAgentMailListener,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  recheckMs = 600000, retryBaseMs = 30000, retryCapMs = 1800000,
}) {
  const entries = new Map(); // box id -> entry
  const mailDir = path.resolve(dataDir, 'mail');
  let running = null;
  let closed = false;
  let ensures = 0; // ensures run by this keeper, so a sync can tell one ran since a point

  // run() is sshRun-shaped and never rejects; a throwing one is a failed command all the same.
  async function call(argv, timeout) {
    try {
      const res = await run(argv, { timeout });
      return res && typeof res === 'object' ? res : { code: 1, stdout: '', stderr: '' };
    } catch (e) {
      return { code: 1, stdout: '', stderr: String(e?.message ?? e) };
    }
  }

  function socketPathOf(boxId) {
    return path.join(mailDir, `${crypto.createHash('sha256').update(boxId).digest('hex').slice(0, 12)}.sock`);
  }

  function newEntry(box) {
    return {
      sig: sigOf(box), socketPath: socketPathOf(box.id), listener: null,
      state: 'down', error: undefined, installed: null,
      pid: null, checkedAt: 0, checkedWall: 0, fails: 0, retryAt: 0,
      made: null, // { cancelArgv, removeArgv } once a forward was attempted on this machine
      refused: false, // another box's forward holds this box's master (see refuse)
      claim: null, // the master pid this box holds for messaging (see syncAll), kept through failures
    };
  }

  async function fail(e, reason) {
    if (e.made) await call(e.made.cancelArgv, CONTROL_TIMEOUT_MS);
    e.state = 'error';
    e.error = reason;
    e.pid = null;
    e.fails += 1;
    e.retryAt = now() + Math.min(retryBaseMs * 2 ** (e.fails - 1), retryCapMs);
    return false;
  }

  function checked(e) {
    e.checkedAt = now();
    e.checkedWall = Date.now(); // the listener's lastRequestAt() is wall-clock
  }

  // The nonce call through the box-side socket; true only if this listener received it.
  async function verify(e, box) {
    const nonce = Buffer.from(randomBytes(8)).toString('hex');
    if (!NONCE_RE.test(nonce)) return false;
    await call(buildProbeArgv(box, verifyRemote(nonce), sshOpts), REMOTE_TIMEOUT_MS);
    return e.listener.sawNonce(nonce);
  }

  // `stale`: the local socket paths of the other boxes seen on this master in this sync. A
  // forward entry a previous process made for one of them can still be on the master, and the
  // master routes the box path to the first entry it holds; it is removed only by a cancel naming
  // that entry's own local path (the master looks the entry up by the whole spec). Sent after the
  // rm and before this box's own forward exists, so there is no holder for it to disturb.
  async function ensure(e, box, stale = []) {
    ensures += 1;
    const res = await call(buildProbeArgv(box, ENSURE_REMOTE, sshOpts), REMOTE_TIMEOUT_MS);
    if (res.code !== 0) return fail(e, 'forward failed');
    const { home, installed } = parseEnsure(res.stdout);
    e.installed = installed;
    if (!home) return fail(e, 'bad home');
    let forwardArgv;
    let cancelArgv;
    try {
      forwardArgv = buildControlForwardArgv(box, home + BOX_SOCK, e.socketPath, sshOpts);
      cancelArgv = buildControlCancelArgv(box, home + BOX_SOCK, e.socketPath, sshOpts);
    } catch {
      // The home passed its own check, so this is its length, or a local path with a colon.
      return fail(e, e.socketPath.includes(':') ? 'forward failed' : 'bad home');
    }
    if (!forwardArgv) return fail(e, 'forward failed');
    e.made = { cancelArgv, removeArgv: buildProbeArgv(box, REMOVE_REMOTE, sshOpts) };
    for (const local of stale) {
      if (local === e.socketPath) continue;
      let argv = null;
      try { argv = buildControlCancelArgv(box, home + BOX_SOCK, local, sshOpts); } catch { /* not ours to fix */ }
      if (argv) await call(argv, CONTROL_TIMEOUT_MS);
    }
    await call(cancelArgv, CONTROL_TIMEOUT_MS); // see the header: a held forward is not reissued
    const fwd = await call(forwardArgv, CONTROL_TIMEOUT_MS);
    if (fwd.code !== 0) return fail(e, 'forward failed');
    if (!(await verify(e, box))) return fail(e, 'not verified');
    return true;
  }

  async function openListener(e, box) {
    const l = makeListener({ hub, boxId: box.id, socketPath: e.socketPath });
    try {
      await l.listen();
    } catch (err) {
      try { await l.close(); } catch { /* never bound */ }
      await fail(e, err?.message === 'socket path too long' ? 'socket path too long' : 'listen failed');
      return false;
    }
    e.listener = l;
    return true;
  }

  // Part one, every box in parallel: everything up to and including the master check. Returns
  // { box, e, pid } for a box that goes on to the claim, or null when this sync is done with it.
  async function prepare(box, snap) {
    let e = entries.get(box.id);
    if (!e) {
      e = newEntry(box);
      entries.set(box.id, e);
    } else if (e.sig !== sigOf(box)) {
      // A new machine under the same id: take the forward off the old one's master.
      if (e.made) await call(e.made.cancelArgv, CONTROL_TIMEOUT_MS);
      Object.assign(e, { sig: sigOf(box), made: null, pid: null, installed: null, fails: 0, retryAt: 0, state: 'down', error: undefined, refused: false, claim: null });
    }
    try {
      if (!snap || snap.reachable !== true) {
        e.state = 'down';
        return null;
      }
      if (e.retryAt && now() < e.retryAt) {
        e.state = 'error';
        return null;
      }
      // A box refused on the last sync gets its listener back only once it holds the master.
      if (!e.listener && !e.refused && !(await openListener(e, box))) return null;
      const checkArgv = buildControlCheckArgv(box, sshOpts);
      if (!checkArgv) { await fail(e, 'forward failed'); return null; }
      return { box, e, checkArgv, ...checkOf(await call(checkArgv, CONTROL_TIMEOUT_MS)) };
    } catch {
      await fail(e, 'forward failed');
      return null;
    }
  }

  // Another box's forward is on this box's master: forwarding for this box too would route its
  // requests to the other box's listener and, through the ensure's rm and a cancel, leave neither
  // working (see the header). Nothing is run: no ensure, no cancel, no rm. Its listener is closed,
  // and `made` dropped so a later teardown or connection change of this box runs no cancel or rm
  // on the shared master: either would close or delete the box path the holder answers on.
  async function refuse(e, holder) {
    if (e.listener) {
      try { await e.listener.close(); } catch { /* already gone */ }
      e.listener = null;
    }
    Object.assign(e, {
      state: 'error', error: `shares a connection with ${holder.label || holder.host || holder.id}`,
      pid: null, made: null, refused: true, fails: 0, retryAt: 0, claim: null,
    });
  }

  // Part two, for a box that holds (or has just claimed) its master: the forward itself.
  async function act({ box, e, checkArgv, pid, stale }) {
    try {
      if (!e.listener) {
        e.refused = false;
        if (!(await openListener(e, box))) return;
      }
      if (pid && pid === e.pid) {
        e.state = 'up';
        if (now() - e.checkedAt < recheckMs) return;
        // A request since the last check came through the forward: nothing to prove.
        if (e.listener.lastRequestAt() > e.checkedWall || (await verify(e, box))) {
          checked(e);
          return;
        }
      }
      if (!(await ensure(e, box, stale))) return;
      // No master at the check: the ensure's remote command brought one up. Record its pid.
      if (!pid) pid = pidOf(await call(checkArgv, CONTROL_TIMEOUT_MS));
      Object.assign(e, { state: 'up', error: undefined, pid, fails: 0, retryAt: 0 });
      checked(e);
    } catch {
      await fail(e, 'forward failed');
    }
  }

  async function teardown(boxId, e) {
    entries.delete(boxId);
    if (e.made) {
      await call(e.made.cancelArgv, CONTROL_TIMEOUT_MS);
      await call(e.made.removeArgv, REMOTE_TIMEOUT_MS);
    }
    if (e.listener) {
      try { await e.listener.close(); } catch { /* already gone */ }
    }
  }

  async function syncAll(boxes, snapshot) {
    if (!Array.isArray(boxes)) return;
    let policies;
    try {
      policies = await policyStore.all();
    } catch {
      return; // no policy, no decision: leave every forward as it is
    }
    const want = new Map(); // in list order: the order decides who gets a shared master first
    for (const b of boxes) {
      if (!b || typeof b.id !== 'string' || want.has(b.id)) continue;
      const policy = policies && Object.hasOwn(policies, b.id) ? policies[b.id] : null;
      if (isEnabled(policy)) want.set(b.id, b);
    }
    const each = (jobs) => mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      try { return await job(); } catch { return null; /* one box's failure is its own */ }
    });

    // Teardowns first, so a forward leaving a master is gone before another box claims it.
    const leaving = [...entries].filter(([id]) => !want.has(id));
    await each(leaving.map(([id, e]) => () => teardown(id, e)));

    const seen = (await each([...want.values()].map((b) => () => {
      const snap = snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, b.id) ? snapshot[b.id] : undefined;
      return prepare(b, snap);
    }))).filter(Boolean);

    // One forward per master pid, held by a claim (`e.claim`). A box keeps its claim through a
    // check that gives no pid (a mux timeout on a busy master, or no master at all), through its
    // own failed ensure and retry hold-off, and while unreachable; it loses it only when turned
    // off or removed (teardown), when its connection fields change, or when its check shows a
    // DIFFERENT pid. Which box answers for a machine never flips on a hiccup. Unclaimed masters
    // go to the boxes that see them in list order; a box seeing a master another box holds is
    // refused.
    const holders = new Map(); // pid -> box
    for (const [id, b] of want) {
      const e = entries.get(id);
      if (!e?.claim) continue;
      const p = seen.find((x) => x.box.id === id);
      if (p?.pid && p.pid !== e.claim) { e.claim = null; continue; } // its master is a new one
      if (!holders.has(e.claim)) holders.set(e.claim, b);
    }
    const holderOf = (pid) => (pid ? holders.get(pid) : undefined);
    const staleFor = (p) => seen.filter((x) => x.pid && x.pid === p.pid && x.box.id !== p.box.id).map((x) => x.e.socketPath);
    const now1 = [];
    const later = []; // no master at the check: handled one at a time, below
    for (const p of seen) {
      if (p.check === 'unknown') {
        // The check said nothing: prove nothing, run nothing. A claim stands (above).
        p.e.state = 'error';
        p.e.error = 'forward failed';
        continue;
      }
      if (!p.pid) { later.push(p); continue; }
      const holder = holderOf(p.pid);
      if (holder && holder.id !== p.box.id) { await refuse(p.e, holder); continue; }
      holders.set(p.pid, p.box);
      p.e.claim = p.pid;
      p.stale = staleFor(p);
      now1.push(p);
    }
    const ensuresBefore = ensures;
    await each(now1.map((p) => () => act(p)));
    // Claim holders first, so a holder whose master went away brings it back as its own before a
    // sibling earlier in the list could take it.
    later.sort((x, y) => Number(!x.e.claim) - Number(!y.e.claim));
    for (const p of later) {
      // An ensure earlier in this sync may have brought up this box's master: look again.
      if (ensures !== ensuresBefore) {
        const again = checkOf(await call(p.checkArgv, CONTROL_TIMEOUT_MS));
        if (again.check === 'unknown') { p.e.state = 'error'; p.e.error = 'forward failed'; continue; }
        p.pid = again.pid;
      }
      const holder = holderOf(p.pid);
      if (holder && holder.id !== p.box.id) { await refuse(p.e, holder); continue; }
      await act(p);
      if (p.e.pid) {
        holders.set(p.e.pid, p.box);
        p.e.claim = p.e.pid;
      }
    }
  }

  return {
    async sync(boxes, snapshot) {
      if (closed || running) return;
      running = syncAll(boxes, snapshot).catch(() => {});
      try {
        await running;
      } finally {
        running = null;
      }
    },
    status(boxId) {
      const e = entries.get(boxId);
      if (!e) return { state: 'off', installed: null, listening: 0 };
      let listening = 0;
      try {
        for (const n of Object.values(hub.listening(boxId) ?? {})) listening += Number(n) || 0;
      } catch { /* the count is advisory */ }
      const out = { state: e.state, installed: e.installed, listening };
      if (e.state === 'error') out.error = e.error;
      return out;
    },
    async stopAll() {
      closed = true;
      if (running) await running;
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map(async (e) => {
        if (e.listener) {
          try { await e.listener.close(); } catch { /* already gone */ }
        }
      }));
    },
  };
}
