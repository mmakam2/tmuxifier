import { test, expect } from 'vitest';
import { createBoxRemoval } from '../src/server/boxRemoval.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// One group close covers the box's terminals — one per viewer now, so there is
// no fixed set of keys to enumerate — and its provision PTY together. Naming
// the two keys individually, as this did, would silently leave every viewer's
// ssh alive after the box was deleted.
test('removeBox closes the box session group and removes persistence before the remote cleanup runs', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.1.10' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async (id) => calls.push(['store', id]) },
    sessions: { closeGroup: (group) => calls.push(['session', group]) },
    boxActions: {
      killSession: async () => { calls.push(['kill']); throw new Error('already down'); },
      exitMaster: async () => calls.push(['master']),
    },
  });
  await expect(removeBox('B1')).resolves.toEqual({ ok: true });
  // The user-visible removal has already happened…
  expect(calls.slice(0, 2)).toEqual([['session', 'B1'], ['store', 'B1']]);
  // …and the best-effort SSH cleanup still runs (kill error swallowed), in order.
  await tick(); await tick();
  expect(calls).toEqual([
    ['session', 'B1'], ['store', 'B1'], ['kill'], ['master'],
  ]);
});

test('removeBox resolves without waiting for slow cleanup of an unreachable host', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.250.250' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async (id) => calls.push(['store', id]) },
    sessions: { closeGroup: () => {} },
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

// Security invariant: a known_hosts entry is removed only on verified
// deprovision, fresh provision, or an explicit user click — never on ordinary
// box removal. This is a regression lock, not a drive of new behavior:
// createBoxRemoval never calls a `forgetHostKey` boxAction today, so this
// passes immediately and stays green as long as that stays true.
test('ordinary box removal never touches known_hosts', async () => {
  const calls = [];
  const box = { id: 'B1', host: '192.168.1.10' };
  const removeBox = createBoxRemoval({
    store: { getBox: async () => box, removeBox: async () => {} },
    sessions: { closeGroup: () => {} },
    boxActions: {
      killSession: async () => { calls.push('kill'); },
      exitMaster: async () => { calls.push('master'); },
      forgetHostKey: async () => { calls.push('forgetHostKey'); },
    },
  });
  await expect(removeBox('B1')).resolves.toEqual({ ok: true });
  await tick(); await tick();
  expect(calls).not.toContain('forgetHostKey');
});

test('the background master teardown is skipped when an identical box was re-added', async () => {
  const calls = [];
  const box = { id: 'B1', host: 'h', user: 'u', port: 22 };
  const removeBox = createBoxRemoval({
    store: {
      getBox: async () => box,
      removeBox: async () => {},
      listBoxes: async () => [{ id: 'B2', host: 'h', user: 'u', port: 22 }],
    },
    sessions: { closeGroup: () => {} },
    boxActions: { killSession: async () => calls.push('kill'), exitMaster: async () => calls.push('master') },
  });
  await removeBox('B1');
  await tick(); await tick();
  expect(calls).toEqual(['kill']); // the ControlMaster now belongs to the re-added box
});

test('removal forgets the box in the status checker (backoff/cpu maps)', async () => {
  const forgotten = [];
  const removeBox = createBoxRemoval({
    store: { getBox: async () => ({ id: 'B1', host: 'h' }), removeBox: async () => {} },
    sessions: { closeGroup: () => {} },
    boxActions: {},
    statusChecker: { forgetBox: (id) => forgotten.push(id) },
  });
  await removeBox('B1');
  expect(forgotten).toEqual(['B1']);
});
