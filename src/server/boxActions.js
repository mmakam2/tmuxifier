import { buildProbeArgv, sanitizeSession, shSingleQuote } from './sshCommand.js';

export function buildEnsureTmuxRemote(session, startupCommand, options = {}) {
  const sess = shSingleQuote(sanitizeSession(session));
  const startup = startupCommand ? ` ${shSingleQuote(startupCommand)}` : '';
  const ohMyTmux = options.installOhMyTmux ? [
    'cd',
    'if [ ! -f .tmux/.tmux.conf ]; then',
    '  rm -rf .tmux',
    '  git clone --single-branch https://github.com/gpakosz/.tmux.git .tmux',
    '  ln -s -f .tmux/.tmux.conf .tmux.conf',
    '  cp .tmux/.tmux.conf.local .tmux.conf.local',
    'fi',
  ] : [];
  const ohMyZsh = options.installOhMyZsh ? [
    'ZSH_BIN="$(command -v zsh || true)"',
    'if [ -z "$ZSH_BIN" ]; then',
    '  for p in /usr/bin/zsh /usr/local/bin/zsh /bin/zsh; do if [ -x "$p" ]; then ZSH_BIN="$p"; break; fi; done',
    'fi',
    'if [ -z "$ZSH_BIN" ]; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y zsh || {',
    '      $SUDO apt-get update || true',
    '      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y zsh',
    '    }',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    $SUDO dnf install -y zsh',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    $SUDO yum install -y zsh',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm zsh',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add zsh',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install zsh',
    '  else',
    "    echo 'zsh is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'if [ ! -d .oh-my-zsh ]; then',
    '  if command -v curl >/dev/null 2>&1; then',
    '    OHMYZSH="$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" || { echo "Failed to download Oh My Zsh" >&2; exit 1; }',
    '    RUNZSH=no CHSH=yes sh -c "$OHMYZSH"',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    OHMYZSH="$(wget -O- https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" || { echo "Failed to download Oh My Zsh" >&2; exit 1; }',
    '    RUNZSH=no CHSH=yes sh -c "$OHMYZSH"',
    '  else',
    "    echo 'Oh My Zsh install requires curl or wget' >&2",
    '    exit 127',
    '  fi',
    'fi',
  ] : [];
  return [
    'set -eu',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    'if [ -z "$TMUX_BIN" ]; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux || {',
    '      $SUDO apt-get update || true',
    '      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux',
    '    }',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    $SUDO dnf install -y tmux',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    $SUDO yum install -y tmux',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm tmux',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add tmux',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install tmux',
    '  else',
    "    echo 'tmux is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
    ...ohMyTmux,
    ...ohMyZsh,
    `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
  ].join('\n');
}

export function buildKillTmuxRemote(session) {
  const sess = shSingleQuote(sanitizeSession(session));
  return `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${sess} 2>/dev/null || true; fi`;
}

export function createBoxActions({ run, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir }) {
  async function runRemote(box, remote, timeout) {
    const argv = buildProbeArgv(box, remote, { hostKeyPolicy, sshConfigFile, controlDir });
    return run(argv, { timeout });
  }

  return {
    async ensureReady(box, options = {}) {
      const res = await runRemote(box, buildEnsureTmuxRemote(box.sessionName, box.startupCommand, options), 120000);
      if (res.code !== 0) {
        const msg = String(res.stderr || res.stdout || '').trim() || 'could not install tmux or create session';
        throw new Error(msg);
      }
      return { ok: true };
    },
    async killSession(box) {
      try {
        await runRemote(box, buildKillTmuxRemote(box.sessionName), 12000);
      } catch {
        // Best effort: removing a box should not be blocked by a stale or unreachable host.
      }
      return { ok: true };
    },
  };
}
