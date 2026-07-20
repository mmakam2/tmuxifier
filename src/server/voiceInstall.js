import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { resolveModel, WHISPER_REPO, WHISPER_REF } from './voiceCatalog.js';
import { VENDOR_DIR, vendorBinPath, vendorModelPath } from './voicePaths.js';
import { downloadVerified } from './voiceDownload.js';

// Persisted, single-flight install job: apt -> clone -> build -> download ->
// verify -> enable. Mirrors setupManager.js so the UI can poll it the same way
// box setup is polled.
//
// SECURITY: this runs apt-get, a git clone, a compiler and a large download as
// whatever user the service runs as (root, in the documented deployment). Every
// value below is a hardcoded constant or comes from voiceCatalog's allowlist.
// The caller supplies only a model ID, validated before anything executes.
const APT_PACKAGE = 'cmake';
const BUILD_OVERHEAD_BYTES = 700 * 1024 * 1024; // source + build output, on top of the model

function defaultRun(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 400)}`)); return; }
      resolve({ code: 0, stdout: String(stdout || '') + String(stderr || '') });
    });
  });
}

const defaultFreeBytes = async (dir) => {
  const st = fsSync.statfsSync(dir);
  return st.bavail * st.bsize;
};

export function createVoiceInstallManager({
  repoRoot,
  store,
  voiceStore,
  run = defaultRun,
  download = downloadVerified,
  freeBytes = defaultFreeBytes,
  totalMem = () => os.totalmem(),
  maxLogBytes = 64 * 1024,
  now = () => Date.now(),
} = {}) {
  // Restart reconciliation: a job the process was running when it died can
  // never resume, so it must not sit as 'running' forever blocking new
  // installs. Same treatment setupManager gives its own jobs.
  const jobs = (store.load() || []).map((j) => (j.status === 'running' ? { ...j, status: 'interrupted' } : j));
  store.save(jobs);

  const settled = new Map();
  let seq = 0;

  const view = (j) => ({
    id: j.id, model: j.model, status: j.status, phase: j.phase,
    log: j.log, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt,
  });
  const newestFirst = (a, b) => (b.createdAt - a.createdAt) || (b.id < a.id ? -1 : 1);
  const persist = () => store.save(jobs);
  const append = (j, text) => { if (text) j.log = (j.log + text).slice(-maxLogBytes); };

  function runningJob() {
    return jobs.find((j) => j.status === 'running') || null;
  }

  async function execute(j) {
    const vendor = path.join(repoRoot, VENDOR_DIR);
    const entry = resolveModel(j.model);

    j.phase = 'preflight';
    persist();
    // Fail early with a real number rather than dying mid-build with a
    // confusing compiler error.
    const need = entry.bytes + BUILD_OVERHEAD_BYTES;
    const free = await freeBytes(repoRoot);
    if (free < need) {
      const gb = (n) => (n / 1024 ** 3).toFixed(1);
      throw new Error(`not enough disk: need ~${gb(need)} GB, ${gb(free)} GB free`);
    }
    append(j, `preflight ok: need ~${(need / 1024 ** 3).toFixed(1)} GB, have ${(free / 1024 ** 3).toFixed(1)} GB\n`);

    j.phase = 'cmake';
    persist();
    let haveCmake = true;
    try { await run('cmake', ['--version']); } catch { haveCmake = false; }
    if (!haveCmake) {
      append(j, `+ apt-get install -y ${APT_PACKAGE}\n`);
      const r = await run('apt-get', ['install', '-y', APT_PACKAGE], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      });
      append(j, r.stdout);
    } else {
      append(j, 'cmake already present\n');
    }

    j.phase = 'clone';
    persist();
    if (fsSync.existsSync(path.join(vendor, '.git'))) {
      append(j, `+ git fetch/checkout ${WHISPER_REF}\n`);
      append(j, (await run('git', ['-C', vendor, 'fetch', '--depth', '1', 'origin', 'tag', WHISPER_REF])).stdout);
      append(j, (await run('git', ['-C', vendor, 'checkout', WHISPER_REF])).stdout);
    } else {
      fsSync.mkdirSync(path.dirname(vendor), { recursive: true });
      append(j, `+ git clone ${WHISPER_REPO} @ ${WHISPER_REF}\n`);
      append(j, (await run('git', ['clone', '--depth', '1', '--branch', WHISPER_REF, WHISPER_REPO, vendor])).stdout);
    }

    j.phase = 'build';
    persist();
    // whisper.cpp translation units peak around 1 GB each, so parallelism is
    // capped by RAM as well as cores — -j4 OOMs a 4 GB container mid-build.
    const ramGb = totalMem() / 1024 ** 3;
    const jobsN = Math.max(1, Math.min(os.cpus().length || 1, 4, ramGb < 6 ? 2 : 4));
    append(j, `+ cmake --build -j ${jobsN}\n`);
    append(j, (await run('cmake', ['-B', path.join(vendor, 'build'), '-S', vendor, '-DCMAKE_BUILD_TYPE=Release'])).stdout);
    append(j, (await run('cmake', ['--build', path.join(vendor, 'build'), '--config', 'Release',
      '-j', String(jobsN), '--target', 'whisper-server'])).stdout);
    // Verified rather than assumed: a build can exit 0 and still not produce
    // the target, and reporting success then would strand the operator with a
    // feature that 503s.
    if (!fsSync.existsSync(vendorBinPath(repoRoot))) throw new Error('build finished but whisper-server is missing');

    j.phase = 'model';
    persist();
    const dest = vendorModelPath(repoRoot, entry.file);
    if (fsSync.existsSync(dest)) {
      append(j, `${entry.file} already present\n`);
    } else {
      append(j, `+ download ${entry.file} (${(entry.bytes / 1024 ** 2).toFixed(0)} MB)\n`);
      fsSync.mkdirSync(path.dirname(dest), { recursive: true });
      await download({ url: entry.url, dest, sha256: entry.sha256 });
      append(j, 'integrity check passed\n');
    }

    j.phase = 'enable';
    persist();
    await voiceStore.update({ enabled: true, model: j.model });
    append(j, 'voice enabled\n');
  }

  return {
    async start(modelId) {
      // Validated BEFORE anything executes: nothing user-supplied may reach
      // apt, git, the compiler, or a fetch.
      const entry = resolveModel(modelId);
      if (!entry) throw new Error(`unknown model: ${String(modelId)}`);
      if (runningJob()) throw new Error('an install is already running');

      const j = {
        id: `vi-${now()}-${++seq}`, model: entry.id, status: 'running',
        phase: 'preflight', log: '', error: null, createdAt: now(), finishedAt: null,
      };
      jobs.push(j);
      persist();

      const p = (async () => {
        try {
          await execute(j);
          j.status = 'done';
        } catch (e) {
          j.status = 'error';
          j.error = e?.message || 'install failed';
          append(j, `\nERROR: ${j.error}\n`);
        } finally {
          j.phase = null;
          j.finishedAt = now();
          persist();
        }
        return view(j);
      })();
      settled.set(j.id, p);
      return view(j);
    },

    getJob(id) {
      const j = jobs.find((x) => x.id === id);
      return j ? view(j) : null;
    },
    current() {
      const j = runningJob() || [...jobs].sort(newestFirst)[0];
      return j ? view(j) : null;
    },
    listJobs() {
      return [...jobs].sort(newestFirst).map(view);
    },
    // Test seam: resolves with the job's final view once it settles.
    whenSettled(id) {
      return settled.get(id) || Promise.resolve(this.getJob(id));
    },
  };
}
