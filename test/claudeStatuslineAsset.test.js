import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../src/server/assets/claude-statusline.sh', import.meta.url));

test('the bundled statusline asset is the portable version', () => {
  const s = readFileSync(p, 'utf8');
  // Config-dir-relative caveman glob → works for root, any $HOME, custom CLAUDE_CONFIG_DIR.
  expect(s).toContain('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/caveman/caveman/');
  // jq-driven fields (the statusline's render-time dependency).
  expect(s).toContain("jq -r '.model.display_name");
  // No hardcoded /root path leaked in.
  expect(s).not.toContain('/root/.claude/plugins/cache/caveman');
});
