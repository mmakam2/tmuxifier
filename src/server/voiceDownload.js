import fsSync from 'node:fs';
import { createHash } from 'node:crypto';

// Download to a temp path, verify the pinned digest, and only then rename into
// place. Streaming rather than buffering: the largest catalog model is ~540 MB
// and buffering it would peak near 1 GB on a 4 GB host. The temp-then-rename
// ordering means a killed download can never leave a truncated file that the
// server would later mmap, and an unverified blob never occupies the real path.
//
// `stallMs` bounds *inactivity*, not total duration: a 540 MB model over a slow
// link is legitimate and must not be killed, but a TCP stall must not hang the
// install job forever. It used to — the job stayed `running`, single-flighting
// blocked every retry, there is no cancel route, and the ship checklist gates
// restarts on no job being `running`, so the wedged job argued against the only
// action that cleared it.
export async function downloadVerified({ url, dest, sha256, fetchImpl = fetch, stallMs = 60_000 }) {
  const tmp = `${dest}.part`;
  const controller = new AbortController();
  let timer = null;
  let stalled = false;

  // Re-armed on every chunk. Firing aborts the request (so the socket is torn
  // down rather than left dangling) and unblocks the read below.
  const arm = (onFire) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      try { controller.abort(); } catch { /* already aborted */ }
      onFire?.();
    }, stallMs);
  };
  const stallError = () => new Error(`download stalled: no data for ${Math.round(stallMs / 1000)}s`);

  // The read is raced against the timer explicitly rather than relying on the
  // body stream to honour the abort signal: a stream that ignores it would
  // otherwise leave this await pending forever, which is the bug being fixed.
  const race = (promise) => new Promise((resolve, reject) => {
    arm(() => reject(stallError()));
    promise.then(resolve, reject);
  });

  let out = null;
  try {
    const res = await race(Promise.resolve().then(() => fetchImpl(url, { signal: controller.signal })));
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

    const hash = createHash('sha256');
    out = fsSync.createWriteStream(tmp, { mode: 0o600 });
    const reader = res.body[Symbol.asyncIterator]();
    for (;;) {
      const { value, done } = await race(reader.next());
      if (done) break;
      hash.update(value);
      // Respect backpressure: without this a fast link outruns the disk and
      // the whole body accumulates in memory, defeating the point of streaming.
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const got = hash.digest('hex');
    if (got !== sha256) throw new Error(`integrity check failed: expected ${sha256}, got ${got}`);
    fsSync.renameSync(tmp, dest);
    return { ok: true };
  } catch (e) {
    try { out?.destroy(); } catch {}
    try { fsSync.unlinkSync(tmp); } catch {}
    // A fetch aborted by our own timer surfaces as the abort, not the stall, so
    // report the cause the operator can act on.
    throw stalled ? stallError() : e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
