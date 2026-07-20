import fsSync from 'node:fs';
import { createHash } from 'node:crypto';

// Download to a temp path, verify the pinned digest, and only then rename into
// place. Streaming rather than buffering: the largest catalog model is ~540 MB
// and buffering it would peak near 1 GB on a 4 GB host. The temp-then-rename
// ordering means a killed download can never leave a truncated file that the
// server would later mmap, and an unverified blob never occupies the real path.
export async function downloadVerified({ url, dest, sha256, fetchImpl = fetch }) {
  const tmp = `${dest}.part`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const hash = createHash('sha256');
  const out = fsSync.createWriteStream(tmp, { mode: 0o600 });
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      // Respect backpressure: without this a fast link outruns the disk and
      // the whole body accumulates in memory, defeating the point of streaming.
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const got = hash.digest('hex');
    if (got !== sha256) throw new Error(`integrity check failed: expected ${sha256}, got ${got}`);
    fsSync.renameSync(tmp, dest);
    return { ok: true };
  } catch (e) {
    try { out.destroy(); } catch {}
    try { fsSync.unlinkSync(tmp); } catch {}
    throw e;
  }
}
