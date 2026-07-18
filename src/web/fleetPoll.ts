// Generation-guarded poll loop for the fleet job detail view. Exactly one job
// is "watched" at a time; any response (initial load or poll tick) that lands
// after the user has switched jobs is discarded, so a stale response can never
// paint over — or stop the polling of — the newer selection. DOM concerns are
// injected: render() returns false when the detail view is gone, which ends
// the loop.
type FleetPollDeps<J extends { status: string }> = {
  fetchJob: (id: string) => Promise<J>;
  render: (job: J) => boolean;
  renderError: () => void;
  onFinished: () => void;
  intervalMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export function createFleetPoller<J extends { status: string }>({
  fetchJob,
  render,
  renderError,
  onFinished,
  intervalMs = 1500,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}: FleetPollDeps<J>) {
  let jobId: string | null = null;
  let timer: unknown = null;

  function stop() {
    if (timer != null) { cancel(timer); timer = null; }
    jobId = null;
  }

  function arm(id: string) {
    timer = schedule(() => { void tick(id); }, intervalMs);
  }

  async function tick(id: string) {
    let job: J;
    try {
      job = await fetchJob(id);
    } catch {
      if (jobId === id) arm(id); // transient fetch error — keep trying
      return;
    }
    if (jobId !== id) return; // stale response — a newer selection owns the view
    if (!render(job)) { stop(); return; }
    if (job.status === 'running') arm(id);
    else { stop(); onFinished(); }
  }

  async function show(id: string) {
    stop();
    jobId = id;
    let job: J;
    try {
      job = await fetchJob(id);
    } catch {
      if (jobId === id) { renderError(); jobId = null; }
      return;
    }
    if (jobId !== id) return; // superseded while loading
    render(job);
    if (job.status === 'running') arm(id);
    else jobId = null; // settled view — nothing to poll
  }

  return { show, stop, watching: () => jobId };
}
