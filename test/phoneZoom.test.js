import { test, expect } from 'vitest';
import { planZoom, parseWindowState, createPhoneZoom } from '../src/server/phoneZoom.js';

// What the phone's capture saw of the session's current window.
const obs = (windowId, pane, zoomed, panes) => ({ windowId, pane, zoomed, panes });

// --- planZoom: the pure decision -------------------------------------------------------

test('a split pane that is not zoomed is zoomed, and the zoom is ours', () => {
  const r = planZoom(null, 'main', obs('@1', '%2', false, 2));
  expect(r.actions).toEqual([{ type: 'zoom', session: 'main', windowId: '@1', pane: '%2' }]);
  expect(r.state).toMatchObject({ session: 'main', windowId: '@1', pane: '%2', ours: true, settled: true });
});

test('a window with one pane is left alone', () => {
  const r = planZoom(null, 'main', obs('@1', '%2', false, 1));
  expect(r.actions).toEqual([]);
  expect(r.state.ours).toBe(false);
});

test('a window the operator already zoomed is never ours, so it is never restored', () => {
  const r = planZoom(null, 'main', obs('@1', '%2', true, 2));
  expect(r.actions).toEqual([]);
  expect(r.state).toMatchObject({ ours: false, settled: true });
});

test('once zoomed, the same pane still zoomed needs nothing', () => {
  const first = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  const r = planZoom(first, 'main', obs('@1', '%2', true, 2));
  expect(r.actions).toEqual([]);
  expect(r.state.ours).toBe(true);
});

test('someone unzooms the pane we zoomed: it is theirs now and is not zoomed again', () => {
  let st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  st = planZoom(st, 'main', obs('@1', '%2', true, 2)).state;
  const r = planZoom(st, 'main', obs('@1', '%2', false, 2));
  expect(r.actions).toEqual([]);
  expect(r.state).toMatchObject({ ours: false, settled: true });
  // And it stays that way on the next look.
  expect(planZoom(r.state, 'main', obs('@1', '%2', false, 2)).actions).toEqual([]);
});

test('another pane of the same window comes to the front unzoomed: it is zoomed', () => {
  let st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  st = planZoom(st, 'main', obs('@1', '%2', false, 2)).state; // released by the operator
  const r = planZoom(st, 'main', obs('@1', '%3', false, 2));
  expect(r.actions).toEqual([{ type: 'zoom', session: 'main', windowId: '@1', pane: '%3' }]);
  expect(r.state.ours).toBe(true);
});

test('a jump to another pane of a window we zoomed keeps the zoom ours (select-pane -Z keeps it zoomed)', () => {
  const st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  const r = planZoom(st, 'main', obs('@1', '%3', true, 2));
  expect(r.actions).toEqual([]);
  expect(r.state).toMatchObject({ pane: '%3', ours: true, settled: true });
});

test('the viewer moves to another window: the window we zoomed is restored first, then the new one is judged', () => {
  const st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  const r = planZoom(st, 'main', obs('@4', '%9', false, 3));
  expect(r.actions).toEqual([
    { type: 'unzoom', session: 'main', windowId: '@1' },
    { type: 'zoom', session: 'main', windowId: '@4', pane: '%9' },
  ]);
});

test('moving on from a window that was never ours restores nothing', () => {
  const st = planZoom(null, 'main', obs('@1', '%2', true, 2)).state;
  const r = planZoom(st, 'main', obs('@4', '%9', false, 1));
  expect(r.actions).toEqual([]);
});

test('the same window id under another session is another window', () => {
  const st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  const r = planZoom(st, 'work', obs('@1', '%2', true, 2));
  expect(r.actions).toEqual([{ type: 'unzoom', session: 'main', windowId: '@1' }]);
  expect(r.state).toMatchObject({ session: 'work', ours: false });
});

test('the window loses its other pane: nothing is ours any more', () => {
  const st = planZoom(null, 'main', obs('@1', '%2', false, 2)).state;
  const r = planZoom(st, 'main', obs('@1', '%2', false, 1));
  expect(r.actions).toEqual([]);
  expect(r.state.ours).toBe(false);
  // A later split of the same pane is a fresh case and is zoomed.
  expect(planZoom(r.state, 'main', obs('@1', '%2', false, 2)).actions).toHaveLength(1);
});

// --- parseWindowState: box output, allowlisted ------------------------------------------

test('parseWindowState reads the marker line and nothing else', () => {
  expect(parseWindowState('__WZ__ @7 0 2')).toEqual({ windowId: '@7', zoomed: false, panes: 2 });
  expect(parseWindowState('__WZ__ @7 1 3')).toEqual({ windowId: '@7', zoomed: true, panes: 3 });
});

test.each([
  '', '__WZ__', '__WZ__ @7 0', '__WZ__ 7 0 2', '__WZ__ @7 2 2', '__WZ__ @7 0 0', '__WZ__ @7 0 99999',
  '__WZ__ @7 0 2 extra', ' __WZ__ @7 0 2', '__WZ__ @7  2', '__WZ__ @7 0 2\n', '80 24 3 10 0 0 0 %1',
  '__WZ__ @12345678901 0 2', '__WZ__ @7;rm 0 2',
])('parseWindowState refuses %j', (line) => {
  expect(parseWindowState(line)).toBe(null);
});

