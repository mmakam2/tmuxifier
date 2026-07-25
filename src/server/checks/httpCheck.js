// Probe an HTTP surface. Every failure path — bad status, missing marker,
// timeout, refused connection — returns ok:false rather than throwing, so the
// runner treats "the target is broken" and "the probe could not run" alike:
// both are the check failing, which is what the operator wants to hear about.
import { requestCheck, resolveCheckTls } from './tlsRequest.js';

const DEFAULT_STATUS_RANGE = [200, 399];

// checkTypes.js (Task 5) shallow-copies `assert` without validating what's
// inside it, and data/checks.json is a mutable file on disk regardless — so a
// stored check's `assert.status` is not guaranteed to be a [min, max] tuple by
// the time it reaches here. A merely-iterable-but-wrong shape ([500], [], a
// string) doesn't throw, so the try/catch below can't catch it: it silently
// corrupts the comparison instead (e.g. [500] leaves max undefined, and
// `res.status > undefined` is always false, so every status >= 500 passes).
// That's worse than a crash — a false ok:true is exactly the "the outage went
// unreported" failure this whole system exists to prevent. So this is the
// executor's own last line of defense: anything that isn't unambiguously a
// two-number range is treated as absent and falls back to the default range,
// the same way an actually-absent assert.status already does.
function resolveStatusRange(status) {
  if (Array.isArray(status) && status.length === 2 && Number.isFinite(status[0]) && Number.isFinite(status[1])) {
    return status;
  }
  return DEFAULT_STATUS_RANGE;
}

export async function runHttpCheck(check, { now = () => Date.now(), requestImpl = requestCheck } = {}) {
  const started = now();
  // Held outside the try so the catch can word a timeout without re-reading
  // `check` — the throw it is handling may well be a malformed `check`.
  let timeoutMs = 10000;
  try {
    const [min, max] = resolveStatusRange(check.assert?.status);
    timeoutMs = check.timeoutMs || 10000;
    // node:http/https rather than fetch, so an internal HTTPS service can be
    // trusted by pin or explicitly waived (see tlsRequest.js). Redirects are
    // never followed: reporting the target's 200 would hide that the checked
    // URL itself has started redirecting, which is exactly the drift a check
    // should surface.
    const res = await requestImpl({
      url: check.target.url,
      timeoutMs,
      tls: resolveCheckTls(check, check.target.url),
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    if (res.status < min || res.status > max) {
      return { ok: false, detail: `HTTP ${res.status} (expected ${min}-${max})`, latencyMs: now() - started };
    }
    if (check.assert?.bodyIncludes && !res.text.includes(check.assert.bodyIncludes)) {
      return { ok: false, detail: `body did not contain "${check.assert.bodyIncludes}"`, latencyMs: now() - started };
    }
    return { ok: true, detail: `HTTP ${res.status}`, latencyMs: now() - started };
  } catch (e) {
    // The timedOut marker is set only by our own timeout handler, so it
    // unambiguously means "too slow to answer" — every other rejection
    // (ECONNREFUSED, DNS failure, a TLS pin mismatch, a requestImpl that throws
    // outright) is a distinct failure mode and must not be worded the same way.
    return {
      ok: false,
      detail: e?.timedOut ? `timed out after ${timeoutMs}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  }
}
