import type { Sample } from './api';

// Build an SVG path `d` for a metric series. Coordinates map i→x left-to-right
// and value→y (inverted, 0 at the bottom). A missing metric is a gap: the pen
// lifts and a new subpath (M) starts after it, so a down box shows a break, not
// a line to zero. Returns '' when fewer than two points can be plotted.
export function sparkline(
  samples: Sample[],
  metric: 'cpuPct' | 'memPct' | 'diskPct',
  opts: { w?: number; h?: number; max?: number } = {},
): string {
  const w = opts.w ?? 64, h = opts.h ?? 16, max = opts.max ?? 100;
  const vals = samples.map((s) => s[metric]);
  const plotted = vals.filter((v) => v != null).length;
  if (plotted < 2) return '';
  const n = vals.length;
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * (w - 1)) + 0.5;
  const y = (v: number) => h - 0.5 - (Math.max(0, Math.min(max, v)) / max) * (h - 1);
  let d = ''; let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    if (!pen && (i + 1 >= n || vals[i + 1] == null)) {
      // Isolated point between gaps: a move-only subpath strokes nothing (butt
      // caps), so draw a short clamped tick to keep the sample visible.
      const cy = y(v).toFixed(1);
      d += `M${Math.max(0, x(i) - 0.6).toFixed(1)},${cy} L${Math.min(w, x(i) + 0.6).toFixed(1)},${cy} `;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}
