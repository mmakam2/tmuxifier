import { unlink } from 'node:fs/promises';
import {
  buildProbeArgv,
  buildControlExitArgv,
  buildControlCheckArgv,
  buildControlPathArgv,
  sanitizeSession,
  shSingleQuote,
  SESSION_NAME_RE,
  WINDOW_ID_RE,
} from './sshCommand.js';
import { storedUploadName, buildUploadRemote } from './uploads.js';
import {
  injectVia,
  injectTextVia,
  buildPaneSnapshotRemote,
  parsePaneSnapshot,
  buildSendNamedKeyRemote,
  buildSendKeysRemote,
  buildSendWheelRemote,
} from './tmuxInject.js';

// Curated provision-time tools. Ids are the ONLY strings that ever reach the
// generated shell script — resolveTools throws on anything not in the catalog,
// which is what keeps the tools= query param out of command-injection territory.
export const TOOL_IDS = ['upgrade', 'curl', 'git', 'gh', 'node', 'bubblewrap', 'codex', 'claude', 'agy'];

// gh fetches GitHub's apt keyring with curl; codex is an npm global;
// claude/agy are curl installers.
const TOOL_IMPLIES = { gh: ['curl'], codex: ['node'], claude: ['curl'], agy: ['curl'] };

export function resolveTools(ids) {
  if (ids == null || ids === '') return [];
  const list = typeof ids === 'string' ? ids.split(',').filter(Boolean) : ids;
  if (!Array.isArray(list)) throw new Error('tools must be an array or comma-separated string');
  const want = new Set();
  for (const id of list) {
    if (!TOOL_IDS.includes(id)) throw new Error(`unknown tool: ${id}`);
    want.add(id);
    for (const dep of TOOL_IMPLIES[id] || []) want.add(dep);
  }
  return TOOL_IDS.filter((id) => want.has(id));
}

// Multi-package-manager install, mirroring the git/tmux bootstrap blocks below.
// guard: binary checked with `command -v`; pkgs: per-manager package name(s).
function installPackagesBlock(guard, pkgs, label) {
  return [
    `if ! command -v ${guard} >/dev/null 2>&1; then`,
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO apt-get update || true',
    `    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs.apt}`,
    '  elif command -v dnf >/dev/null 2>&1; then',
    `    $SUDO dnf install -y ${pkgs.dnf}`,
    '  elif command -v yum >/dev/null 2>&1; then',
    `    $SUDO yum install -y ${pkgs.yum}`,
    '  elif command -v pacman >/dev/null 2>&1; then',
    `    $SUDO pacman -Sy --noconfirm ${pkgs.pacman}`,
    '  elif command -v apk >/dev/null 2>&1; then',
    `    $SUDO apk add ${pkgs.apk}`,
    '  elif command -v zypper >/dev/null 2>&1; then',
    `    $SUDO zypper --non-interactive install ${pkgs.zypper}`,
    '  else',
    `    echo '${label} is not installed and no supported package manager was found' >&2`,
    '    exit 127',
    '  fi',
    'fi',
  ];
}

function samePkg(name) {
  return { apt: name, dnf: name, yum: name, pacman: name, apk: name, zypper: name };
}

