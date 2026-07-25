// Probe an HTTP surface. Every failure path — bad status, missing marker,
// timeout, refused connection — returns ok:false rather than throwing, so the
// runner treats "the target is broken" and "the probe could not run" alike:
// both are the check failing, which is what the operator wants to hear about.
const DEFAULT_STATUS_RANGE = [200, 399];

export async function runHttpCheck(check, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  const started = now();
  const [min, max] = check.assert?.status || DEFAULT_STATUS_RANGE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs || 10000);
  try {
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
