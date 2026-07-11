import { test, expect } from 'vitest';
import { createBoxRemoval } from '../src/server/boxRemoval.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('removeBox closes both session keys and removes persistence before the remote cleanup runs', async () => {
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
  // The user-visible removal has already happened…
  expect(calls.slice(0, 3)).toEqual([['session', 'B1'], ['session', 'provision:B1'], ['store', 'B1']]);
  // …and the best-effort SSH cleanup still runs (kill error swallowed), in order.
  await tick(); await tick();
  expect(calls).toEqual([
    ['session', 'B1'], ['session', 'provision:B1'], ['store', 'B1'], ['kill'], ['master'],
  ]);
});

test('removeBox resolves without waiting for slow cleanup of an unreachable host', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.250.250' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async (id) => calls.push(['store', id]) },
    sessions: { closeKey: () => {} },
    boxActions: {
      // Models the ssh ConnectTimeout wait on an unreachable host.
      killSession: () => new Promise((r) => setTimeout(() => { calls.push(['kill']); r({ ok: true }); }, 300)),
      exitMaster: async () => calls.push(['master']),
    },
  });
  const t0 = Date.now();
  await expect(removeBox('B1')).resolves.toEqual({ ok: true });
  expect(Date.now() - t0).toBeLessThan(150);          // did not block on the 300ms kill
  expect(calls).toEqual([['store', 'B1']]);           // store removal already done
  await new Promise((r) => setTimeout(r, 400));
  expect(calls).toEqual([['store', 'B1'], ['kill'], ['master']]); // cleanup still completed
});

test('removeBox is idempotent for an absent box', async () => {
  const removeBox = createBoxRemoval({ store: { getBox: async () => undefined, removeBox: async () => {} } });
  await expect(removeBox('missing')).resolves.toEqual({ ok: true });
});
