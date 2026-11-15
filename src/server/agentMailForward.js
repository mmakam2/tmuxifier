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
// ensured, so the old host can never keep speaking as this box.

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

  async function ensure(e, box) {
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
    await call(cancelArgv, CONTROL_TIMEOUT_MS); // see the header: a held forward is not reissued
    const fwd = await call(forwardArgv, CONTROL_TIMEOUT_MS);
    if (fwd.code !== 0) return fail(e, 'forward failed');
    if (!(await verify(e, box))) return fail(e, 'not verified');
    return true;
  }

  async function syncBox(box, snap) {
    let e = entries.get(box.id);
    if (!e) {
      e = newEntry(box);
      entries.set(box.id, e);
    } else if (e.sig !== sigOf(box)) {
      // A new machine under the same id: take the forward off the old one's master.
      if (e.made) await call(e.made.cancelArgv, CONTROL_TIMEOUT_MS);
      Object.assign(e, { sig: sigOf(box), made: null, pid: null, installed: null, fails: 0, retryAt: 0, state: 'down', error: undefined });
    }
    try {
      if (!snap || snap.reachable !== true) {
        e.state = 'down';
        return;
      }
      if (e.retryAt && now() < e.retryAt) {
        e.state = 'error';
        return;
      }
      if (!e.listener) {
        const l = makeListener({ hub, boxId: box.id, socketPath: e.socketPath });
        try {
          await l.listen();
        } catch (err) {
          try { await l.close(); } catch { /* never bound */ }
          await fail(e, err?.message === 'socket path too long' ? 'socket path too long' : 'listen failed');
          return;
        }
        e.listener = l;
      }
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
      if (!(await ensure(e, box))) return;
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
    const want = new Map();
    for (const b of boxes) {
      if (!b || typeof b.id !== 'string') continue;
      const policy = policies && Object.hasOwn(policies, b.id) ? policies[b.id] : null;
      if (isEnabled(policy)) want.set(b.id, b);
    }
    const jobs = [];
    for (const [id, e] of entries) if (!want.has(id)) jobs.push(() => teardown(id, e));
    for (const [id, b] of want) {
      const snap = snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, id) ? snapshot[id] : undefined;
      jobs.push(() => syncBox(b, snap));
    }
    await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      try { await job(); } catch { /* one box's failure is its own */ }
    });
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
