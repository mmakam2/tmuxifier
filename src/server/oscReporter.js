// Push the Tmuxifier OSC 7501 pane reporter to a box. Structural twin of
// opencodeAgentPlugin.js: a pure remote-installer builder + a small DI pusher,
// run as the `osc-reporter` setup phase. The apply-or-skip decision is made ON
// THE BOX (`command -v python3`, `command -v tmux`).
//
// The installer script text goes into ssh argv and interpolates NO input; the
// reporter bytes (src/server/assets/tmuxifier-osc-reporter.py) arrive on stdin
// and are written to a temp file and renamed into place. The rc line
// (PI_PROGRAM_STATUS=1, which makes Pi emit OSC 7501) mirrors binPathBlock in
// boxActions.js: delete-then-append under one tag, so reruns leave exactly one.
export function buildOscReporterInstallScript() {
  return [
    'set -eu',
    'DIR="$HOME/.tmuxifier-osc"',
    '',
    '# 1. Apply only when the box can run the reporter.',
    'if ! command -v python3 >/dev/null 2>&1; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'OSCREPORTER: skipped-no-python3'",
    '  exit 0',
    'fi',
    'if ! command -v tmux >/dev/null 2>&1; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'OSCREPORTER: skipped-no-tmux'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the reporter from stdin, atomically.',
    'mkdir -p "$DIR/panes"',
    'cat > "$DIR/reporter.py.$$.tmp"',
    'chmod 644 "$DIR/reporter.py.$$.tmp"',
    'mv -f "$DIR/reporter.py.$$.tmp" "$DIR/reporter.py"',
    '',
    '# 3. One tagged rc line per file, idempotent.',
    'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
    'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  if [ -f "$rc" ]; then',
    "    sed -i '/# tmuxifier-osc-pi$/d' \"$rc\" 2>/dev/null || true",
    "    echo 'export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi' >> \"$rc\"",
    '  fi',
    'done',
    '',
    '# 4. Attach to panes already running an OSC agent. Never fails the install.',
    'python3 "$DIR/reporter.py" sweep >/dev/null 2>&1 || true',
    "echo 'OSCREPORTER: applied'",
  ].join('\n');
}

export function createOscReporterPusher({ runStdin, readAsset }) {
  const failed = { target: 'osc-reporter', ok: false, error: 'osc reporter push failed' };
  return {
    // Never throws: every outcome is a result the setup job records.
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'osc-reporter', ok: false, error: 'osc reporter asset unavailable' }; }
      let res;
      try { res = await runStdin(box, buildOscReporterInstallScript(), bytes); } catch { return { ...failed }; }
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/OSCREPORTER:\s*skipped-no-python3/.test(out)) return { target: 'osc-reporter', ok: false, skipped: 'no python3 on the box' };
        if (/OSCREPORTER:\s*skipped-no-tmux/.test(out)) return { target: 'osc-reporter', ok: false, skipped: 'no tmux on the box' };
        if (/OSCREPORTER:\s*applied/.test(out)) return { target: 'osc-reporter', ok: true };
      }
      return { ...failed };
    },
  };
}
