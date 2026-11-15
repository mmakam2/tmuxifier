import crypto from 'node:crypto';
import path from 'node:path';
import {
  buildProbeArgv, buildControlCheckArgv, buildControlForwardArgv, buildControlCancelArgv, buildControlPathArgv,
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
//     remote `rm -f` of the box-side file (only when no enabled box shares the connection, below);
//     the listener is closed; state `off` (entry dropped).
//   - switches on, not reachable in the sweep's snapshot: the listener stays, state `down`.
//   - switches on, reachable: listener up, then `-O check` for the master's pid. The same pid the
//     forward was last made on means nothing to do, except a recheck every `recheckMs` when the
//     listener has had no request since the last check: the nonce call alone; on failure, the
//     full ensure.
//   - otherwise the full ensure, below. Success records the pid: state `up`.
//   - `installed` (the Edit Box "Tools ..." line) is whether setup's tools are on the box. It is
//     read from the tools line the ensure and every verify print (so a recheck sees tools
//     installed or removed since), set by `markInstalled(boxId)` when this server's own setup
//     phase installed them, and never reported false while a session of the box is listening.
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
// One forward per ssh connection. Two box entries for one machine whose ssh names resolve to the
// same HostName, port and user share a ControlPath (%C), so one master. Measured (Task 16, real
// sshd): the second box's `-O forward` onto the same box path exits 0 and adds a second entry,
// but the master routes the box's connections to the FIRST entry, so the second never verifies;
// and its failure path (the ensure's rm, then its own cancel, which closes the server's listener
// at the box path) leaves no listener at all. On the master an entry is found by its whole spec,
// box path and local path: `-O cancel` removes only the entry naming that local path. The rule:
// boxes are grouped by their ControlPath, resolved locally with `ssh -G` (cached per connection
// fields). The holder of a group is the FIRST enabled box of it in the list, a pure function of the
// list and the policies, recomputed every sync with no memory, so only the operator's enabling,
// disabling, removing or re-addressing a box changes it; a failed check or ensure, a hold-off, a
// new master, being unreachable or a restart never do. Every other box of the group is refused:
// state `error`, `shares a connection with <holder's label>`, listener closed, and no ssh command
// at all, except once, in the teardown phase before the holder's work, the cancel of a forward
// of its own made before it was refused (by its own spec, never the rm; a forward cancelled
// already on a failure is not cancelled again). The holder runs the single-box logic below, and
// its ensure also cancels, by their full specs, the entries the group's other boxes may have left
// on the master (a master that outlived a restart).
// It fails closed on a ControlPath that does not resolve (a timeout, a spawn error, a failing
// `Match exec`): that box runs nothing at all for mail in the sync, on any machine or master,
// reads `error`, `connection not resolved`, and is asked again on the next sync. Its listener is
// closed in that same sync and it holds no verified forward from then on. The ControlPath is
// cached per connection fields, so a box that has a verified forward can be unresolved only
// because its connection fields changed: that forward is on the machine it no longer names.
// Closing the listener is local and cuts that forward off at once (the old master still holds
// its entry, which now leads nowhere); what cancels that entry is kept, and the cancel goes out
// once, with the old spec, in the teardown phase of the first sync in which the new fields
// resolve. And while any enabled box is unresolved, no forward STARTS: a box without a forward
// verified in this process waits (`error`, nothing run), while one with a verified forward
// carries on with its checks and rechecks. So nothing is forwarded until every enabled box's
// grouping is known, and a box the grouping would refuse can never forward first. A waiting box
// names the unresolved boxes, in list order, by label: `waiting for <label>'s connection to
// resolve`, `waiting for <a> and <b>'s connections to resolve`, `waiting for <a>, <b> and N
// more's connections to resolve`; except that one with a failure of its own since its last
// success (`not verified`, `forward failed`, ...) keeps showing that failure.
// The remote rm of the box-side file, in a teardown, runs only when the leaving box's ControlPath
// is known and no enabled box has it (and every enabled box's ControlPath resolved): the file is
// reachable only through a forward on that master, and no box that could forward there remains.
//
// Everything that reaches a shell is a constant except the nonce, generated here and re-validated
// immediately before it is interpolated. The box's $HOME is box output: it is accepted only as an
// absolute path of safe characters, and used only as an argv element of `-O forward`/`-O cancel`,
// where sshCommand.js checks the whole path again (at most 101 characters, so a home over 80
// characters is refused there). Remote commands run under the box's login shell, often zsh: every
// expansion is quoted and there is no glob.
//
// Bounded: boxes are handled four at a time, every ssh call has a timeout (6 s for a control
// command, 10 s for a remote one), one box's failure is its own, and a sync that arrives while one
// runs is skipped. State is keyed by box id; a box whose connection fields (host, user, port,
// proxyJump) changed is a new machine: the old master's forward is cancelled and the new one is
// ensured, and until the new fields resolve the box's listener is closed (above), so the old
// host can never keep speaking as this box.

// Prints whether setup's tools are on the box, as one line. Part of the ensure and of every verify.
const TOOLS_REMOTE = 'if [ -x "$HOME/.tmuxifier-mail/tmx" ]; then echo \'__MAILTOOLS__ yes\'; else echo \'__MAILTOOLS__ no\'; fi';
export const ENSURE_REMOTE = `mkdir -p "$HOME/.tmuxifier-mail" && chmod 700 "$HOME/.tmuxifier-mail" && rm -f "$HOME/.tmuxifier-mail/sock" && printf '__MAILHOME__ %s\\n' "$HOME" && ${TOOLS_REMOTE}`;
export const REMOVE_REMOTE = 'rm -f "$HOME/.tmuxifier-mail/sock"';

const NONCE_RE = /^[a-f0-9]{16}$/;
const HOME_RE = /^\/[A-Za-z0-9_./-]{1,80}$/;
const BOX_SOCK = '/.tmuxifier-mail/sock';
const CONTROL_TIMEOUT_MS = 6000;
const REMOTE_TIMEOUT_MS = 10000;
const CONCURRENCY = 4;

// The verify call through the box-side socket, for one nonce. It prints the tools line first (so
// it is a line of its own whatever curl prints), which is how a recheck learns that setup has
// installed the tools since the forward came up. Constant but for the nonce.
export function verifyRemote(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new Error('bad nonce');
  return `${TOOLS_REMOTE}; curl -s -m 3 --unix-socket "$HOME/.tmuxifier-mail/sock" "http://mail/v1/ping?n=${nonce}"`;
}

const sigOf = (box) => JSON.stringify([box.host ?? null, box.user ?? null, box.port ?? null, box.proxyJump ?? null]);

// How a status reason names a box. A label is the operator's text: the client renders it as text.
const nameOf = (box) => box.label || box.host || box.id;

// The reason of a box that waits for the unresolved ones, given their names in list order.
function waitingFor(names) {
  if (names.length === 1) return `waiting for ${names[0]}'s connection to resolve`;
  if (names.length === 2) return `waiting for ${names[0]} and ${names[1]}'s connections to resolve`;
  return `waiting for ${names[0]}, ${names[1]} and ${names.length - 2} more's connections to resolve`;
}

function pidOf(res) {
  const m = /pid=(\d+)/.exec(String(res?.stdout ?? '')) || /pid=(\d+)/.exec(String(res?.stderr ?? ''));
  return m ? m[1] : null;
}

// { home, installed } from a remote command's output: exactly one home line, validated, and the
// tools line (null when there is none: the command did not get that far).
function parseRemote(stdout) {
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
  const cps = new Map(); // box id -> { sig, cp }: its resolved ControlPath, per connection fields

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
      // Why nothing was run for this box in the last sync, when that was not its own doing
      // (unresolved, or waiting for an unresolved box); shown in place of `error`, which stays
      // the box's own reason.
      gate: null,
      pid: null, checkedAt: 0, checkedWall: 0, fails: 0, retryAt: 0,
      made: null, // { cancelArgv, removeArgv } once a forward was attempted on this machine
    };
  }

  // Cancels this box's own forward entry once: a later teardown or refusal does not send it again.
  async function cancelOwn(e) {
    if (!e.made || e.made.cancelled) return;
    e.made.cancelled = true;
    await call(e.made.cancelArgv, CONTROL_TIMEOUT_MS);
  }

  async function fail(e, reason) {
    await cancelOwn(e);
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

  // The nonce call through the box-side socket; true only if this listener received it. Its
  // output also says whether the tools are on the box now; without that line nothing is learned.
  async function verify(e, box) {
    const nonce = Buffer.from(randomBytes(8)).toString('hex');
    if (!NONCE_RE.test(nonce)) return false;
    const res = await call(buildProbeArgv(box, verifyRemote(nonce), sshOpts), REMOTE_TIMEOUT_MS);
    const { installed } = parseRemote(res.stdout);
    if (installed !== null) e.installed = installed;
    return e.listener.sawNonce(nonce);
  }

  // `stale`: the local socket paths of the other enabled boxes with this box's ControlPath. A
  // forward entry a previous process made for one of them can still be on the master, and the
  // master routes the box path to the first entry it holds; it is removed only by a cancel naming
  // that entry's own local path (the master looks the entry up by the whole spec). Sent after the
  // rm and before this box's own forward exists, so there is no holder for it to disturb.
  async function ensure(e, box, stale = []) {
    const res = await call(buildProbeArgv(box, ENSURE_REMOTE, sshOpts), REMOTE_TIMEOUT_MS);
    if (res.code !== 0) return fail(e, 'forward failed');
    const { home, installed } = parseRemote(res.stdout);
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

  // The box's ControlPath as `ssh -G` resolves it (local, no connection), cached per connection
  // fields; null when it does not resolve (not cached: asked again next sync).
  async function controlPathOf(box) {
    const sig = sigOf(box);
    const hit = cps.get(box.id);
    if (hit && hit.sig === sig) return hit.cp;
    let argv = null;
    try { argv = buildControlPathArgv(box, sshOpts); } catch { return null; }
    if (!argv) return null;
    const res = await call(argv, CONTROL_TIMEOUT_MS);
    const line = String(res.stdout ?? '').split(/\r?\n/).find((l) => /^controlpath\s/i.test(l));
    const cp = line ? line.replace(/^controlpath\s+/i, '').trim() : '';
    if (res.code !== 0 || !cp || cp.toLowerCase() === 'none') return null;
    cps.set(box.id, { sig, cp });
    return cp;
  }

  // A box that is not its group's holder: nothing answers as it, and nothing is run for it.
  async function refuse(e, holder) {
    if (e.listener) {
      try { await e.listener.close(); } catch { /* already gone */ }
      e.listener = null;
    }
    Object.assign(e, {
      state: 'error', error: `shares a connection with ${nameOf(holder)}`,
      pid: null, made: null, fails: 0, retryAt: 0,
    });
  }

  // The single-box logic, for a box that holds its connection (or has no group).
  async function syncBox(box, e, snap, stale) {
    try {
      if (!snap || snap.reachable !== true) {
        e.state = 'down';
        return;
      }
      if (e.retryAt && now() < e.retryAt) {
        e.state = 'error';
        return;
      }
      if (!e.listener && !(await openListener(e, box))) return;
      const checkArgv = buildControlCheckArgv(box, sshOpts);
      if (!checkArgv) { await fail(e, 'forward failed'); return; }
      let pid = pidOf(await call(checkArgv, CONTROL_TIMEOUT_MS));
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

  // `removeFile`: see the header for when a teardown may remove the box-side file.
  async function teardown(boxId, e, { removeFile }) {
    entries.delete(boxId);
    cps.delete(boxId);
    if (e.made) {
      await cancelOwn(e);
      if (removeFile) await call(e.made.removeArgv, REMOTE_TIMEOUT_MS);
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
    const want = new Map(); // in list order: the first enabled box of a connection holds it
    for (const b of boxes) {
      if (!b || typeof b.id !== 'string' || want.has(b.id)) continue;
      const policy = policies && Object.hasOwn(policies, b.id) ? policies[b.id] : null;
      if (isEnabled(policy)) want.set(b.id, b);
    }
    const wanted = [...want.values()];
    const each = (jobs) => mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      try { await job(); } catch { /* one box's failure is its own */ }
    });

    // Groups and holders. A box whose ControlPath did not resolve belongs to no group and runs
    // nothing; while any enabled box is unresolved, no forward STARTS (see the header).
    const cpOf = new Map();
    await each(wanted.map((b) => async () => { cpOf.set(b.id, await controlPathOf(b)); }));
    const holderOfCp = new Map();
    for (const b of wanted) {
      const cp = cpOf.get(b.id);
      if (cp && !holderOfCp.has(cp)) holderOfCp.set(cp, b);
    }
    const resolved = (b) => Boolean(cpOf.get(b.id));
    const holderOf = (b) => holderOfCp.get(cpOf.get(b.id));
    const allResolved = wanted.every(resolved);

    // Teardown phase, before any holder's work: boxes turned off or removed; a forward of a box's
    // own on a machine it no longer names (connection fields changed); and a forward a box made
    // before it was refused. The last two by their own spec, never the rm. Nothing here is run
    // for an unresolved box: its entry keeps its old `sig` and `made`, so the cancel of a forward
    // on the machine it no longer names goes out in the first sync in which it resolves.
    const jobs = [];
    for (const [id, e] of entries) {
      if (want.has(id)) continue;
      const c = cps.get(id);
      const cp = c && c.sig === e.sig ? c.cp : null;
      jobs.push(() => teardown(id, e, { removeFile: Boolean(cp) && allResolved && !holderOfCp.has(cp) }));
    }
    for (const b of wanted) {
      let e = entries.get(b.id);
      if (!e) {
        entries.set(b.id, newEntry(b));
        continue;
      }
      if (!resolved(b)) continue;
      const moved = e.sig !== sigOf(b);
      if (!moved && !(e.made && holderOf(b).id !== b.id)) continue;
      jobs.push(async () => {
        await cancelOwn(e);
        e.made = null;
        if (moved) Object.assign(e, { sig: sigOf(b), pid: null, installed: null, fails: 0, retryAt: 0, state: 'down', error: undefined });
      });
    }
    await each(jobs);

    const unresolved = wanted.filter((b) => !resolved(b)).map(nameOf);
    const work = [];
    for (const b of wanted) {
      const e = entries.get(b.id);
      e.gate = null;
      if (!resolved(b)) {
        // Fail closed: nothing may be assumed about who else shares this connection, and a
        // forward this box verified is on a machine it no longer names (see the header). Nothing
        // answers as it: the listener is closed, which is local, and the forward counts for
        // nothing from here on.
        if (e.listener) {
          try { await e.listener.close(); } catch { /* already gone */ }
          e.listener = null;
        }
        e.pid = null;
        e.state = 'error';
        e.gate = 'connection not resolved';
        continue;
      }
      const holder = holderOf(b);
      if (holder.id !== b.id) {
        await refuse(e, holder);
        continue;
      }
      if (!allResolved && e.pid === null) {
        // Would start a forward: it waits until every enabled box is grouped. A failure of its
        // own since its last success stays the reason shown.
        e.state = 'error';
        if (e.fails === 0) e.gate = waitingFor(unresolved);
        continue;
      }
      const cp = cpOf.get(b.id);
      const stale = wanted.filter((x) => x.id !== b.id && cpOf.get(x.id) === cp).map((x) => entries.get(x.id).socketPath);
      const snap = snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, b.id) ? snapshot[b.id] : undefined;
      work.push(() => syncBox(b, e, snap, stale));
    }
    await each(work);
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
      // A listening session is a running `tmx hook-wait`: the tools are on the box, whatever
      // the last ensure or recheck read. Kept, so the line does not flip back between two waits
      // of a session; the next read of the tools line replaces it.
      if (listening > 0 && e.installed === false) e.installed = true;
      const out = { state: e.state, installed: e.installed, listening };
      if (e.state === 'error') out.error = e.gate ?? e.error;
      return out;
    },
    // Setup's `agent-mail` phase installed the tools on this box (index.js calls this on its
    // `ok: true`): no ssh call, and nothing for a box the keeper holds no entry for.
    markInstalled(boxId) {
      const e = entries.get(boxId);
      if (e) e.installed = true;
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
