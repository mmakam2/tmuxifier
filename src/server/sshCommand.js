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

function shSingleQuote(s) {
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

export function buildAttachArgv(box, session, size, opts = {}) {
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
    ...controlArgs(opts),
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box), remoteCmd);
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}
