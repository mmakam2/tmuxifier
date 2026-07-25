// Probe an HTTP surface. Every failure path — bad status, missing marker,
// timeout, refused connection — returns ok:false rather than throwing, so the
// runner treats "the target is broken" and "the probe could not run" alike:
// both are the check failing, which is what the operator wants to hear about.
const DEFAULT_STATUS_RANGE = [200, 399];

export async function runHttpCheck(check, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  const started = now();
  const controller = new AbortController();
  let timer;
  try {
    // checkTypes.js (Task 5) shallow-copies `assert` without validating what's
    // inside it, so a stored check's `assert.status` could in principle be
    // anything — not just the [min, max] tuple callers are expected to send.
    // Destructuring that here, before the try, would let a malformed value
    // (e.g. a bare number) throw "is not iterable" straight out of this
    // function, breaking the one guarantee this executor exists to make.
    // Keeping it inside the try means that failure is just another ok:false.
    const [min, max] = check.assert?.status || DEFAULT_STATUS_RANGE;
    timer = setTimeout(() => controller.abort(), check.timeoutMs || 10000);
    const res = await fetchImpl(check.target.url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
    });
    const body = check.assert?.bodyIncludes ? await res.text() : '';
    if (res.status < min || res.status > max) {
      return { ok: false, detail: `HTTP ${res.status} (expected ${min}-${max})`, latencyMs: now() - started };
    }
    if (check.assert?.bodyIncludes && !body.includes(check.assert.bodyIncludes)) {
      return { ok: false, detail: `body did not contain "${check.assert.bodyIncludes}"`, latencyMs: now() - started };
    }
    return { ok: true, detail: `HTTP ${res.status}`, latencyMs: now() - started };
  } catch (e) {
    // AbortError is the only way our own timer's abort() surfaces here, so it
    // unambiguously means "timed out" — every other rejection (ECONNREFUSED,
    // DNS failure, a fetchImpl that throws outright) is a distinct failure
    // mode and must not be worded the same way.
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      detail: aborted ? `timed out after ${check.timeoutMs || 10000}ms` : (e?.message || 'request failed'),
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
