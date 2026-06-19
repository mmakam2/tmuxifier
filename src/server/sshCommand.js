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
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box));
  const sess = sanitizeSession(session);
  let remote = `tmux new-session -A -s ${sess}`;
  if (box.startupCommand) remote += ` ${shSingleQuote(box.startupCommand)}`;
  argv.push(remote);
  return argv;
}

export function buildProbeArgv(box, remoteCmd, opts = {}) {
  assertBoxSafe(box);
  const policy = opts.hostKeyPolicy || 'accept-new';
  const argv = [
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${policy}`,
    '-o', 'ConnectTimeout=6',
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box), remoteCmd);
  return argv;
}