const TOOLS = {
  upgrade: () => [
    "SUDO=''",
    "if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    'if command -v apt-get >/dev/null 2>&1; then',
    '  $SUDO apt-get update',
    '  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  $SUDO dnf -y upgrade',
    'elif command -v yum >/dev/null 2>&1; then',
    '  $SUDO yum -y update',
    'elif command -v pacman >/dev/null 2>&1; then',
    '  $SUDO pacman -Syu --noconfirm',
    'elif command -v apk >/dev/null 2>&1; then',
    '  $SUDO apk upgrade --update-cache',
    'elif command -v zypper >/dev/null 2>&1; then',
    '  $SUDO zypper --non-interactive update',
    'else',
    "  echo 'no supported package manager was found for system upgrade' >&2",
    '  exit 127',
    'fi',
  ],
  curl: () => installPackagesBlock('curl', samePkg('curl'), 'curl'),
  git: () => installPackagesBlock('git', samePkg('git'), 'git'),
  gh: () => [
    'if ! command -v gh >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    // Debian/Ubuntu archives don't carry gh — use GitHub's official apt repo.
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO mkdir -p -m 755 /etc/apt/keyrings',
    // Fetch to a temp file FIRST: piping `curl … | tee` would write an EMPTY
    // keyring on curl failure (tee exits 0) while the sources list still lands,
    // poisoning every later apt-get update. A failed `curl -o` aborts under
    // `set -e` before anything under /etc is mutated. `install -m 0644` sets the
    // final mode, so no separate chmod is needed.
    '    t="$(mktemp)"',
    '    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$t"',
    '    $SUDO install -D -m 0644 "$t" /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    '    rm -f "$t"',
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
    '    $SUDO apt-get update',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh',
    // RHEL/CentOS carry no gh — add GitHub's rpm repo. Writing the .repo file
    // directly (same temp-file-first shape as the apt keyring above) sidesteps
    // the dnf4/dnf5 `config-manager` syntax divergence; dnf -y imports the
    // repo's GPG key on install.
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    t="$(mktemp)"',
    '    curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o "$t"',
    '    $SUDO install -D -m 0644 "$t" /etc/yum.repos.d/gh-cli.repo',
    '    rm -f "$t"',
    '    $SUDO dnf install -y gh',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    t="$(mktemp)"',
    '    curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o "$t"',
    '    $SUDO install -D -m 0644 "$t" /etc/yum.repos.d/gh-cli.repo',
    '    rm -f "$t"',
    '    $SUDO yum install -y gh',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm github-cli',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add github-cli',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install gh',
    '  else',
    "    echo 'gh is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
  ],
  node: () => installPackagesBlock('npm', samePkg('nodejs npm'), 'npm'),
  bubblewrap: () => installPackagesBlock('bwrap', samePkg('bubblewrap'), 'bubblewrap'),
  codex: () => [
    'if ! command -v codex >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  $SUDO npm install -g @openai/codex',
    'fi',
  ],
  // Download-then-execute, NOT `curl | bash`: under `set -eu` without pipefail a
  // curl network failure makes the pipeline exit 0 (bash on empty stdin exits 0),
  // so provisioning would report success with the tool absent. pipefail can't be
  // assumed (the remote may run dash). A separate `curl -o` is a plain command
  // `set -e` catches, so a fetch failure aborts loudly.
  claude: () => [
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  t="$(mktemp)"',
    '  curl -fsSL https://claude.ai/install.sh -o "$t"',
    '  bash "$t"',
    '  rm -f "$t"',
    'fi',
  ],
  agy: () => [
    'if ! command -v agy >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/agy" ]; then',
    '  t="$(mktemp)"',
    '  curl -fsSL https://antigravity.google/cli/install.sh -o "$t"',
    '  bash "$t"',
    '  rm -f "$t"',
    'fi',
  ],
};

// claude/agy land in ~/.local/bin. Same delete-then-append pattern as the
// default-shell line in .tmux.conf.local: exactly one PATH line per rc file,
// no matter how many times setup re-runs.
const LOCAL_BIN_PATH_BLOCK = [
  'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
  'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
  '  if [ -f "$rc" ]; then',
  "    sed -i '/# tmuxifier-local-bin$/d' \"$rc\" 2>/dev/null || true",
  '    echo \'export PATH="$HOME/.local/bin:$PATH" # tmuxifier-local-bin\' >> "$rc"',
  '  fi',
  'done',
];

