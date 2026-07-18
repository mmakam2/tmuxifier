import { test, expect } from 'vitest';
import { killSessionArgs } from '../src/server/server.js';

// tmux -t falls back to PREFIX matching when no exact name exists, so a bare
// 'local' target could kill an unrelated 'local-dev' session on this host.
// The '=' prefix forces an exact match.
test('kill-session targets the exact tmux session name, never a prefix match', () => {
  expect(killSessionArgs('local')).toEqual(['kill-session', '-t', '=local']);
});
