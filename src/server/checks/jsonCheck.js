import { requestCheck, resolveCheckTls } from './tlsRequest.js';

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

export async function runJsonCheck(check, { now = () => Date.now(), requestImpl = requestCheck } = {}) {
  const started = now();
  // Held outside the try so the catch can word a timeout without re-reading
  // `check` — the throw it is handling may well be a malformed `check`.
  let timeoutMs = 10000;
  try {
    // Nothing is read off `check` above this line: a malformed stored
    // definition must surface as a failed check, not as a synchronous throw
    // that no catch here can see, which would take the runner's whole due
    // cycle with it.
    timeoutMs = check?.timeoutMs || 10000;
    // node:http/https rather than fetch, so a JSON API behind a private CA can
    // be trusted by pin or explicitly waived (see tlsRequest.js).
    const res = await requestImpl({
      url: check.target.url,
      timeoutMs,
      tls: resolveCheckTls(check, check.target.url),
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    // Throws on a non-JSON body, which the catch turns into a failed check —
    // an endpoint serving an HTML error page is not a healthy JSON API.
    const payload = JSON.parse(res.text);
    const { ok, detail } = evaluate(pickPath(payload, check.target.path), check.assert || {});
    return { ok, detail: `${check.target.path}: ${detail}`, latencyMs: now() - started };
  } catch (e) {
    return {
      ok: false,
      detail: e?.timedOut ? `timed out after ${timeoutMs}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  }
}