// Clamp every shell framework's self-updater. Unattended fleet boxes must not
// update their shell framework at a random shell start — that puts a network
// round trip (and a version bump nobody asked for) in front of a session, and
// oh-my-zsh's reminder mode blocks the shell outright waiting for Y/n. Updates
// happen deliberately instead, via Fleet Command; README documents the commands.
//
// Applied on EVERY setup, not only when Tmuxifier installs the framework: the box
// carrying a hand-installed oh-my-* is exactly the one that never ticks a
// framework checkbox, and it used to be missed. Each clamp is guarded by evidence
// the framework is really there, so an rc file that does not use it is untouched.
//
// Exported for its own test: the assertions run this block against fixture rc
// files rather than string-matching the generated script, because the bug it
// fixes was a guard that LOOKED right.
export function buildFrameworkUpdateClamps() {
  // No `cd` here, deliberately: every path is relative, matching the rc edits
  // these clamps replaced. A real run's cwd is already the target home (ssh lands
  // there; localShellActions passes os.homedir()), and a bare `cd` would instead
  // pin the block to $HOME — which in a test harness that cd'd into a fixture
  // directory means editing the developer's own rc files.
  return [
    // oh-my-zsh. The guard is ANCHORED, and that anchor is the whole fix: every
    // stock install writes a .zshrc carrying oh-my-zsh's own commented template
    //   # zstyle ':omz:update' mode disabled  # disable automatic updates
    // and an unanchored grep matched that comment, decided the clamp was already
    // in place, and never inserted the real line — on any box, ever.
    // Inserting immediately before the source line also settles precedence: zsh
    // honours the last zstyle evaluated before oh-my-zsh.sh runs, so this wins
    // over an operator's earlier `mode auto` without having to find and delete it.
    'if [ -f .zshrc ] && ! grep -q "^zstyle \':omz:update\' mode disabled" .zshrc; then',
    '  sed -i "/oh-my-zsh\\.sh/i zstyle \':omz:update\' mode disabled" .zshrc',
    'fi',
    // oh-my-bash. This guard was already anchored and correct; it is the pattern
    // the omz one above should have followed. omb's check_for_upgrade is also
    // known to strand a stale update.lock when first-start shells race it.
    'if [ -f .bashrc ] && ! grep -q \'^DISABLE_AUTO_UPDATE=\' .bashrc; then',
    '  sed -i \'/oh-my-bash\\.sh/i DISABLE_AUTO_UPDATE="true"\' .bashrc',
    'fi',
    // oh-my-tmux ships BOTH of these as `true` in the .tmux.conf.local it hands
    // out, so an unclamped box git-fetches tpm and every plugin on each tmux
    // server launch AND each config reload. Two plain expressions rather than one
    // with `\|` alternation: busybox sed on Alpine is unreliable with BRE
    // alternation, and Alpine/musl is a supported-with-caveats target. Same
    // anchored-sed shape as the mouse clamp in the oh-my-tmux block.
    'if [ -f .tmux.conf.local ]; then',
    "  sed -i 's/^tmux_conf_update_plugins_on_launch=true/tmux_conf_update_plugins_on_launch=false/' .tmux.conf.local",
    "  sed -i 's/^tmux_conf_update_plugins_on_reload=true/tmux_conf_update_plugins_on_reload=false/' .tmux.conf.local",
    'fi',
  ].join('\n');
}

