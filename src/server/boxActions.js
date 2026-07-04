import { unlink } from 'node:fs/promises';
import {
  buildProbeArgv,
  buildControlExitArgv,
  buildControlCheckArgv,
  buildControlPathArgv,
  sanitizeSession,
  shSingleQuote,
} from './sshCommand.js';

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
    // Always clamp mouse to off — the last setting in .tmux.conf.local wins.
    'if [ -f .tmux.conf.local ]; then',
    "  sed -i 's/^set -g mouse on/set -g mouse off/' .tmux.conf.local",
    'fi',
  ] : [];
  const ohMyZsh = options.installOhMyZsh ? [
    'ZSH_BIN="$(command -v zsh || true)"',
    'if [ -z "$ZSH_BIN" ]; then',
    '  for p in /usr/bin/zsh /usr/local/bin/zsh /bin/zsh; do if [ -x "$p" ]; then ZSH_BIN="$p"; break; fi; done',
    'fi',
    'if [ -z "$ZSH_BIN" ]; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
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
    'sed -i \'s/^ZSH_THEME=.*/ZSH_THEME="blinks"/\' .zshrc 2>/dev/null || true',
    'ZSH_BIN="$(command -v zsh || true)"',
    'if [ -n "$ZSH_BIN" ]; then',
    "  if [ \"$(id -u)\" = '0' ]; then",
    '    chsh -s "$ZSH_BIN" root || true',
    '  else',
    '    sudo -n chsh -s "$ZSH_BIN" "$(whoami)" 2>/dev/null || chsh -s "$ZSH_BIN" "$(whoami)" || true',
    '  fi',
    'fi',
    // Persist the shell into oh-my-tmux's local conf, but only when that conf
    // exists — without oh-my-tmux nothing sources it, so appending would just
    // litter a stray file. Delete-then-append keeps exactly one line (a
    // '#…#d' sed script is a COMMENT: the old form deleted nothing, so every
    // ensure run appended another line).
    'if [ -f .tmux.conf.local ]; then sed -i \'/^set-option -g default-shell/d\' .tmux.conf.local 2>/dev/null || true; echo "set-option -g default-shell \"$ZSH_BIN\"" >> .tmux.conf.local; fi',
  ] : [];
  const ohMyBash = options.installOhMyBash ? [
    'BASH_BIN="$(command -v bash || true)"',
    'if [ ! -d .oh-my-bash ]; then',
    '  if command -v curl >/dev/null 2>&1; then',
    '    OMB="$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
'    "$BASH_BIN" -c "$OMB" </dev/null',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    OMB="$(wget -O- https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
    '    "$BASH_BIN" -c "$OMB" </dev/null',
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
    // Same guarded delete-then-append as the omz branch above.
    'if [ -f .tmux.conf.local ]; then sed -i \'/^set-option -g default-shell/d\' .tmux.conf.local 2>/dev/null || true; echo "set-option -g default-shell \"$BASH_BIN\"" >> .tmux.conf.local; fi',
  ] : [];
  return [
    'set -eu',
    // Ensure git is available before oh-my-tmux / oh-my-zsh
    'if ! command -v git >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
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
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
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

export function createBoxActions({ run, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist }) {
  async function runRemote(box, remote, timeout) {
    const argv = buildProbeArgv(box, remote, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
    return run(argv, { timeout });
  }

  // Ask ssh to expand %C for us (`ssh -G` resolves config without connecting),
  // yielding the concrete control-socket path for the box.
  async function resolveControlPath(box) {
    const argv = buildControlPathArgv(box, { sshConfigFile, controlDir });
    if (!argv) return null;
    const res = await run(argv, { timeout: 6000 });
    const line = String((res && res.stdout) || '')
      .split(/\r?\n/)
      .find((l) => /^controlpath\s/i.test(l));
    if (!line) return null;
    const p = line.replace(/^controlpath\s+/i, '').trim();
    return p && p.toLowerCase() !== 'none' ? p : null;
  }

  // Delete the box's control socket file. Returns true only when a file was
  // actually removed (ENOENT/perms => false, nothing to recover).
  async function removeStaleSocket(box) {
    let p;
    try { p = await resolveControlPath(box); } catch { return false; }
    if (!p) return false;
    try { await unlink(p); return true; } catch { return false; }
  }

  return {
    async killSession(box) {
      try {
        await runRemote(box, buildKillTmuxRemote(box.sessionName), 12000);
      } catch {
        // Best effort: removing a box should not be blocked by a stale or unreachable host.
      }
      return { ok: true };
    },
    // Run a one-shot, non-interactive command on the box over the existing
    // BatchMode ssh path and capture {code, stdout, stderr}. `command` is the
    // remote shell command and is passed verbatim (runRemote -> buildProbeArgv
    // appends it as the final argv element). assertBoxSafe (inside buildProbeArgv)
    // still validates the connection fields.
    async execCommand(box, command, { timeoutMs = 15000 } = {}) {
      return runRemote(box, command, timeoutMs);
    },
    async exitMaster(box) {
      try {
        const argv = buildControlExitArgv(box, { sshConfigFile, controlDir });
        if (!argv) return { ok: true }; // multiplexing disabled — nothing to tear down
        await run(argv, { timeout: 6000 });
      } catch {
        // Best effort: a missing or already-dead master must not block reconnect.
      }
      // `-O exit` only reaches a *live* master. If it had died uncleanly its
      // orphan socket lingers and disables multiplexing on the next connect,
      // leaving the box stuck red. Force-remove the resolved socket so a fresh
      // interactive login re-establishes a clean master.
      await removeStaleSocket(box);
      return { ok: true };
    },
    // Reap an orphaned control socket without disturbing a healthy master.
    // Used by the periodic status check: when a probe shows multiplexing was
    // disabled by a leftover socket, this confirms no master is listening and
    // removes the stale file so the box self-heals on the next connect.
    async reapStaleMaster(box) {
      let checkArgv;
      try {
        checkArgv = buildControlCheckArgv(box, { sshConfigFile, controlDir });
      } catch {
        return { ok: true, reaped: false }; // unsafe box — never happens for stored boxes
      }
      if (!checkArgv) return { ok: true, reaped: false }; // multiplexing disabled
      try {
        const res = await run(checkArgv, { timeout: 6000 });
        // Exit 0 => a live master is listening. Leave it alone: tearing down a
        // healthy master would force a needless re-auth on the next probe.
        if (res && res.code === 0) return { ok: true, reaped: false };
      } catch {
        // `-O check` itself failed — treat as "no live master" and clean up.
      }
      const reaped = await removeStaleSocket(box);
      return { ok: true, reaped };
    },
    // Is a live ControlMaster listening for this box? A socket-only `-O check`
    // (no network, no auth, no PTY) — so it's safe to call while an interactive
    // session is connecting. A live master means the box is authenticated and
    // connected; no master means it still needs a login.
    async isMasterAlive(box) {
      let checkArgv;
      try {
        checkArgv = buildControlCheckArgv(box, { sshConfigFile, controlDir });
      } catch {
        return false; // unsafe box
      }
      if (!checkArgv) return false; // multiplexing disabled
      try {
        const res = await run(checkArgv, { timeout: 6000 });
        return !!(res && res.code === 0);
      } catch {
        return false;
      }
    },
  };
}
