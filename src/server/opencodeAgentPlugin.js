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
// It also asks the box's OpenCode for its version (`opencode --version`, the real binary prints
// `opencode v2.3.0`) and prints `OPENCODEPLUGIN: version <digits and dots>`: the first dotted
// number in the output, and only from a run that exited 0 within 10 s. Agent messaging needs
// OPENCODE_MAIL_MIN; the plugin's mail part stays inert below it, so the pusher's ok result then
// (or without a readable version) carries a note, as agent-mail does for an old Claude Code. The
// number is box output: the pusher takes it only as a plain dotted number. OPENCODE_MAIL_MIN is
// pinned equal to the asset's own export by test/opencodeAgentPlugin.pusher.test.js (the asset
// is copied to the box and cannot import this file).
//
// What it deliberately does NOT do (spec §3.3, from the real recording):
//  - no settings merge. OpenCode auto-loads every file in its plugins/
//    directory; there is no config entry to add, so there is nothing of the
//    operator's to merge with or preserve.
//  - no restart advice. A running OpenCode server watches that directory and
//    loads a new plugin file within seconds, so an already-open pane starts
//    reporting without the operator restarting anything.

export const OPENCODE_MAIL_MIN = '2.3.0';
export const OPENCODE_MAIL_NOTE = `agent messaging needs OpenCode ${OPENCODE_MAIL_MIN} or later`;
if (!/^\d{1,9}(\.\d{1,9}){0,7}$/.test(OPENCODE_MAIL_MIN)) throw new Error('opencode mail version outside its alphabet');

const NUM_RE = /^\d{1,9}(?:\.\d{1,9}){0,7}$/;
// A dotted number as parts; a missing part reads as 0, so 2.3 equals 2.3.0.
const parts = (v) => v.split('.').map(Number);
function atLeast(version, min) {
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
// The version line the installer printed, or null: only the line's whole remainder counts, so
// anything but a plain dotted number is no version.
const VERSION_LINE = /^OPENCODEPLUGIN:[ \t]*version[ \t]+(\S+)[ \t\r]*$/m;
function printedVersion(out) {
  const m = VERSION_LINE.exec(out);
  return m && NUM_RE.test(m[1]) ? m[1] : null;
}

export function buildOpencodePluginInstallScript() {
  return [
    'set -eu',
    'DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"',
    'CFG="${DIR%/plugins}"',
    'VF="$CFG/.tmuxifier-version.$$.tmp"',
    'trap \'rm -f "$VF"\' EXIT',
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
    '',
    '# 3. The version OpenCode reports, for the messaging note. Into a file in its config dir (never',
    '# plugins/, which OpenCode loads), so a child outliving a killed opencode cannot hold a read',
    '# open; only a run that exits 0 counts, the first dotted number of the first 256 bytes.',
    'OCBIN=opencode',
    'command -v opencode >/dev/null 2>&1 || OCBIN="$HOME/.opencode/bin/opencode"',
    'OCV=',
    'if command -v timeout >/dev/null 2>&1; then',
    '  if timeout 10 "$OCBIN" --version > "$VF" 2>/dev/null < /dev/null; then',
    "    OCV=$(head -c 256 \"$VF\" | sed -n 's/^[^0-9]*\\([0-9][0-9]*\\(\\.[0-9][0-9]*\\)*\\).*$/\\1/p' | head -n 1)",
    '  fi',
    'elif "$OCBIN" --version > "$VF" 2>/dev/null < /dev/null; then',
    "  OCV=$(head -c 256 \"$VF\" | sed -n 's/^[^0-9]*\\([0-9][0-9]*\\(\\.[0-9][0-9]*\\)*\\).*$/\\1/p' | head -n 1)",
    'fi',
    'if [ -n "$OCV" ]; then echo "OPENCODEPLUGIN: version $OCV"; fi',
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
        if (/OPENCODEPLUGIN:\s*applied/.test(out)) {
          // Applied either way; below the first version messaging was verified on, or with none
          // readable, the plugin's mail part stays inert and the row says why.
          const v = printedVersion(out);
          if (v === null || !atLeast(v, OPENCODE_MAIL_MIN)) return { target: 'opencode-plugin', ok: true, note: OPENCODE_MAIL_NOTE };
          return { target: 'opencode-plugin', ok: true };
        }
      }
      return { ...failed };
    },
  };
}