// --- createPhoneZoom: the stateful half, with the effects recorded ----------------------

function bench({ zoomOk = true } = {}) {
  const log = [];
  const gates = [];
  const pz = createPhoneZoom({
    zoom: async (box, session, windowId, pane) => {
      log.push(['zoom', box.id, session, windowId, pane]);
      if (gates.length) await gates.shift();
      return typeof zoomOk === 'function' ? zoomOk() : zoomOk;
    },
    unzoom: async (box, session, windowId) => { log.push(['unzoom', box.id, session, windowId]); return true; },
  });
  return { pz, log, gates };
}
const BOX = { id: 'b1' };

test('note zooms a split pane once, and gone restores it', async () => {
  const { pz, log } = bench();
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  await pz.note('k', BOX, 'main', obs('@1', '%2', true, 2), pz.mark());
  expect(log).toEqual([['zoom', 'b1', 'main', '@1', '%2']]);
  await pz.gone('k');
  expect(log.at(-1)).toEqual(['unzoom', 'b1', 'main', '@1']);
  expect(pz.size()).toBe(0);
});

test('gone restores nothing when the zoom was the operator\'s', async () => {
  const { pz, log } = bench();
  await pz.note('k', BOX, 'main', obs('@1', '%2', true, 2), pz.mark());
  await pz.gone('k');
  expect(log).toEqual([]);
});

test('gone for a viewer never seen does nothing', async () => {
  const { pz, log } = bench();
  await pz.gone('nobody');
  expect(log).toEqual([]);
});

test('a capture that started before our zoom finished is not read as "someone unzoomed it"', async () => {
  const { pz, log } = bench();
  const before = pz.mark();            // a capture starts...
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark()); // ...we zoom meanwhile...
  // ...and that older capture, still showing the pane unzoomed, is noted afterwards.
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), before);
  // A fresh capture then shows it zoomed; closing the viewer must still restore it.
  await pz.note('k', BOX, 'main', obs('@1', '%2', true, 2), pz.mark());
  await pz.gone('k');
  expect(log).toEqual([['zoom', 'b1', 'main', '@1', '%2'], ['unzoom', 'b1', 'main', '@1']]);
});

test('a zoom that did not take is tried again on the next look, and is not ours meanwhile', async () => {
  let ok = false;
  const { pz, log } = bench({ zoomOk: () => ok });
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  ok = true;
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  expect(log.filter((l) => l[0] === 'zoom')).toHaveLength(2);
  await pz.gone('k');
  expect(log.at(-1)).toEqual(['unzoom', 'b1', 'main', '@1']);
});

test('a failed zoom leaves nothing to restore', async () => {
  const { pz, log } = bench({ zoomOk: false });
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  await pz.gone('k');
  expect(log).toEqual([['zoom', 'b1', 'main', '@1', '%2']]);
});

test('gone while a zoom is still running waits for it, then restores', async () => {
  const { pz, log, gates } = bench();
  let release;
  gates.push(new Promise((r) => { release = r; }));
  const noting = pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  const leaving = pz.gone('k');
  release();
  await Promise.all([noting, leaving]);
  expect(log).toEqual([['zoom', 'b1', 'main', '@1', '%2'], ['unzoom', 'b1', 'main', '@1']]);
});

test('two viewers are tracked apart', async () => {
  const { pz, log } = bench();
  await pz.note('a', { id: 'b1' }, 'main', obs('@1', '%2', false, 2), pz.mark());
  await pz.note('b', { id: 'b2' }, 'main', obs('@1', '%2', false, 2), pz.mark());
  await pz.gone('a');
  expect(log.filter((l) => l[0] === 'unzoom')).toEqual([['unzoom', 'b1', 'main', '@1']]);
  expect(pz.size()).toBe(1);
});

test('an observation that is not a full one is ignored', async () => {
  const { pz, log } = bench();
  for (const bad of [null, undefined, {}, obs('@1', undefined, false, 2), obs('1', '%2', false, 2), obs('@1', '%2', 'no', 2)]) {
    await pz.note('k', BOX, 'main', bad, pz.mark());
  }
  expect(log).toEqual([]);
});

test('an effect that throws is swallowed and leaves the viewer usable', async () => {
  let fail = true;
  const log = [];
  const pz = createPhoneZoom({
    zoom: async () => { if (fail) throw new Error('ssh down'); log.push('zoom'); return true; },
    unzoom: async () => { log.push('unzoom'); return true; },
  });
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  fail = false;
  await pz.note('k', BOX, 'main', obs('@1', '%2', false, 2), pz.mark());
  await pz.gone('k');
  expect(log).toEqual(['zoom', 'unzoom']);
});

test('the viewer table is bounded: the oldest viewer is dropped, and what it zoomed is restored', async () => {
  const { pz, log } = bench();
  for (let i = 0; i < 70; i++) {
    await pz.note(`k${i}`, { id: `b${i}` }, 'main', obs('@1', '%2', false, 2), pz.mark());
  }
  await pz.idle();
  expect(pz.size()).toBeLessThanOrEqual(64);
  expect(log.filter((l) => l[0] === 'unzoom')[0]).toEqual(['unzoom', 'b0', 'main', '@1']);
});
