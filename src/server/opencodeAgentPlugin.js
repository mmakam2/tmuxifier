// Push the Tmuxifier OpenCode agent-state plugin to a box. Structural twin of
// claudeAgentHooks.js: a pure remote-installer builder + a small DI pusher, run
// as the `opencode-plugin` setup phase. The apply-or-skip decision is made ON
// THE BOX by a presence check — `command -v opencode`, or the native v2
// installer's own location ($HOME/.opencode/bin/opencode, which the catalog
// tool puts on PATH through an rc line a non-interactive ssh shell may not
// read).
//
// The installer script text goes into ssh argv and interpolates NO input; the
// plugin bytes (src/server/assets/tmuxifier-opencode-agent.js) arrive on stdin
// and are written to a temp file and renamed into place, so a reader never
// sees a half-written plugin.
//
// What it deliberately does NOT do (spec §3.3, from the real recording):
//  - no settings merge. OpenCode auto-loads every file in its plugins/
//    directory; there is no config entry to add, so there is nothing of the
//    operator's to merge with or preserve.
//  - no restart advice. A running OpenCode server watches that directory and
//    loads a new plugin file within seconds, so an already-open pane starts
//    reporting without the operator restarting anything.
export function buildOpencodePluginInstallScript() {
  return [
    'set -eu',
    'DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"',
    '',
    '# 1. Apply only when OpenCode is really installed on this box.',
    'if ! command -v opencode >/dev/null 2>&1 && [ ! -x "$HOME/.opencode/bin/opencode" ]; then',
    '  cat >/dev/null 2>&1 || true',
    "  echo 'OPENCODEPLUGIN: skipped-no-opencode'",
    '  exit 0',
    'fi',
    '',
    '# 2. Write the plugin from stdin, atomically.',
    'mkdir -p "$DIR"',
    'cat > "$DIR/tmuxifier-agent.js.$$.tmp"',
    'chmod 644 "$DIR/tmuxifier-agent.js.$$.tmp"',
    'mv -f "$DIR/tmuxifier-agent.js.$$.tmp" "$DIR/tmuxifier-agent.js"',
    "echo 'OPENCODEPLUGIN: applied'",
  ].join('\n');
}

export function createOpencodePluginPusher({ runStdin, readAsset }) {
  const failed = { target: 'opencode-plugin', ok: false, error: 'opencode plugin push failed' };
  return {
    // Never throws: every outcome is a result the setup job records.
    async push(box) {
      let bytes;
      try { bytes = await readAsset(); } catch { return { target: 'opencode-plugin', ok: false, error: 'opencode plugin asset unavailable' }; }
      let res;
      try { res = await runStdin(box, buildOpencodePluginInstallScript(), bytes); } catch { return { ...failed }; }
      const out = String((res && res.stdout) || '');
      if (res && res.code === 0) {
        if (/OPENCODEPLUGIN:\s*skipped-no-opencode/.test(out)) return { target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' };
        if (/OPENCODEPLUGIN:\s*applied/.test(out)) return { target: 'opencode-plugin', ok: true };
      }
      return { ...failed };
    },
  };
}
