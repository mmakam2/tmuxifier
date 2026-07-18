import { execFile, spawn } from 'node:child_process';

export function sshRun(argv, { env = process.env, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    execFile('ssh', argv, { env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

// One-shot ssh with the given bytes piped to stdin (used to land uploads on a
// box via `cat > file` over the shared ControlMaster). execFile can't stream
// stdin, hence spawn. Output capture is capped like execFile's maxBuffer so a
// chatty remote can't balloon memory; a timeout SIGKILLs and resolves 124
// (shell timeout convention). `cmd` is test-only injection (/bin/sh).
const MAX_CAPTURE = 1024 * 1024;

export function sshRunStdin(argv, input, { env = process.env, timeout = 60000, cmd = 'ssh' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(124);
    }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    // A child that exits before consuming stdin (auth failure, bad remote
    // command) EPIPEs the write; without this handler that throws uncaught.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Streaming ssh: spawn a non-interactive ssh (or `cmd` in tests) and forward
// stdout/stderr chunks to onData as they arrive, instead of buffering to
// completion like sshRun. Used by the setup-job manager to stream a long
// install script into a persisted log. stdin is closed (BatchMode never
// prompts). Returns a handle: `done` resolves { code } on `close`, which
// fires only after stdio streams are closed — i.e. after all `data` events
// have been delivered to onData, and always after `exit` — so the persisted
// log is never missing a trailing chunk. A timeout SIGKILLs and resolves 124
// (shell timeout convention) directly, without waiting for `close`; `kill()`
// force-stops and resolves 137 the same way, since an explicit abort (cancel
// / box removed) doesn't need trailing-data completeness.
export function sshStream(argv, { env = process.env, timeout = 600000, onData, cmd = 'ssh' } = {}) {
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  let resolveDone;
  const donePromise = new Promise((r) => { resolveDone = r; });
  const finish = (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolveDone({ code });
  };
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(124); }, timeout);
  child.stdout.on('data', (d) => { if (onData) onData(d.toString(), 'stdout'); });
  child.stderr.on('data', (d) => { if (onData) onData(d.toString(), 'stderr'); });
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  return { done: donePromise, kill: () => { try { child.kill('SIGKILL'); } catch {} finish(137); } };
}