export function buildEnsureTmuxRemote(session, startupCommand, options = {}) {
  const sess = shSingleQuote(sanitizeSession(session));
  // '=' forces an exact -t match: bare targets prefix-match when no exact name
  // exists (the '=local' lesson), so 'web2' alone would satisfy a bare
  // `has-session -t web` and the create would be silently skipped.
  const exact = shSingleQuote('=' + sanitizeSession(session));
  const startup = startupCommand ? ` ${shSingleQuote(startupCommand)}` : '';
  const tools = resolveTools(options.tools);
  const toolBlocks = tools.flatMap((id) => TOOLS[id]());
  const localBinPath = tools.includes('claude') || tools.includes('agy') ? LOCAL_BIN_PATH_BLOCK : [];
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
  // git is only a prerequisite of the oh-my-* framework installs (their
  // installers clone). A bare setup must not mutate the box's packages, and
  // the explicit git tool has its own catalog entry.
  const needsGit = !!(options.installOhMyTmux || options.installOhMyZsh || options.installOhMyBash);
  const gitBootstrap = needsGit ? [
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
  ] : [];
  return [
    'set -eu',
    ...gitBootstrap,
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
    // Optional tools run only AFTER tmux (and git) are installed: they are slow
    // (`upgrade`) and failure-prone, and under `set -eu` a tool failure aborts
    // the script. Installing tmux first means a failed/interrupted tool run
    // still leaves a terminal-usable box (the attach creates the session).
    ...toolBlocks,
    ...ohMyTmux,
    ...ohMyZsh,
    ...ohMyBash,
    // Strictly after the framework blocks: the omz/omb installers replace
    // .zshrc/.bashrc wholesale, so a clamp written before them would be erased.
    buildFrameworkUpdateClamps(),
    // After the framework blocks: the omz/omb installers replace .zshrc/.bashrc,
    // which would wipe (or predate) the ~/.local/bin line the claude/agy
    // installers rely on.
    ...localBinPath,
    // Session creation is opt-out: a session's shell reads its rc files once,
    // at creation, so a session created here predates anything that writes rc
    // afterwards — notably the AI-auth seed, whose token lands in
    // ~/.profile/.bashrc/.zshrc. setupManager passes createSession: false and
    // runs buildEnsureSessionRemote below once seeding is done.
    ...(options.createSession === false ? [] : [
      `"$TMUX_BIN" has-session -t ${exact} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
      `[ -n "\${ZSH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$ZSH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$ZSH_BIN" 2>/dev/null || true; } || true`,
      `[ -n "\${BASH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$BASH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$BASH_BIN" 2>/dev/null || true; } || true`,
    ]),
  ].join('\n');
}

// Pre-creates the box's tmux session, as the step that runs AFTER everything
// which writes shell rc files — the setup script's installers and then the
// AI-auth seed. A shell reads rc once, at startup, so a session created before
// the seed holds an environment with no token in it and `claude` shows as
// logged out until the session is killed and recreated.
//
// Attaching would create the session anyway (`new-session -A` in
// sshCommand.js), so this only pre-creates it — a box whose setup failed is
// still reachable.
//
// Unlike the setup script's tail, this sets tmux's default-shell BEFORE
// creating the session rather than respawning the window afterwards: the very
// first shell is then already the right one, so nothing running in a pane is
// ever killed.
export function buildEnsureSessionRemote(session, startupCommand, options = {}) {
  const sess = shSingleQuote(sanitizeSession(session));
  // Exact -t match, same reason as buildEnsureTmuxRemote: with only a
  // longer-named session present, a bare target prefix-matches and the guard
  // reports the session as existing — so it is never created, while the
  // caller (the create route, the setup job's ensureSession phase) reports ok.
  const exact = shSingleQuote('=' + sanitizeSession(session));
  const startup = startupCommand ? ` ${shSingleQuote(startupCommand)}` : '';
  const shell = options.installOhMyZsh ? 'zsh' : options.installOhMyBash ? 'bash' : null;
  return [
    'set -eu',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
    ...(shell ? [
      `SHELL_BIN="$(command -v ${shell} || true)"`,
      // start-server first: set-option -g needs a running server, and on a
      // fresh box nothing has started one yet.
      '[ -n "$SHELL_BIN" ] && { "$TMUX_BIN" start-server 2>/dev/null || true; "$TMUX_BIN" set-option -g default-shell "$SHELL_BIN" 2>/dev/null || true; } || true',
    ] : []),
    `"$TMUX_BIN" has-session -t ${exact} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
  ].join('\n');
}

// The tmux-resolution preamble every session/window remote opens with. These
// run under the box's LOGIN shell with whatever PATH it provides, which is not
// the PATH an interactive shell shows — hence the explicit fallback sweep. The
// `command -v tmux` probe is guarded by an `if`, not `|| true`, so a plain
// substring scan of the built remote (see the kill builders' tests below)
// never trips over a stray `|| true` this preamble doesn't actually need.
function tmuxBinPreamble() {
  return [
    'set -eu',
    'TMUX_BIN=""',
    'if command -v tmux >/dev/null 2>&1; then TMUX_BIN="$(command -v tmux)"; fi',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
  ];
}

// Switch a session's current window. The target is SESSION-QUALIFIED
// (`-t '=web:@7'`), not the bare window id it used to be, and both halves are
// validated by the route and again here before quoting.
//
// A bare `-t '@7'` looks exact — a window id is unique per window OBJECT — but a
// grouped session (`tmux new-session -t web -s webclone`) SHARES those objects,
// so the same `@7` legitimately belongs to two sessions at once. Verified on
// tmux 3.5a with `web` + a `webclone` grouped onto it, both sitting on `@2`:
// `select-window -t '@0'` moved *webclone* and left `web` where it was, exit 0 —
// the route would have reported success while the user's pane never moved.
//
// The `=` prefix is this repo's own hard-won lesson (buildEnsureSessionRemote,
// buildKillTmuxRemote): a bare session target prefix-matches when no exact match
// exists, so with only `alpha2` present, `select-window -t 'alpha:@5'` moves
// alpha2's window and exits 0, while `-t '=alpha:@5'` fails with
// "can't find session: alpha" — verified on the same server.
export function buildSelectWindowRemote(session, windowId) {
  if (!SESSION_NAME_RE.test(String(session))) throw new Error('invalid session name');
  if (!WINDOW_ID_RE.test(String(windowId))) throw new Error('invalid window id');
  const target = shSingleQuote(`=${session}:${windowId}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" select-window -t ${target}`].join('\n');
}

// Kill one tmux session on the box. Deliberately NOT a widening of
// buildKillTmuxRemote below: that one runs sanitizeSession (silently REWRITES a
// name rather than rejecting it) and ends in `|| true` (reports success
// whatever happened). Both are correct for its caller — best-effort teardown
// when a box is being removed, which must not be blocked by an unreachable host
// — and both are wrong for an explicit user action whose whole job is to say
// what it did.
//
// The session/windowId checks below test `typeof x === 'string'` before the
// regex, not `SESSION_NAME_RE.test(String(x))` the way buildSelectWindowRemote
// does: String(42), String(null), and String(undefined) are 'null', '42',
// 'undefined' — every one of them a syntactically valid-looking session name —
// so the coercing form would silently accept a type-confused caller instead of
// rejecting it.
export function buildKillSessionRemote(session) {
  if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) throw new Error('invalid session name');
  const target = shSingleQuote(`=${session}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" kill-session -t ${target}`].join('\n');
}

// Kill ONE window. Session-qualified for the same reason select-window is: a
// grouped session shares its window objects, so a bare `@7` names two windows
// at once and tmux picks whichever it resolves first — verified on tmux 3.5a.
// Killing the last window of a session destroys the session; that is tmux's own
// rule and is not special-cased here.
export function buildKillWindowRemote(session, windowId) {
  if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) throw new Error('invalid session name');
  if (typeof windowId !== 'string' || !WINDOW_ID_RE.test(windowId)) throw new Error('invalid window id');
  const target = shSingleQuote(`=${session}:${windowId}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" kill-window -t ${target}`].join('\n');
}

