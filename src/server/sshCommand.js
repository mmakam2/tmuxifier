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

export function buildAttachArgv(box, session, size, opts = {}) {
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
