import path from 'node:path';
import fsSync from 'node:fs';
import { execFile } from 'node:child_process';

// Persisted, single-flight server-side APK build: the Settings → Devices
// "Build app" button. Mirrors voiceInstall.js — restart reconciliation,
// step deadline, rolling capped log, verified output — because it is the same
// shape of job: a long local toolchain run whose product enables a feature.
//
// SECURITY: runs Gradle as the service user. Nothing user-supplied reaches
// the command line — the task name is chosen here from which gitignored
// operator files exist (keystore.properties → assembleRelease, else
// assembleDebug), and the argv is constant.
//
// --no-daemon is deliberate: a resident Gradle daemon would hold ~1.5 GB on
// a small host long after the build; a slower cold build with predictable
// memory is the right trade under a live server.
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const APK_NAME = 'tmuxifier-console.apk';

function defaultRun(cmd, args, { cwd, env, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL';
        const detail = timedOut
          ? `timed out after ${Math.round(timeoutMs / 60000)} min`
          : String(stderr || err.message).slice(0, 800);
        reject(new Error(`${path.basename(cmd)} failed: ${detail}`));
        return;
      }
      resolve({ code: 0, stdout: String(stdout || '') + String(stderr || '') });
    });
  });
}

export function createApkBuildManager({
  repoRoot,
  dataDir,
  store,
  run = defaultRun,
  exists = fsSync.existsSync,
  copy = fsSync.copyFileSync,
  mkdir = (p) => fsSync.mkdirSync(p, { recursive: true }),
  maxLogBytes = 64 * 1024,
  now = () => Date.now(),
} = {}) {
  // Same reconciliation + shape filter as voiceInstall.js: a job the process
  // died under can never resume, and one bad history row must not throw at
  // boot.
  const jobs = (store.load() || [])
    .filter((j) => j && typeof j === 'object' && typeof j.id === 'string')
    .map((j) => (j.status === 'running' ? { ...j, status: 'interrupted' } : j));
  store.save(jobs);

  const settled = new Map();
  let seq = 0;
  const android = path.join(repoRoot, 'android');

  const view = (j) => ({
    id: j.id, status: j.status, variant: j.variant, phase: j.phase,
    log: j.log, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt,
  });
  const newestFirst = (a, b) => (b.createdAt - a.createdAt) || (b.id < a.id ? -1 : 1);
  const persist = () => store.save(jobs);
  const append = (j, text) => { if (text) j.log = (j.log + text).slice(-maxLogBytes); };
  const runningJob = () => jobs.find((j) => j.status === 'running') || null;

  async function execute(j) {
    j.phase = 'preflight';
    persist();
    const gradlew = path.join(android, 'gradlew');
    if (!exists(gradlew)) throw new Error('android/gradlew not found — is this checkout complete?');
    if (!exists(path.join(android, 'local.properties')) && !process.env.ANDROID_HOME) {
      throw new Error('no android/local.properties and no ANDROID_HOME — install the SDK per docs/DEPLOY.md');
    }
    // Which build the operator gets is decided by which gitignored files they
    // created, exactly like the Gradle config itself does.
    j.variant = exists(path.join(android, 'keystore.properties')) ? 'release' : 'debug';
    append(j, `preflight ok — building ${j.variant} variant\n`);

    j.phase = 'build';
    persist();
    const task = j.variant === 'release' ? 'assembleRelease' : 'assembleDebug';
    append(j, `+ gradlew ${task} --no-daemon\n`);
    const r = await run(gradlew, ['--no-daemon', '--console=plain', task], { cwd: android });
    // Gradle output is large; keep the tail — the interesting lines
    // (failures, BUILD SUCCESSFUL) are at the end.
    append(j, r.stdout);

    j.phase = 'publish';
    persist();
    const built = path.join(android, 'app', 'build', 'outputs', 'apk', j.variant, `app-${j.variant}.apk`);
    // Verified rather than assumed, same rule as the whisper build: exit 0
    // without the artifact must not read as success.
    if (!exists(built)) throw new Error(`build finished but ${path.basename(built)} is missing`);
    const destDir = path.join(dataDir, 'app');
    mkdir(destDir);
    copy(built, path.join(destDir, APK_NAME));
    append(j, `published ${APK_NAME} (${j.variant})\n`);
  }

  return {
    async start() {
      if (runningJob()) throw new Error('a build is already running');
      const j = {
        id: `ab-${now()}-${++seq}`, status: 'running', variant: null,
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
          j.error = e?.message || 'build failed';
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

    current() {
      const j = runningJob() || [...jobs].sort(newestFirst)[0];
      return j ? view(j) : null;
    },
    // Test seam: resolves with the job's final view once it settles.
    whenSettled(id) {
      const j = jobs.find((x) => x.id === id);
      return settled.get(id) || Promise.resolve(j ? view(j) : null);
    },
  };
}
