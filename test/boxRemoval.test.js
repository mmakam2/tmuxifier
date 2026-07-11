import { test, expect } from 'vitest';
import { createBoxRemoval } from '../src/server/boxRemoval.js';

test('removeBox closes both session keys, best-effort kills tmux, then removes persistence', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.1.10' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async (id) => calls.push(['store', id]) },
    sessions: { closeKey: (key) => calls.push(['session', key]) },
    boxActions: {
      killSession: async () => { calls.push(['kill']); throw new Error('already down'); },
      exitMaster: async () => calls.push(['master']),
    },
  });
  await expect(removeBox('B1')).resolves.toEqual({ ok: true });
  expect(calls).toEqual([
    ['session', 'B1'], ['session', 'provision:B1'], ['kill'], ['master'], ['store', 'B1'],
  ]);
});

test('removeBox is idempotent for an absent box', async () => {
  const removeBox = createBoxRemoval({ store: { getBox: async () => undefined, removeBox: async () => {} } });
  await expect(removeBox('missing')).resolves.toEqual({ ok: true });
});
