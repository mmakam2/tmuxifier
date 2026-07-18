// Generation-guarded poll loop shared by the two setup-job viewers — the
// provision panel (main.ts) and the Proxmox hub's Provision tab (proxmoxUi.ts)
// — which previously each hand-rolled the same timer/generation bookkeeping.
// The rendering chrome stays with each caller: the injected onJob policy
// renders and returns the next poll delay in milliseconds, or null to stop.
// A response that lands after stop() or a restart is discarded, and a
// rejected fetch reaches the policy as null (transient-error handling is the
// caller's decision).
export function createSetupJobPoller<J>({
  fetchJob,
  onJob,
  schedule = (fn, ms) => window.setTimeout(fn, ms),
  cancel = (timer) => window.clearTimeout(timer as number),
}: {
  fetchJob: () => Promise<J | null>;
  onJob: (job: J | null) => number | null;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}): { start: () => void; stop: () => void } {
  let gen = 0;
  let timer: unknown = null;

  const stop = () => {
    gen += 1;
    if (timer != null) { cancel(timer); timer = null; }
  };

  const start = () => {
    stop();
    const my = gen;
    const tick = async () => {
      let job: J | null = null;
      try { job = await fetchJob(); } catch { job = null; }
      if (my !== gen) return; // stopped or restarted while the fetch was in flight
      const delay = onJob(job);
      if (delay != null) timer = schedule(() => { void tick(); }, delay);
    };
    void tick();
  };

  return { start, stop };
}
