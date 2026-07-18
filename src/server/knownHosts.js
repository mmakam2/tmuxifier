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
    // Remove known_hosts entries for host (and its [host]:port form when a
    // nonstandard port is used — known_hosts stores nonstandard-port entries
    // bracketed). Best-effort by contract: a key may legitimately be removed
    // only when Tmuxifier destroyed the machine, just created it at this
    // address, or the user explicitly asked — callers treat failure like the
    // entry not existing. Operates on the service user's default
    // ~/.ssh/known_hosts (ssh-keygen -R handles hashed entries); a custom
    // UserKnownHostsFile in TMUXIFIER_SSH_CONFIG is out of scope (see spec).
    async forget(host, port) {
      const targets = [String(host)];
      const p = Number(port);
      if (p && p !== 22) targets.push(`[${host}]:${p}`);
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
