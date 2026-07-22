// Push the operator's custom Claude Code statusline to a box. Structural twin
// of aiAuthSeed.js: a pure remote-installer builder + a small DI pusher, run as
// a post-setup step. The apply-or-skip decision is made ON THE BOX by a
// command -v claude presence check, so one rule covers both "new box without
// Claude → nothing happens" and "edit of a box that already has Claude → apply".
//
// The installer script text goes into ssh argv and interpolates NO input; the
// statusline file content arrives on stdin.

// The settings.json command value, written LITERALLY — its ${...} is expanded
// later by the shell that runs the statusline, not at install time. Single
// quotes in the script keep the box's shell from expanding it here.
const CMD_LITERAL = 'bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh"';

export function buildStatuslineInstallScript() {
  return [
    'set -eu',
    'DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'SL="$DIR/statusline-command.sh"',
    'SETTINGS="$DIR/settings.json"',
    `CMD='${CMD_LITERAL}'`,
    '',
    '# 1. Apply only when Claude Code is really installed on this box.',
    'if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'STATUSLINE: skipped-no-claude'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the statusline script from stdin.',
    'mkdir -p "$DIR"',
    'cat > "$SL"',
    'chmod 755 "$SL"',
    '',
    '# 3. Ensure jq best-effort — the statusline needs it at render time for the',
    '#    model/dir/version fields (the git segment does not).',
    'if ! command -v jq >/dev/null 2>&1; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq || { $SUDO apt-get update || true; $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq || true; }',
    '  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y jq || true',
    '  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y jq || true',
    '  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm jq || true',
    '  elif command -v apk >/dev/null 2>&1; then $SUDO apk add jq || true',
    '  elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install jq || true',
    '  fi',
    'fi',
    '',
    '# 4. Merge the statusLine block into settings.json.',
    'if [ ! -f "$SETTINGS" ]; then',
    '  # No file yet — write it fresh via a quoted heredoc: no shell expansion',
    '  # (${...} and \\" land literally) and no JSON parser needed, so this works',
    "  # even if jq/node/python are all absent. The heredoc body and terminator",
    "  # sit at column 0 because <<'EOF' (no dash) strips nothing.",
    "  cat > \"$SETTINGS\" <<'STATUSLINE_EOF'",
    '{',
    '  "statusLine": {',
    '    "type": "command",',
    '    "command": "bash \\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-command.sh\\""',
    '  }',
    '}',
    'STATUSLINE_EOF',
    '  chmod 600 "$SETTINGS"',
    "  echo 'STATUSLINE: applied'",
    '  exit 0',
    'fi',
    '',
    '# File exists — set .statusLine, preserving other keys, atomically.',
    'TMP="$SETTINGS.tmuxifier.tmp"',
    'if command -v jq >/dev/null 2>&1; then',
    '  jq --arg cmd "$CMD" \'.statusLine = {type:"command",command:$cmd}\' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"',
    'elif command -v node >/dev/null 2>&1; then',
    '  node -e \'const fs=require("fs");const p=process.argv[1];const cmd=process.argv[2];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.statusLine={type:"command",command:cmd};const t=p+".tmuxifier.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,p)\' "$SETTINGS" "$CMD"',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python3 -c \'import json,sys,os;p=sys.argv[1];cmd=sys.argv[2];d=json.load(open(p));d["statusLine"]={"type":"command","command":cmd};t=p+".tmuxifier.tmp";json.dump(d,open(t,"w"),indent=2);os.replace(t,p)\' "$SETTINGS" "$CMD"',
    'else',
    "  echo 'STATUSLINE: error-no-json-tool'",
    '  exit 4',
    'fi',
    "echo 'STATUSLINE: applied'",
  ].join('\n');
}

export function createStatuslinePusher({ runStdin, readAsset }) {
  return {
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'statusline', ok: false, error: 'statusline asset unavailable' }; }
      const res = await runStdin(box, buildStatuslineInstallScript(), bytes);
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/STATUSLINE:\s*skipped-no-claude/.test(out)) return { target: 'statusline', ok: false, skipped: 'no Claude on the box' };
        if (/STATUSLINE:\s*applied/.test(out)) return { target: 'statusline', ok: true };
      }
      return { target: 'statusline', ok: false, error: 'statusline push failed' };
    },
  };
}
