import { execFile } from 'node:child_process';

export function sshRun(argv, { env = process.env, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    execFile('ssh', argv, { env, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}
