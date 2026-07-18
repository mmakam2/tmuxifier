import { randomUUID } from 'node:crypto';
import { buildEnsureTmuxRemote } from './boxActions.js';

// Statuses that will not resume on their own. `needs-interactive` is stable
// across restarts (a paused, user-actionable state — no live process), so it is
// NOT reconciled. Only `running` (a live ssh child that died with the process)
// is converted to `interrupted` on load.
const SUDO_PW_RE = /a terminal is required to read the password|sudo:[^\n]*password is required|askpass/i;

export function createSetupManager({
  sshStream,
  buildSetupArgv,
  buildScript = (box, options) => buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
    installOhMyTmux: !!options.ohMyTmux,
    installOhMyZsh: !!options.ohMyZsh,
    installOhMyBash: !!options.ohMyBash,
    tools: options.tools || [],
  }),
  probe = async () => true,
  load, save,
  hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist,
  now = () => new Date().toISOString(),
  makeId = randomUUID,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxJobs = 50, maxLogBytes = 65536, taskTimeoutMs = 600000,
  readyAttempts = 10, readyDelayMs = 3000,
}) {
  const jobs = new Map();
  const runningHandles = new Map(); // jobId -> ssh handle
  const settles = new Map();        // jobId -> run promise (test seam)

  for (const j of load() || []) {
    if (j.status === 'running') { j.status = 'interrupted'; j.phase = null; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
  }
  persist();

  function ordered() { return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
  function persist() { save(ordered().slice(0, maxJobs)); prune(); }
  function prune() {
    const keep = new Set(ordered().slice(0, maxJobs).map((j) => j.id));
    for (const id of [...jobs.keys()]) if (!keep.has(id)) jobs.delete(id);
  }
  function summary(j) {
    return { id: j.id, boxId: j.boxId, boxLabel: j.boxLabel, status: j.status, phase: j.phase, options: j.options, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt };
  }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }
  function normalizeOptions(o = {}) {
    return { ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash, tools: Array.isArray(o.tools) ? o.tools : [] };
  }
  function currentForBox(boxId) { return ordered().find((j) => j.boxId === boxId) || null; }

  function finish(j, status) {
    j.status = status;
    j.phase = null;
    if (status !== 'needs-interactive') j.finishedAt = now();
    persist();
  }

  async function run(j, box, { waitForSsh }) {
    try {
      if (waitForSsh) {
        j.phase = 'waiting-ssh'; persist();
        let ready = false;
        for (let i = 0; i < readyAttempts && !ready; i++) {
          try { ready = await probe(box); } catch { ready = false; }
          if (!ready) await sleep(readyDelayMs);
        }
        // Proceed regardless — the script run is the definitive attempt.
      }
      j.phase = 'running'; persist();

      const script = buildScript(box, j.options);
      const argv = buildSetupArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      let sawSudoPw = false;
      const handle = sshStream(argv, {
        timeout: taskTimeoutMs,
        onData: (chunk, stream) => {
          appendLog(j, chunk);
          if (stream === 'stderr' && !sawSudoPw && SUDO_PW_RE.test(j.log)) sawSudoPw = true;
          persist();
        },
      });
      runningHandles.set(j.id, handle);
      const { code } = await handle.done;
      runningHandles.delete(j.id);

      if (code === 0) finish(j, 'done');
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
    if (code === 0) { j.status = 'done'; j.finishedAt = now(); persist(); }
    // non-zero: cancelled or still-failing — stays needs-interactive (retryable).
  }

  function cancelForBox(boxId) {
    const j = currentForBox(boxId);
    if (j && runningHandles.has(j.id)) { try { runningHandles.get(j.id).kill(); } catch {} }
  }

  return {
    start, markInteractiveResult, cancelForBox, currentForBox,
    getJob(id) { return jobs.get(id); },
    listJobs() { return ordered().map(summary); },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