export function buildKillTmuxRemote(session) {
  // Exact -t match ('=' prefix, as killSessionArgs in server.js): a bare
  // target with no exact match prefix-matches, so killing 'web' with only
  // 'web2' present would kill 'web2' — a stranger's session.
  const exact = shSingleQuote('=' + sanitizeSession(session));
  return `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${exact} 2>/dev/null || true; fi`;
}

export function createBoxActions({ run, runStdin, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist }) {
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
    // Land a pasted/dropped file on the box: pipe the bytes to a remote
    // `cat > ~/.tmuxifier-uploads/<stored>` over the shared ControlMaster
    // (no second auth) and return the absolute remote path the script echoes.
    // Same validation path as every probe: assertBoxSafe inside buildProbeArgv,
    // stored name allowlisted + single-quoted in buildUploadRemote.
    async uploadFile(box, name, buffer, { timeoutMs = 60000 } = {}) {
      if (typeof runStdin !== 'function') return { ok: false, error: 'upload not supported' };
      let argv;
      try {
        const stored = storedUploadName(name);
        argv = buildProbeArgv(box, buildUploadRemote(stored), { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid upload' };
      }
      const res = await runStdin(argv, buffer, { timeout: timeoutMs });
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || `ssh exited ${res ? res.code : 'unknown'}` };
      }
      const lines = String(res.stdout || '').trim().split(/\r?\n/);
      const remotePath = (lines[lines.length - 1] || '').trim();
      if (!remotePath.startsWith('/')) return { ok: false, error: 'could not resolve upload path' };
      return { ok: true, path: remotePath };
    },
    // Generic stdin-piped remote script (the uploadFile transport minus upload
    // specifics). Secrets travel on stdin only — the script text goes into ssh
    // argv, so callers must never interpolate secret material into it.
    async execScriptStdin(box, script, input, { timeoutMs = 60000 } = {}) {
      if (typeof runStdin !== 'function') return { ok: false, error: 'stdin exec not supported' };
      let argv;
      try {
        argv = buildProbeArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid box' };
      }
      const res = await runStdin(argv, input, { timeout: timeoutMs });
      const code = res ? res.code : null;
      const stdout = String((res && res.stdout) || '');
      const stderr = String((res && res.stderr) || '');
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, code, stdout, stderr, error: msg || `ssh exited ${res ? res.code : 'unknown'}` };
      }
      return { ok: true, code, stdout, stderr };
    },
    // After an upload lands, type its quoted path into the box session's
    // active pane — but only when the pane is a Claude Code or shell prompt
    // (tmuxInject.js classifies a capture-pane snapshot; busy panes get a
    // tmux status message instead). Rides the same validated probe path as
    // uploadFile; never throws — the upload already succeeded.
    async injectUploadPath(box, session, remotePath, { timeoutMs = 8000 } = {}) {
      return injectVia((script) => runRemote(box, script, timeoutMs), session, remotePath);
    },
    // Pane-aware injection of dictated text. Same guard as injectUploadPath;
    // never throws — the transcription already succeeded and is returned to
    // the client regardless of whether it could be typed.
    async injectText(box, session, text, { timeoutMs = 8000 } = {}) {
      return injectTextVia((script) => runRemote(box, script, timeoutMs), session, text, { label: 'dictation' });
    },
    // Read-only snapshot of the box session's active pane: tmux is the
    // terminal emulator, this just ships its screen. Never attaches a client,
    // so it can never resize the window under a desktop viewer.
    async paneSnapshot(box, session, { lines = 200, timeoutMs = 8000 } = {}) {
      const res = await runRemote(box, buildPaneSnapshotRemote(session, { lines }), timeoutMs);
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || 'capture failed' };
      }
      const snap = parsePaneSnapshot(res.stdout);
      if (!snap) return { ok: false, error: 'unparseable snapshot' };
      return { ok: true, ...snap };
    },
    // Text goes literal (-l) via the same builder dictation uses; a named key
    // must already be validated against NAMED_KEYS by the route — the builder
    // throws on anything else as the second line of defence.
    async sendKeys(box, session, { text, key } = {}, { timeoutMs = 8000 } = {}) {
      const remote = key != null
        ? buildSendNamedKeyRemote(session, key)
        : buildSendKeysRemote(session, String(text ?? ''));
      const res = await runRemote(box, remote, timeoutMs);
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || 'send-keys failed' };
      }
      return { ok: true };
    },
    // Scroll a mouse-aware TUI's own viewport (buildSendWheelRemote). Exit 93
    // is the box-side "pane isn't tracking the mouse" refusal, surfaced as
    // noMouse so the route can answer 409 rather than 502.
    async sendWheel(box, session, dir, { steps = 3, timeoutMs = 8000 } = {}) {
      let remote;
      try {
        remote = buildSendWheelRemote(session, dir, steps);
      } catch (e) {
        return { ok: false, error: e?.message || 'invalid wheel' };
      }
      const res = await runRemote(box, remote, timeoutMs);
      if (res && res.code === 93) return { ok: false, noMouse: true, error: 'pane does not accept mouse input' };
      if (!res || res.code !== 0) {
        const msg = String((res && (res.stderr || res.stdout)) || '').trim().slice(0, 300);
        return { ok: false, error: msg || 'wheel failed' };
      }
      return { ok: true };
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
