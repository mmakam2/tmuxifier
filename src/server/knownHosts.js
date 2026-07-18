import { execFile } from 'node:child_process';

// Local `ssh-keygen -R` runner. argv array, never a shell string — hosts are
// already allowlist-validated (assertBoxSafe), but no shell means no
// interpolation surface at all. Resolves {code,stdout,stderr}, never rejects
// (same contract as runLocalShellScript in localShellActions.js).
function runSshKeygen(args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('ssh-keygen', args, { timeout, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

export function createKnownHosts({ run = runSshKeygen } = {}) {
  return {
    // Remove the known_hosts entry for this box's exact identity: the bare
    // host for port 22, or ONLY the bracketed [host]:port form for a
    // nonstandard port. The bare entry belongs to whatever answers port 22 at
    // that address — behind NAT/port-forwards that can be a different machine,
    // and its key must not be touched. Best-effort by contract: a key may
    // legitimately be removed
    // only when Tmuxifier destroyed the machine, just created it at this
    // address, or the user explicitly asked — callers treat failure like the
    // entry not existing. Operates on the service user's default
    // ~/.ssh/known_hosts (ssh-keygen -R handles hashed entries); a custom
    // UserKnownHostsFile in TMUXIFIER_SSH_CONFIG is out of scope (see spec).
    async forget(host, port) {
      const p = Number(port);
      const targets = p && p !== 22 ? [`[${host}]:${p}`] : [String(host)];
      const results = [];
      for (const target of targets) {
        try {
          results.push(await run(['-R', target]));
        } catch (e) {
          results.push({ code: 1, stdout: '', stderr: String((e && e.message) || e) });
        }
      }
      return results;
    },
  };
}
