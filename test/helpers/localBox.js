import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sshRun } from '../../src/server/sshRun.js';
import { buildProbeArgv } from '../../src/server/sshCommand.js';

export async function setupLocalBox() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-box-'));
  const sshDir = path.join(tmp, '.ssh');
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(sshDir, 'id_loop');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
  const pub = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();

  const realAk = path.join(os.homedir(), '.ssh', 'authorized_keys');
  await fs.appendFile(realAk, `\n${pub}\n`);

  const user = os.userInfo().username;
  const sshConfigFile = path.join(tmp, 'ssh_config');
  await fs.writeFile(
    sshConfigFile,
    `Host helmlocal\n  HostName 127.0.0.1\n  User ${user}\n  IdentityFile ${keyPath}\n` +
      `  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n`,
    { mode: 0o600 },
  );

  const env = { ...process.env };
  const box = { host: 'helmlocal' };
  const session = `helmtest-${randomUUID().slice(0, 8)}`;

  async function cleanup() {
    try { await sshRun(buildProbeArgv(box, `tmux kill-session -t ${session}`, { sshConfigFile }), { env }); } catch {}
    try {
      const cur = await fs.readFile(realAk, 'utf8');
      const kept = cur.split('\n').filter((l) => l.trim() && l.trim() !== pub);
      await fs.writeFile(realAk, kept.length ? kept.join('\n') + '\n' : '');
    } catch {}
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return { tmp, env, box, session, sshConfigFile, cleanup };
}
