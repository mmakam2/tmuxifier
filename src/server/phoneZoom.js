import { WINDOW_ID_RE, PANE_ID_RE, SESSION_NAME_RE } from './sshCommand.js';

// A split pane on a phone. The app asks for a phone-shaped window by keeping an
// invisible tmux client attached at its cols×rows (sessions.ensureSizedViewer), so
// a pane that shares its window with others gets only its share of an already
// small screen: half the columns, or half the rows. tmux's own answer is zoom, so
// while a sized viewer is showing a session, the pane in front of that session's
// current window is zoomed, and the zoom is undone when the viewer goes.
//
// Zoom belongs to the tmux WINDOW, so every client attached to it sees it. Three
// rules keep that from being a fight over the operator's layout:
//
//   1. Only a zoom this module made is ever undone. A window that was already
//      zoomed when the viewer arrived is the operator's and is never touched.
//   2. Someone unzooms a pane we zoomed (prefix+z in the browser): it is theirs
//      from then on. It is not zoomed again until another pane comes to the front,
//      which is what a jump from the phone does.
//   3. One window per viewer: when the viewer's session shows another window, the
//      one we zoomed is restored before the new one is judged.
//
// State is in memory only. A server restart while a phone is looking leaves the
// pane zoomed (prefix+z undoes it); nothing about windows is persisted anywhere.
//
// Everything here that came from a box (the window id, the pane id, the two
// numbers) is allowlisted by parseWindowState and checked again in `usable`, and
// the builders that turn them into tmux targets validate them a third time.

const MARK = '__WZ__';
export const WINDOW_STATE_FORMAT = `${MARK} #{window_id} #{window_zoomed_flag} #{window_panes}`;

// `__WZ__ <@id> <0|1> <pane count>`, exactly. A tmux too old for one of the format
// variables expands it to nothing and the line fails here: no zoom on that box.
const LINE_RE = /^__WZ__ (@\d{1,9}) ([01]) ([1-9]\d{0,3})$/;
export function parseWindowState(line) {
  const m = LINE_RE.exec(String(line ?? ''));
  if (!m) return null;
  return { windowId: m[1], zoomed: m[2] === '1', panes: Number(m[3]) };
}
export const isWindowStateLine = (line) => String(line ?? '').startsWith(`${MARK} `) || line === MARK;

// The pure decision. `prev` is what this viewer was last seen on (or null), `obs`
// what its capture just saw: { windowId, pane, zoomed, panes }. Returns the next
// state and the actions to run, in order. `ours` is "we zoomed this window and may
// undo it"; `settled` is "this pane has been zoomed while we watched", which is
// what turns a later unzoomed look into rule 2 instead of a reason to zoom.
export function planZoom(prev, session, obs) {
  const actions = [];
  let st = prev;
  if (st && (st.session !== session || st.windowId !== obs.windowId)) {
    if (st.ours) actions.push({ type: 'unzoom', session: st.session, windowId: st.windowId });
    st = null;
  }
  const base = { session, windowId: obs.windowId, pane: obs.pane };
  // One pane cannot be zoomed, and a window that lost its other panes is unzoomed
  // by tmux itself: nothing is ours, and a later split starts fresh.
  if (obs.panes <= 1) return { state: { ...base, ours: false, settled: false }, actions };
  if (obs.zoomed) return { state: { ...base, ours: !!st?.ours, settled: true }, actions };
  if (st && st.pane === obs.pane && st.settled) {
    return { state: { ...base, ours: false, settled: true }, actions };
  }
  actions.push({ type: 'zoom', session, windowId: obs.windowId, pane: obs.pane });
  return { state: { ...base, ours: true, settled: true }, actions };
}

function usable(session, obs) {
  return typeof session === 'string' && SESSION_NAME_RE.test(session)
    && !!obs && typeof obs.windowId === 'string' && WINDOW_ID_RE.test(obs.windowId)
    && typeof obs.pane === 'string' && PANE_ID_RE.test(obs.pane)
    && typeof obs.zoomed === 'boolean'
    && Number.isInteger(obs.panes) && obs.panes >= 1;
}

// Viewers are one per box and device, so this is small; the cap is a backstop for
// a viewer whose exit was never reported.
const MAX_VIEWERS = 64;

// `zoom(box, session, windowId, pane)` and `unzoom(box, session, windowId)` each
// resolve true when tmux did it. Both are best-effort: a throw or a false leaves
// the viewer tracked and nothing claimed.
export function createPhoneZoom({ zoom, unzoom }) {
  // key -> { box, state, tail, after }. `tail` serialises one viewer's work, so a
  // `gone` that arrives while a zoom is still running restores after it.
  const viewers = new Map();
  let seq = 0;
  const pending = new Set();

  const attempt = async (fn) => { try { return (await fn()) === true; } catch { return false; } };

  function enqueue(v, work) {
    const run = v.tail.then(work, work);
    v.tail = run.catch(() => {});
    pending.add(v.tail);
    v.tail.finally(() => pending.delete(v.tail));
    return v.tail;
  }

  async function apply(v, session, obs, mark) {
    // A capture that started before our last zoom or unzoom finished shows the
    // window as it was: read as news, it would look like someone undoing our zoom.
    if (!(mark > v.after)) return;
    const { state, actions } = planZoom(v.state, session, obs);
    let next = state;
    for (const a of actions) {
      if (a.type === 'unzoom') {
        await attempt(() => unzoom(v.box, a.session, a.windowId));
      } else if (!(await attempt(() => zoom(v.box, a.session, a.windowId, a.pane)))) {
        // Not zoomed, so not ours and not settled: the next look tries again.
        next = { ...state, ours: false, settled: false };
      }
    }
    if (actions.length) v.after = ++seq;
    v.state = next;
  }

  async function leave(key) {
    const v = viewers.get(key);
    if (!v) return;
    viewers.delete(key);
    await enqueue(v, async () => {
      const st = v.state;
      v.state = null;
      if (st?.ours) await attempt(() => unzoom(v.box, st.session, st.windowId));
    });
  }

  return {
    // Taken BEFORE the capture starts and handed back with what it saw.
    mark: () => ++seq,
    // After a sized capture: `obs` is what it saw, or anything else for "unknown".
    note(key, box, session, obs, mark) {
      if (!usable(session, obs)) return Promise.resolve();
      let v = viewers.get(key);
      if (!v) {
        v = { box, state: null, tail: Promise.resolve(), after: 0 };
        viewers.set(key, v);
        if (viewers.size > MAX_VIEWERS) void leave(viewers.keys().next().value);
      }
      v.box = box;
      return enqueue(v, () => apply(v, session, obs, mark));
    },
    // The sized viewer is gone (its TTL ran out, the session was switched, the box
    // was closed): undo what we zoomed for it.
    gone: (key) => leave(key),
    size: () => viewers.size,
    // Everything queued so far has run (tests).
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
