import path from 'node:path';

// SSH connection multiplexing. When a control directory is configured, every
// probe and terminal for a given box shares one persistent master connection
// instead of opening a fresh TCP+auth handshake each time. ControlPath uses the
// %C token (a hash of user/host/port) so the probe and the live terminal land
// on the same socket, and the master is authenticated once — so repeated probes
// no longer count against the box's sshd MaxStartups limit.
function controlArgs(opts = {}) {
  if (!opts.controlPath && !opts.controlDir) return [];
  const controlPath = opts.controlPath || path.join(opts.controlDir, '%C');
  const persist = opts.controlPersist != null ? String(opts.controlPersist) : '60';
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlPersist=${persist}`,
  ];
}

export function sanitizeSession(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9_-]/g, '-');
  return cleaned.length ? cleaned : 'web';
}

export function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function target(box) {
  return box.user ? `${box.user}@${box.host}` : box.host;
}

const SAFE_HOST = /^[A-Za-z0-9_.-]+$/;
const SAFE_USER = /^[A-Za-z0-9_.-]+$/;
const SAFE_JUMP = /^[A-Za-z0-9_.@:,-]+$/;

function assertSafe(label, value, re) {
  const s = String(value);
  if (!s || s[0] === '-' || !re.test(s)) {
    throw new Error(`unsafe ssh ${label}: ${JSON.stringify(value)}`);
  }
}

export function assertBoxSafe(box) {
  assertSafe('host', box.host, SAFE_HOST);
  if (box.user != null && box.user !== '') assertSafe('user', box.user, SAFE_USER);
  if (box.proxyJump != null && box.proxyJump !== '') assertSafe('proxyJump', box.proxyJump, SAFE_JUMP);
  if (box.port != null && box.port !== '') {
    const p = Number(box.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`unsafe ssh port: ${JSON.stringify(box.port)}`);
    }
  }
}

export function buildAttachArgv(box, session, opts = {}) {
  assertBoxSafe(box);
  const policy = opts.hostKeyPolicy || 'accept-new';
  const argv = [
    '-tt',
    '-o', `StrictHostKeyChecking=${policy}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...controlArgs(opts),
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box));
  const sess = sanitizeSession(session);
  let remote = `tmux new-session -A -D -s ${sess}`;
  if (box.startupCommand) remote += ` ${shSingleQuote(box.startupCommand)}`;
  argv.push(remote);
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}

export function buildProbeArgv(box, remoteCmd, opts = {}) {
  assertBoxSafe(box);
  const policy = opts.hostKeyPolicy || 'accept-new';
  const argv = [
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${policy}`,
    '-o', 'ConnectTimeout=6',
    // Keepalive so a master *established by a probe* (key-auth boxes can do this
    // since BatchMode needs no password) detects a dead peer and exits instead
    // of wedging forever on a network blackhole, which would leave a stale
    // socket that disables multiplexing on every later connect.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...controlArgs(opts),
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box), remoteCmd);
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}

// Send a control command (`exit`, `check`, …) to a box's persistent
// ControlMaster. This talks to the local control socket only — no network auth,
// no PTY — so it is safe to run regardless of the box's auth method.
function buildControlCmdArgv(box, cmd, opts = {}) {
  assertBoxSafe(box);
  if (!opts.controlPath && !opts.controlDir) return null;
  const controlPath = opts.controlPath || path.join(opts.controlDir, '%C');
  const argv = ['-o', `ControlPath=${controlPath}`];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push('-O', cmd, target(box));
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}

// Cleanly shut down the persistent ControlMaster for a box: tells the master to
// exit, which also removes its socket file. Doing this on reconnect is what lets
// a password-auth box re-establish a fresh master on the next interactive login.
// NOTE: `-O exit` only works on a *live, responsive* master. A master that died
// uncleanly leaves an orphan socket that `-O exit` cannot remove — callers must
// also force-remove the resolved socket path (see buildControlPathArgv).
export function buildControlExitArgv(box, opts = {}) {
  return buildControlCmdArgv(box, 'exit', opts);
}

// Ask whether a live master is listening on the box's control socket. Exits 0
// ("Master running") when one exists; non-zero when the socket is absent or
// orphaned. Lets the reaper distinguish a healthy master from a stale socket
// file so it never tears down a working connection.
export function buildControlCheckArgv(box, opts = {}) {
  return buildControlCmdArgv(box, 'check', opts);
}

// Resolve the concrete ControlPath for a box by letting ssh expand the %C token
// itself (`ssh -G` prints the effective config without connecting). The %C hash
// covers user/host/port/jump, so we pass those to get the exact socket path —
// which we then unlink to clear an orphaned master that `-O exit` can't reach.
export function buildControlPathArgv(box, opts = {}) {
  assertBoxSafe(box);
  if (!opts.controlPath && !opts.controlDir) return null;
  const argv = ['-G', ...controlArgs(opts)];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box));
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}

export function buildProvisionArgv(box, script, opts = {}) {
  assertBoxSafe(box);
  const policy = opts.hostKeyPolicy || 'accept-new';
  const argv = [
    '-tt',
    '-o', `StrictHostKeyChecking=${policy}`,
    '-o', 'ConnectTimeout=6',
    ...controlArgs(opts),
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box), script);
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}
