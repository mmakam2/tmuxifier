import { randomUUID } from 'node:crypto';
import { buildEnsureTmuxRemote } from './boxActions.js';
import { newestFirst } from './jobOrder.js';

// Statuses that will not resume on their own. `needs-interactive` is stable
// across restarts (a paused, user-actionable state — no live process), so it is
// NOT reconciled. Only `running` (a live ssh child that died with the process)
// is converted to `interrupted` on load.
const SUDO_PW_RE = /a terminal is required to read the password|sudo:[^\n]*password is required|askpass/i;

// Statuses that will never change again on their own — used by prune() to
// decide what is safe to evict from the in-memory jobs map. 'superseded' is a
// stale needs-interactive job replaced by a newer run for the same box.
const TERMINAL = new Set(['done', 'error', 'interrupted', 'superseded']);

export function createSetupManager({
  sshStream,
  buildSetupArgv,
  buildScript = (box, options) => buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
    installOhMyTmux: !!options.ohMyTmux,
    installOhMyZsh: !!options.ohMyZsh,
    installOhMyBash: !!options.ohMyBash,
    tools: options.tools || [],
    // The session is created by the ensureSession step instead, after seeding.
    createSession: false,
  }),
  probe = async () => true,
  // Post-setup AI-auth seeding. Both default to null: an unwired manager skips
  // the step entirely, which is also what every existing test constructs.
  seed = null,
  getBox = null,
  // Pre-creates the box's tmux session, as the last step of a successful job.
  // It must run after `seed`: a session's shell reads its rc files once, at
  // creation, so one created earlier holds an environment with no seeded token
  // in it.
  ensureSession = null,
  load, save,
  hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  makeId = randomUUID,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxJobs = 50, maxLogBytes = 65536, taskTimeoutMs = 600000,
  readyAttempts = 10, readyDelayMs = 3000,
  logPersistMs = 250, logPersistBytes = 8192,
}) {
  const jobs = new Map();
  const runningHandles = new Map(); // jobId -> ssh handle
  const settles = new Map();        // jobId -> run promise (test seam)

  for (const j of load() || []) {
    // One bad history row must never keep the server from booting (the store
    // only validates "is an array") — same guard as the fleet manager's load.
    if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
    if (j.status === 'running') { j.status = 'interrupted'; j.phase = null; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
  }
  persist();

  function ordered() { return [...jobs.values()].sort(newestFirst); }
  // Retention policy shared by prune() and persist() so the in-memory map and the
  // persisted file never diverge: every non-terminal job (running or
  // needs-interactive — still in flight or awaiting the user) is always kept, and
  // the newest maxJobs TERMINAL jobs are kept as history. maxJobs caps history
  // only; active jobs are never dropped (losing a running job would make its
  // outcome unobservable and its ssh child uncancellable).
  function retainedIds() {
    const all = ordered();
    const keep = new Set();
    for (const j of all) if (!TERMINAL.has(j.status)) keep.add(j.id);
    let terminalKept = 0;
    for (const j of all) {
      if (TERMINAL.has(j.status) && terminalKept < maxJobs) { keep.add(j.id); terminalKept += 1; }
    }
    return keep;
  }
  function prune() {
    const keep = retainedIds();
    for (const id of [...jobs.keys()]) if (!keep.has(id)) jobs.delete(id);
  }
  function persist() { prune(); save(ordered()); }
  function summary(j) {
    return { id: j.id, boxId: j.boxId, boxLabel: j.boxLabel, status: j.status, phase: j.phase, options: j.options, error: j.error, seed: j.seed ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt };
  }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }
  function normalizeOptions(o = {}) {
    return {
      ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash,
      tools: Array.isArray(o.tools) ? o.tools : [],
      seedAiAuth: !!o.seedAiAuth,
    };
  }
  function currentForBox(boxId) { return ordered().find((j) => j.boxId === boxId) || null; }

  function finish(j, status) {
    j.status = status;
    j.phase = null;
    if (status !== 'needs-interactive') j.finishedAt = now();
    persist();
    settles.delete(j.id);
  }

  // The one place a job becomes 'done'. Seeding runs here rather than in the
  // browser so closing the tab can't silently skip it (the whole point of this
  // step), and it runs BEFORE the status flip because setupPoller stops polling
  // the moment it reads a terminal status.
  //
  // A seed failure is recorded, never promoted: setup itself succeeded, and a
  // missing host credential must not turn a good box red. j.cancelled means the
  // box is on its way out (usually removal), so seeding it is pointless.
  async function completeDone(j, box) {
    if (seed && j.options.seedAiAuth && box && !j.cancelled) {
      j.phase = 'seeding';
      persist();
      try {
        j.seed = await seed(box);
      } catch {
        // Never echo the rejection: it could carry secret-adjacent material,
        // and 'all' means the step died before per-target results existed.
        j.seed = [{ target: 'all', ok: false, error: 'seed failed' }];
      }
    }
    // Strictly after the seed, so the session's first shell reads rc files that
    // already carry the token. Failure is swallowed: attaching creates the
    // session anyway (`new-session -A`), so this costs a convenience, not the
    // box.
    if (ensureSession && box && !j.cancelled) {
      try { await ensureSession(box, j.options); } catch { /* attach will create it */ }
    }
    finish(j, 'done');
  }

  async function run(j, box, { waitForSsh }) {
    try {
      if (waitForSsh) {
        j.phase = 'waiting-ssh'; persist();
        let ready = false;
        for (let i = 0; i < readyAttempts && !ready && !j.cancelled; i++) {
          try { ready = await probe(box); } catch { ready = false; }
          if (!ready && !j.cancelled) await sleep(readyDelayMs);
        }
        // Proceed regardless — the script run is the definitive attempt.
      }
      // A cancel that arrived during the wait (e.g. the box was deleted) must
      // stop here — before this phase the ssh handle doesn't exist yet, so the
      // kill in cancelForBox had nothing to reach.
      if (j.cancelled) { j.error = 'setup cancelled'; finish(j, 'error'); return; }
      j.phase = 'running'; persist();

      const script = buildScript(box, j.options);
      const argv = buildSetupArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      let sawSudoPw = false;
      let stderrTail = '';
      // Coalesced log persistence: a chatty install emits thousands of chunks,
      // and a full-history save per chunk is a multi-MB stringify each time.
      // Status/phase transitions still persist immediately; finish() flushes
      // the tail.
      let lastLogPersist = nowMs();
      let pendingLogBytes = 0;
      const handle = sshStream(argv, {
        timeout: taskTimeoutMs,
        onData: (chunk, stream) => {
          appendLog(j, chunk);
          if (stream === 'stderr') {
            // Bounded stderr-only accumulator so a phrase split across chunks is
            // still detected, without matching sudo text that appeared on stdout.
            stderrTail = (stderrTail + chunk).slice(-4096);
            if (!sawSudoPw && SUDO_PW_RE.test(stderrTail)) sawSudoPw = true;
          }
          pendingLogBytes += chunk.length;
          const t = nowMs();
          if (t - lastLogPersist >= logPersistMs || pendingLogBytes >= logPersistBytes) {
            lastLogPersist = t;
            pendingLogBytes = 0;
            persist();
          }
        },
      });
      runningHandles.set(j.id, handle);
      const { code } = await handle.done;
      runningHandles.delete(j.id);

      if (code === 0) await completeDone(j, box);
      else if (sawSudoPw) finish(j, 'needs-interactive');
      else if (code === 124) { j.error = 'setup timed out'; finish(j, 'error'); }
      else { j.error = `setup exited ${code}`; finish(j, 'error'); }
    } catch (e) {
      runningHandles.delete(j.id);
      j.error = e?.message || 'setup error';
      finish(j, 'error');
    }
  }

  function start(box, options, { waitForSsh = false } = {}) {
    const existing = currentForBox(box.id);
    if (existing && existing.status === 'running') return summary(existing);
    // A stale parked job (needs-interactive) is replaced by this run: flip it
    // to terminal 'superseded' so it stops accumulating — retention keeps
    // every non-terminal job forever, and markInteractiveResult only ever
    // resolves the newest job per box, so a parked one would otherwise be
    // unresolvable and retained unboundedly (64KB log each).
    for (const old of jobs.values()) {
      if (old.boxId === box.id && old.status !== 'running' && !TERMINAL.has(old.status)) {
        old.status = 'superseded';
        old.finishedAt = old.finishedAt || now();
      }
    }
    const j = {
      id: makeId(), boxId: box.id, boxLabel: box.label,
      status: 'running', phase: waitForSsh ? 'waiting-ssh' : 'running',
      options: normalizeOptions(options), log: '', error: null,
      createdAt: now(), finishedAt: null,
    };
    jobs.set(j.id, j);
    persist();
    const p = run(j, box, { waitForSsh });
    settles.set(j.id, p);
    return summary(j);
  }

  function markInteractiveResult(boxId, code) {
    const j = currentForBox(boxId);
    if (!j || j.status !== 'needs-interactive') return;
    // non-zero: cancelled or still-failing — stays needs-interactive (retryable).
    if (code !== 0) return;
    // Flip SYNCHRONOUSLY, before the first await below. The guard above is the
    // only thing stopping a second PTY exit event from re-entering, and without
    // this the status would stay 'needs-interactive' for the whole seed round
    // trip — long enough to seed the same box twice.
    j.status = 'running';
    j.phase = 'running';
    persist();
    const p = (async () => {
      let box = null;
      // A deleted box (or a store that errors) must not strand the job: seeding
      // is skipped, the job still reaches done.
      try { box = getBox ? await getBox(boxId) : null; } catch { box = null; }
      await completeDone(j, box);
    })();
    settles.set(j.id, p);
  }

  function cancelForBox(boxId) {
    const j = currentForBox(boxId);
    if (!j) return;
    // The flag covers the waiting-ssh window, where no ssh handle exists yet
    // for the kill below to reach; run() checks it before spawning.
    j.cancelled = true;
    if (runningHandles.has(j.id)) { try { runningHandles.get(j.id).kill(); } catch {} }
  }

  return {
    start, markInteractiveResult, cancelForBox, currentForBox,
    getJob(id) { return jobs.get(id); },
    listJobs() { return ordered().map(summary); },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
