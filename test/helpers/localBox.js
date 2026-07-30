import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sshRun } from '../../src/server/sshRun.js';
import { buildProbeArgv } from '../../src/server/sshCommand.js';

// A throwaway "box" for the integration and e2e suites: a dedicated sshd, on an
// ephemeral port, that logs the current user into a FIXTURE home directory.
//
// It used to be the developer's own account over the system sshd, which coupled
// the suites to real machine state in three ways, all of which bit:
//
//  1. Interactive rc files. The suite asserts a live shell prompt appears, so
//     when this host's ~/.zshrc started blocking on `[oh-my-zsh] Would you like
//     to update? [Y/n]`, nine tests began timing out — a red suite caused by a
//     config file changing its mind, with nothing to do with the code.
//  2. ~/.ssh/authorized_keys. The old helper appended the test key to the real
//     file and rewrote it on cleanup: a security-critical file mutated by a test
//     run, reformatted (blank lines dropped) on the way out, with keys left
//     behind whenever cleanup didn't run and concurrent runs able to delete each
//     other's entries.
//  3. The account itself. These suites run the real setup script, which is
//     entitled to install packages and run `chsh`. That is how a stray PATH in
//     the unit harness once pointed root's login shell at a fake zsh inside a
//     temp directory and broke every login on the machine.
//
// SetEnv is what makes the isolation work, and it applies to the exec channel
// (`ssh host 'cmd'`) as well as interactive logins, which is all Tmuxifier uses.
// TMUX_TMPDIR is part of it: without a private socket directory, `tmux
// new-session` would attach to the operator's already-running tmux server and
// inherit ITS environment — the real HOME — defeating the point. It also keeps
// test sessions out of the operator's `tmux ls`.
//
// Same uid, so no useradd and no privileged fixture user: sshd only ever
// authenticates the account already running the tests.

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForListening(port, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`test sshd did not listen on ${port} within ${deadlineMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const SSHD_CANDIDATES = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/sbin/sshd'];

async function findSshd() {
  for (const candidate of SSHD_CANDIDATES) {
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  // Deliberately fatal rather than falling back to the system sshd: a silent
  // fallback would quietly restore the real-home coupling this helper exists to
  // remove, and the suite would look fine until an rc file broke it again.
  throw new Error(`no sshd binary found (looked in ${SSHD_CANDIDATES.join(', ')}); the integration and e2e suites need one to build an isolated box`);
}

export async function setupLocalBox() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-box-'));
  const home = path.join(tmp, 'home');
  const binDir = path.join(home, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  // A deterministic prompt, and no framework. The suites assert a prompt
  // character appears; leaving that to whatever the operator's rc files do is
  // exactly the coupling being removed.
  await fs.writeFile(path.join(home, '.zshrc'), "PROMPT='e2e %# '\n");
  await fs.writeFile(path.join(home, '.bashrc'), "PS1='e2e \\$ '\n");
  await fs.writeFile(path.join(home, '.profile'), '');

  // Inert `chsh`/`sudo` on the box's PATH. HOME isolation does not cover
  // /etc/passwd: chsh edits the account, not the home directory, so a future
  // test that ticks a shell-framework checkbox could still repoint the
  // operator's login shell. Same guard the unit harness carries.
  for (const stub of ['chsh', 'sudo']) {
    await fs.writeFile(path.join(binDir, stub), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const sshDir = path.join(tmp, '.ssh');
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(sshDir, 'id_loop');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);

  const hostKey = path.join(tmp, 'host_ed25519');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', hostKey, '-q']);

  // The test key is trusted by THIS sshd only — the real ~/.ssh/authorized_keys
  // is never read or written.
  const authorizedKeys = path.join(tmp, 'authorized_keys');
  await fs.copyFile(`${keyPath}.pub`, authorizedKeys);
  await fs.chmod(authorizedKeys, 0o600);

  const user = os.userInfo().username;
  const port = await freePort();
  const sshdBin = await findSshd();
  const sshdConfig = path.join(tmp, 'sshd_config');
  await fs.writeFile(sshdConfig, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    `PidFile ${path.join(tmp, 'sshd.pid')}`,
    // No PAM: it is the operator's system policy (motd, session limits,
    // password aging) and none of it belongs in a test fixture.
    'UsePAM no',
    'PermitRootLogin yes',
    // The fixture lives under /tmp with ownership sshd would otherwise reject.
    'StrictModes no',
    'PrintMotd no',
    'X11Forwarding no',
    // The isolation itself.
    `SetEnv HOME=${home} ZDOTDIR=${home} TMUX_TMPDIR=${tmp} PATH=${binDir}:/usr/local/bin:/usr/bin:/bin`,
    '',
  ].join('\n'), { mode: 0o600 });

  const sshdLog = path.join(tmp, 'sshd.log');
  const sshd = spawn(sshdBin, ['-D', '-f', sshdConfig, '-E', sshdLog], { stdio: 'ignore' });
  let sshdExit = null;
  sshd.on('exit', (code) => { sshdExit = code; });
  try {
    await waitForListening(port);
  } catch (e) {
    let log = '';
    try { log = await fs.readFile(sshdLog, 'utf8'); } catch { /* no log */ }
    throw new Error(`${e.message}${sshdExit != null ? ` (sshd exited ${sshdExit})` : ''}\n${log}`.trim());
  }

  const sshConfigFile = path.join(tmp, 'ssh_config');
  await fs.writeFile(
    sshConfigFile,
    `Host tmuxifierlocal\n  HostName 127.0.0.1\n  Port ${port}\n  User ${user}\n  IdentityFile ${keyPath}\n` +
      `  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n`,
    { mode: 0o600 },
  );

  const env = { ...process.env };
  const box = { host: 'tmuxifierlocal' };
  const session = `tmuxifiertest-${randomUUID().slice(0, 8)}`;

  async function cleanup() {
    // Kill the session first: it runs against the fixture's own tmux server, so
    // this is best-effort tidiness rather than a requirement — killing sshd and
    // removing TMUX_TMPDIR takes the server with it either way.
    try { await sshRun(buildProbeArgv(box, `tmux kill-session -t ${session}`, { sshConfigFile }), { env }); } catch {}
    try { sshd.kill('SIGTERM'); } catch {}
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return { tmp, home, port, env, box, session, sshConfigFile, cleanup };
}
