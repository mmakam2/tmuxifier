// Assert on one field of a JSON API response. Covers the node-dashboard cases
// (online score, QUIC status, free disk) and token-validity probes, where the
// interesting signal is a field value rather than an HTTP status.

// Own keys only. A bare acc[part] resolves inherited properties — 'constructor',
// 'toString', '__proto__' — on every object alive, so such a path would yield a
// truthy value the response never contained, and with no assertion configured
// that is a straight ok:true on a field that does not exist. A false green is
// the one outcome this system cannot afford, so a path that leaves the object's
// own keys reads as missing.
export function pickPath(obj, path) {
  return String(path).split('.').reduce((acc, part) => (
    acc !== null && acc !== undefined && typeof acc === 'object'
      && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined
  ), obj);
}

function evaluate(value, assert) {
  if (value === undefined) return { ok: false, detail: `field missing from response` };
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (assert.equals !== undefined && String(value) !== String(assert.equals)) {
    return { ok: false, detail: `expected ${assert.equals}, got ${shown}` };
  }
  if (assert.notEquals !== undefined && String(value) === String(assert.notEquals)) {
    return { ok: false, detail: `expected anything but ${assert.notEquals}, got ${shown}` };
  }
  // Negated rather than direct comparisons, so a non-numeric value or bound
  // (Number('abc') is NaN, and every comparison with NaN is false) fails the
  // check instead of passing it.
  if (assert.greaterThan !== undefined && !(Number(value) > Number(assert.greaterThan))) {
    return { ok: false, detail: `expected > ${assert.greaterThan}, got ${shown}` };
  }
  if (assert.lessThan !== undefined && !(Number(value) < Number(assert.lessThan))) {
    return { ok: false, detail: `expected < ${assert.lessThan}, got ${shown}` };
  }
  return { ok: true, detail: shown };
}

export async function runJsonCheck(check, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  const started = now();
  const controller = new AbortController();
  let timer;
  // Held outside the try so the catch can word a timeout without re-reading
  // `check` — the throw it is handling may well be a malformed `check`.
  let timeoutMs = 10000;
  try {
    // Nothing is read off `check` above this line: the timer setup reads
    // check.timeoutMs, and hoisting it out of the guard (as the brief did)
    // turns a malformed stored definition into a synchronous throw that no
    // catch here can see, taking the runner's whole due cycle with it.
    timeoutMs = check?.timeoutMs || 10000;
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(check.target.url, {
      signal: controller.signal,
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    const payload = await res.json();
    const { ok, detail } = evaluate(pickPath(payload, check.target.path), check.assert || {});
    return { ok, detail: `${check.target.path}: ${detail}`, latencyMs: now() - started };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      detail: aborted ? `timed out after ${timeoutMs}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
