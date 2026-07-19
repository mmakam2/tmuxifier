import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Seed scripts for AI CLI auth. Secrets arrive on STDIN — the script text goes
// into ssh argv, so nothing secret may ever be interpolated into it (see
// docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md).

// stdin = the `claude setup-token` token. Same delete-then-append idiom as
// LOCAL_BIN_PATH_BLOCK in boxActions.js: exactly one tagged line per rc file.
// ~/.claude.json is written only when absent so an existing config (theme,
// onboarding state) is never clobbered.
export function buildClaudeSeedScript() {
  return [
    'set -eu',
    'umask 077',
    'token="$(cat)"',
    '[ -n "$token" ]',
    'if [ ! -f "$HOME/.profile" ]; then touch "$HOME/.profile"; fi',
    'for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do',
    '  if [ -f "$rc" ]; then',
    "    sed -i '/# tmuxifier-claude-token$/d' \"$rc\" 2>/dev/null || true",
    // Appending to a file without a trailing newline merges onto its last
    // line: the export never parses as its own line (silent seeding
    // failure) and a later run's sed delete then eats that merged line too,
    // destroying the user's original content. Force a newline first.
    '    if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then printf \'\\n\' >> "$rc"; fi',
    '    printf \'export CLAUDE_CODE_OAUTH_TOKEN=%s # tmuxifier-claude-token\\n\' "\'$token\'" >> "$rc"',
    '  fi',
    'done',
    // The onboarding flag must end up in ~/.claude.json even when the file
    // already exists: installing the claude provision tool runs the installer
    // BEFORE seeding, and its first run creates the file without the flag —
    // an only-if-absent write then skips it, and interactive claude shows the
    // login-method picker despite a valid token in the environment. Merge is
    // best-effort (|| true): the token/rc seeding above already succeeded, so
    // an unparseable file must not fail the target; existing keys are always
    // preserved.
    'if [ ! -f "$HOME/.claude.json" ]; then',
    '  printf \'{"hasCompletedOnboarding": true}\\n\' > "$HOME/.claude.json"',
    'elif ! grep -q \'"hasCompletedOnboarding"\' "$HOME/.claude.json"; then',
    '  if command -v python3 >/dev/null 2>&1; then',
    '    python3 -c \'import json,sys;p=sys.argv[1];d=json.load(open(p));d["hasCompletedOnboarding"]=True;json.dump(d,open(p,"w"),indent=2)\' "$HOME/.claude.json" || true',
    '  elif command -v node >/dev/null 2>&1; then',
    '    node -e \'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.hasCompletedOnboarding=true;fs.writeFileSync(p,JSON.stringify(d,null,2))\' "$HOME/.claude.json" || true',
    '  fi',
    'fi',
  ].join('\n');
}

// stdin = the raw ~/.codex/auth.json bytes from the Tmuxifier host.
export function buildCodexSeedScript() {
  return [
    'set -eu',
    'umask 077',
    'mkdir -p "$HOME/.codex"',
    'cat > "$HOME/.codex/auth.json"',
    'chmod 600 "$HOME/.codex/auth.json"',
  ].join('\n');
}

const CODEX_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

export function createAiAuthSeeder({ runStdin, token = null, readLocal = () => fs.readFile(CODEX_AUTH_PATH()) } = {}) {
  return {
    async seed(box) {
      const results = [];
      if (!token) {
        results.push({ target: 'claude', ok: false, skipped: 'TMUXIFIER_CLAUDE_OAUTH_TOKEN not configured' });
      } else if (/['\r\n]/.test(token)) {
        results.push({ target: 'claude', ok: false, skipped: 'unsupported token characters' });
      } else {
        const res = await runStdin(box, buildClaudeSeedScript(), Buffer.from(token));
        results.push(res && res.ok ? { target: 'claude', ok: true } : { target: 'claude', ok: false, error: 'seed failed' });
      }
      let codexBytes = null;
      try { codexBytes = await readLocal(); } catch { /* no local auth */ }
      if (!codexBytes || !codexBytes.length) {
        results.push({ target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' });
      } else {
        const res = await runStdin(box, buildCodexSeedScript(), codexBytes);
        results.push(res && res.ok ? { target: 'codex', ok: true } : { target: 'codex', ok: false, error: 'seed failed' });
      }
      return results;
    },
  };
}
