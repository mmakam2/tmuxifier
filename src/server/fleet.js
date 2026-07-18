import { randomUUID } from 'node:crypto';
import { mapWithConcurrency } from './concurrency.js';

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

export function createFleetManager({
  store,
  execCommand,
  load = () => [],
  save = () => {},
  now = () => new Date().toISOString(),
  newId = () => randomUUID(),
  concurrency = 4,
  timeoutMs = 15000,
  maxJobs = 50,
  maxOutputBytes = 65536,
  // Mid-login guard, same pair the status checker is injected (see status.js):
  // a box with a live interactive session whose ControlMaster is not up yet is
  // sitting at a login prompt — a BatchMode exec over the shared %C socket
  // would collide with it (worst case, the user's password lands in a shell).
  hasLiveSession = null,
  masterAlive = null,
}) {
  // Drop malformed persisted entries (hand-edited file, interrupted legacy
  // write) instead of letting reconciliation/summarize throw — one bad history
  // row must never keep the server from booting. Dropped rows are excised from
  // the file by the save below.
  const validJob = (j) => j && typeof j === 'object'
    && typeof j.id === 'string' && typeof j.command === 'string'
    && Array.isArray(j.targets) && j.targets.every((t) => t && typeof t === 'object');
  const loaded = load();
  const rawJobs = Array.isArray(loaded) ? loaded : [];
  const jobs = rawJobs.filter(validJob); // oldest first; newest pushed to the end
  let reconciled = jobs.length !== rawJobs.length;
  // A job persisted as 'running' means a previous process died mid-run; its ssh
  // children are gone, so mark it (and its unfinished targets) interrupted.
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    reconciled = true;
    for (const t of job.targets) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'interrupted';
        t.error = t.error || 'interrupted by restart';
        t.finishedAt = now();
      }
    }
    job.status = 'interrupted';
    job.finishedAt = now();
  }
  if (reconciled) save(jobs);
  const runs = new Map();                            // jobId -> in-flight run promise (test affordance)
  const cancelled = new Set(); // jobIds with a pending cancel request (in-memory only)

  function prune() {
    // Cap history without ever dropping an active job: a running job that
    // left the list would keep executing invisibly and become uncancellable
    // (same retention rule as the setup manager).
    let idx = 0;
    while (jobs.length > maxJobs && idx < jobs.length) {
      if (jobs[idx].status === 'running') { idx += 1; continue; }
      const [shifted] = jobs.splice(idx, 1);
      runs.delete(shifted.id);
      cancelled.delete(shifted.id);
    }
  }

  function summarize(job) {
    let okCount = 0; let errorCount = 0;
    for (const t of job.targets) {
      if (t.status === 'ok') okCount++;
      else if (t.status === 'error' || t.status === 'interrupted') errorCount++;
    }
    return {
      id: job.id, command: job.command, status: job.status,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      targetCount: job.targets.length, okCount, errorCount,
    };
  }

  function finalize(job) {
    for (const t of job.targets) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'error';
        t.error = t.error || 'did not run';
        t.finishedAt = now();
      }
    }
    job.status = cancelled.has(job.id) ? 'cancelled' : 'done';
    job.finishedAt = now();
    save(jobs);
  }

  async function runJob(job, boxById) {
    // Yield one macrotask so createJob can return the job object before any
    // target statuses are mutated — tests and callers see 'pending' on the
    // returned job, not 'running'.
    await new Promise((r) => setTimeout(r, 0));
    try {
      await mapWithConcurrency(job.targets, concurrency, async (t) => {
        if (t.status === 'cancelled') return; // already cancelled by a completed sibling
        const box = boxById.get(t.boxId);
        // Skip a mid-login box (live session, master not established) instead of
        // racing the interactive prompt. Once auth completes the master is up
        // and an exec multiplexes over it without disturbing the terminal.
        if (hasLiveSession && hasLiveSession(box)) {
          const alive = masterAlive ? await masterAlive(box) : false;
          if (!alive) {
            t.status = 'skipped';
            t.error = 'skipped: box in use (interactive login in progress)';
            t.finishedAt = now();
            save(jobs);
            return;
          }
        }
        t.status = 'running';
        t.startedAt = now();
        try {
          const res = await execCommand(box, job.command, { timeoutMs });
          const out = clip(res && res.stdout, maxOutputBytes);
          const err = clip(res && res.stderr, maxOutputBytes);
          t.stdout = out.text;
          t.stderr = err.text;
          t.truncated = out.truncated || err.truncated;
          t.code = res && typeof res.code === 'number' ? res.code : null;
          t.status = t.code === 0 ? 'ok' : 'error';
          if (t.status === 'error' && !t.error) t.error = `exited ${t.code}`;
        } catch (e) {
          t.status = 'error';
          t.code = null;
          t.error = (e && e.message) || 'exec failed';
        }
        t.finishedAt = now();
        save(jobs);
        if (cancelled.has(job.id)) {
          for (const pending of job.targets) {
            if (pending.status === 'pending') {
              pending.status = 'cancelled';
              pending.finishedAt = now();
            }
          }
          save(jobs);
        }
      });
    } catch {
      // Unexpected runner failure — finalize below so a job never dangles 'running'.
    }
    finalize(job);
  }

  return {
    async createJob({ boxIds, command }) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      if (!Array.isArray(boxIds) || boxIds.length === 0) throw new Error('select at least one box');
      const boxById = new Map();
      for (const id of boxIds) {
        const box = await store.getBox(id);
        if (!box) throw new Error(`unknown box: ${id}`);
        boxById.set(id, box);
      }
      const ts = now();
      const job = {
        id: newId(),
        command,
        status: 'running',
        createdAt: ts,
        startedAt: ts,
        finishedAt: null,
        concurrency,
        timeoutMs,
        targets: boxIds.map((id) => {
          const b = boxById.get(id);
          return {
            boxId: id, label: b.label || b.host, host: b.host,
            status: 'pending', code: null, stdout: '', stderr: '', truncated: false,
            error: null, startedAt: null, finishedAt: null,
          };
        }),
      };
      jobs.push(job);
      prune();
      save(jobs);
      const p = runJob(job, boxById).catch(() => {});
      runs.set(job.id, p);
      return job;
    },
    getJob(id) {
      return jobs.find((j) => j.id === id);
    },
    cancelJob(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      if (job.status === 'running') cancelled.add(id);
      return job;
    },
    listJobs() {
      return [...jobs].reverse().map(summarize);
    },
    async _settled(id) {
      await runs.get(id);
    },
  };
}
