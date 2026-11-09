// Push the Tmuxifier OSC 7501 pane reporter to a box. Structural twin of
// opencodeAgentPlugin.js: a pure remote-installer builder + a small DI pusher,
// run as the `osc-reporter` setup phase. The apply-or-skip decision is made ON
// THE BOX (`command -v python3`, `command -v tmux`).
//
// The installer script text goes into ssh argv and interpolates NO input; the
// reporter bytes (src/server/assets/tmuxifier-osc-reporter.py) arrive on stdin
// and are written to a temp file and renamed into place. Three rc lines follow,
// pi's, agy's and the agy function: PI_PROGRAM_STATUS=1 makes Pi emit OSC 7501, and
// AGY_CLI_OSC7501=on makes Antigravity CLI (agy) report without probing (inside
// tmux its probe never gets an answer). Each mirrors binPathBlock in
// boxActions.js: delete-then-append under its own tag, so reruns leave exactly
// one of each.
//
// The third line (AGY_ATTACH_RC_LINE) defines an `agy` shell function that runs
// the reporter's `attach` role on the current tmux pane before the real agy
// starts, so agy's start-up prompt (sent ~0.15 s after launch, before the
// loop's 2 s attach) is not missed. It is `alias agy … || eval '…'` because a
// function definition is parsed with aliases expanded: defining `agy()` under
// an operator alias named `agy` is a syntax error in bash and zsh. The eval
// defers the parse until after the alias check, so an existing alias wins and
// nothing is defined or printed. Outside tmux, or with python3 or the reporter
// missing, the function just runs `command agy "$@"`.
export const AGY_ATTACH_RC_LINE = `alias agy >/dev/null 2>&1 || eval 'agy() { [ -z "\${TMUX_PANE:-}" ] || python3 "$HOME/.tmuxifier-osc/reporter.py" attach "$TMUX_PANE" </dev/null >/dev/null 2>&1; command agy "$@"; }' # tmuxifier-osc-agy-attach`;
// The same line as one single-quoted sh word (every ' written as '\'').
const AGY_ATTACH_RC_LINE_QUOTED = `'${AGY_ATTACH_RC_LINE.replaceAll("'", "'\\''")}'`;

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
    '# 3. One tagged rc line per variable (and the agy function) per file, idempotent.',
    'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
    'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  if [ -f "$rc" ]; then',
    "    sed -i '/# tmuxifier-osc-pi$/d' \"$rc\" 2>/dev/null || true",
    "    echo 'export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi' >> \"$rc\"",
    "    sed -i '/# tmuxifier-osc-agy$/d' \"$rc\" 2>/dev/null || true",
    "    echo 'export AGY_CLI_OSC7501=on # tmuxifier-osc-agy' >> \"$rc\"",
    "    sed -i '/# tmuxifier-osc-agy-attach$/d' \"$rc\" 2>/dev/null || true",
    `    printf '%s\\n' ${AGY_ATTACH_RC_LINE_QUOTED} >> "$rc"`,
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
