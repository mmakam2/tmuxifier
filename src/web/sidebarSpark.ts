// Whether sidebar box rows draw the CPU/memory/disk sparkline. Off by default.
//
// The value is owned by the server (data/ui-settings.json, key `sidebarSpark`):
// main.ts `loadUiSettings` seeds it on every path into the workspace and
// settingsAppearance.ts flips it. It lives in its own module because the
// settings tab cannot import main.ts; main.ts subscribes to repaint the rows
// and the metric highlight when it changes.
export type SparkMetric = 'cpuPct' | 'memPct' | 'diskPct';

let on = false;
const listeners = new Set<() => void>();

export function sidebarSparkOn(): boolean { return on; }

export function setSidebarSpark(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const cb of [...listeners]) cb();
}

export function onSidebarSparkChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// The class on the box list that pairs the graphed metric with its meta-line
// figure (see the .spark-* CSS). With the graph off there is nothing to name,
// and no click to change which figure is lit, so no class at all.
export function sparkListClass(enabled: boolean, metric: SparkMetric): 'spark-cpu' | 'spark-mem' | 'spark-disk' | null {
  if (!enabled) return null;
  return `spark-${metric.replace('Pct', '')}` as 'spark-cpu' | 'spark-mem' | 'spark-disk';
}
