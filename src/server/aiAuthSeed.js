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
    '    printf \'export CLAUDE_CODE_OAUTH_TOKEN=%s # tmuxifier-claude-token\\n\' "\'$token\'" >> "$rc"',
    '  fi',
    'done',
    'if [ ! -f "$HOME/.claude.json" ]; then',
    '  printf \'{"hasCompletedOnboarding": true}\\n\' > "$HOME/.claude.json"',
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
      } else if (token.includes("'")) {
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
