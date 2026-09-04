//
// The server side of a voice link (spec 2026-09-04): one box-side writer
// (voiceWriter.js) per linked box, fed by the /voice-link WebSocket's binary
// frames. Transport-agnostic — server.js glues a socket to a link through
// onReady/onClose and link.write/link.close — so the whole policy is testable
// with a fake sink. Rules:
//  - One link per box, newest wins: a second open closes the first (4001).
//  - `ready` fires once the writer has stayed alive readyMs; an exit before
//    that is a refusal — 3 = the box was never set up (4002), anything else
//    a transport/writer failure (4003). A death after ready is 4003 too.
//  - Never queue audio: a frame is dropped when the child's stdin needs
//    drain, when it is oversize, or when the rolling byte rate exceeds the
//    cap. Stale audio is worthless and a queue is a memory leak.
//  - A link that delivers no frame for stallMs is closed (4004): a stalled
//    feed leaves Claude's reader blocked and its stop hanging.
//  - close() ends stdin (the writer then plays its 2.5 s silence tail and
//    restores the idle capture device) and kills the child killGraceMs later.
//    Nothing here shortens that grace to avoid overlapping a supersede: the
//    box side owns that rule — a starting writer SIGTERMs its predecessor,
//    which then exits with no tail at all (voiceWriter.js).

export const LINK_CLOSE = { superseded: 4001, notSetUp: 4002, writerFailed: 4003, stalled: 4004 };

export function createVoiceLinks({
  openSink,
  readyMs = 300,
  stallMs = 3000,
  killGraceMs = 3000,
  maxFrameBytes = 8192,
  maxBytesPerSec = 65536,
  now = Date.now,
} = {}) {
  const links = new Map();

  function open(boxId, box, { onReady = () => {}, onClose = () => {} } = {}) {
    const prev = links.get(boxId);
    if (prev) prev.close(LINK_CLOSE.superseded, 'superseded');

    const link = { boxId, ready: false, closed: false, dropped: 0 };
    let sink = null;
    let readyTimer = null;
    let stallTimer = null;
    let window = { start: now(), bytes: 0 };
    links.set(boxId, link);

    const clearTimers = () => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    const retire = (s) => {
      try { s.stdin.end(); } catch {}
      const k = setTimeout(() => { try { s.kill(); } catch {} }, killGraceMs);
      k.unref?.();
    };
    const finish = (code, reason) => {
      if (link.closed) return;
      link.closed = true;
      clearTimers();
      // Only the CURRENT holder may vacate the slot: a superseded link closing
      // late must not delete its successor.
      if (links.get(boxId) === link) links.delete(boxId);
      if (sink) retire(sink);
      try { onClose(code, reason); } catch {}
    };
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(LINK_CLOSE.stalled, 'stalled'), stallMs);
    };

    link.close = (code = 1000, reason = 'closed') => finish(code, reason);
    link.write = (frame) => {
      if (!link.ready || link.closed || !sink) { link.dropped++; return false; }
      if (!frame || frame.length > maxFrameBytes) { link.dropped++; return false; }
      const t = now();
      if (t - window.start >= 1000) window = { start: t, bytes: 0 };
      if (window.bytes + frame.length > maxBytesPerSec) { link.dropped++; return false; }
      if (sink.stdin.writableNeedDrain) { link.dropped++; return false; }
      window.bytes += frame.length;
      sink.stdin.write(frame);
      armStall();
      return true;
    };

    (async () => {
      let s;
      try { s = await openSink({ boxId, box }); }
      catch { finish(LINK_CLOSE.writerFailed, 'writer-failed'); return; }
      if (link.closed) { retire(s); return; }
      sink = s;
      s.done.then(({ code }) => {
        if (link.closed) return;
        if (!link.ready && code === 3) finish(LINK_CLOSE.notSetUp, 'not-set-up');
        else finish(LINK_CLOSE.writerFailed, 'writer-failed');
      }).catch(() => finish(LINK_CLOSE.writerFailed, 'writer-failed'));
      readyTimer = setTimeout(() => {
        readyTimer = null;
        if (link.closed) return;
        link.ready = true;
        armStall();
        try { onReady(); } catch {}
      }, readyMs);
    })();

    return link;
  }

  return {
    open,
    has: (boxId) => links.has(boxId),
    closeAll() { for (const l of [...links.values()]) l.close(1001, 'going away'); },
  };
}
