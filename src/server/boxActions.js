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
    '    $SUDO apt-get update || true',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zsh',
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
    '    RUNZSH=no sh -c "$OHMYZSH" </dev/null',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    OHMYZSH="$(wget -O- https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" || { echo "Failed to download Oh My Zsh" >&2; exit 1; }',
    '    RUNZSH=no sh -c "$OHMYZSH" </dev/null',
    '  else',
    "    echo 'Oh My Zsh install requires curl or wget' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'ZSH_BIN="$(command -v zsh || true)"',
    'if [ -n "$ZSH_BIN" ]; then',
    "  if [ \"$(id -u)\" = '0' ]; then",
    '    chsh -s "$ZSH_BIN" root || true',
    '  else',
    '    sudo -n chsh -s "$ZSH_BIN" "$(whoami)" 2>/dev/null || chsh -s "$ZSH_BIN" "$(whoami)" || true',
    '  fi',
    'fi',
  ] : [];
  const ohMyBash = options.installOhMyBash ? [
    'BASH_BIN="$(command -v bash || true)"',
    'if [ ! -d .oh-my-bash ]; then',
    '  if command -v curl >/dev/null 2>&1; then',
    '    OMB="$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
    '    sh -c "$OMB" </dev/null',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    OMB="$(wget -O- https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
    '    sh -c "$OMB" </dev/null',
    '  else',
    "    echo 'Oh My Bash install requires curl or wget' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'BASH_BIN="$(command -v bash || true)"',
    'if [ -n "$BASH_BIN" ]; then',
    "  if [ \"$(id -u)\" = '0' ]; then",
    '    chsh -s "$BASH_BIN" root || true',
    '  else',
    '    sudo -n chsh -s "$BASH_BIN" "$(whoami)" 2>/dev/null || chsh -s "$BASH_BIN" "$(whoami)" || true',
    '  fi',
    'fi',
  ] : [];
  return [
    'set -eu',
    // Ensure git is available before oh-my-tmux / oh-my-zsh
    'if ! command -v git >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO apt-get update || true',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    $SUDO dnf install -y git',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    $SUDO yum install -y git',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm git',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add git',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install git',
    '  else',
    "    echo 'git is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    'if [ -z "$TMUX_BIN" ]; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux || {',
    '      $SUDO apt-get update || true',
    '      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux',
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
    ...ohMyBash,
    `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
    `[ -n "\${ZSH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$ZSH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$ZSH_BIN" 2>/dev/null || true; } || true`,
    `[ -n "\${BASH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$BASH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$BASH_BIN" 2>/dev/null || true; } || true`,
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
