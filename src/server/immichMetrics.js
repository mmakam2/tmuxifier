// Pure shaping of Immich API payloads into the metrics object the dashboard
// card renders. No I/O lives here, so every layout decision the card depends on
// is testable without a server — the same model/DOM split unifiMetrics.js uses.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Immich reports "v3.0.3" from /server/about but a bare "3.0.3" is a plausible
// shape from /server/version-check, and a prefix mismatch must not read as an
// available update.
const normVersion = (v) => String(v ?? '').trim().replace(/^v/i, '');
const str = (v) => (v == null || v === '' ? null : String(v));

// One rollup across every queue the server reports — fifteen on v3.0.3, and the
// list grows between releases, so this iterates rather than naming them.
export function buildJobRollup(jobs) {
  const out = { active: 0, waiting: 0, failed: 0, paused: [] };
  if (!jobs || typeof jobs !== 'object') return out;
  for (const [name, queue] of Object.entries(jobs)) {
    if (!queue || typeof queue !== 'object') continue;
    const counts = queue.jobCounts || {};
    out.active += num(counts.active) ?? 0;
    // A delayed job is queued work that has not run yet; folding it into
    // waiting is what keeps the backlog figure honest.
    out.waiting += (num(counts.waiting) ?? 0) + (num(counts.delayed) ?? 0);
    out.failed += num(counts.failed) ?? 0;
    // Named rather than counted: a tally cannot tell you which queue to restart.
    if (queue.queueStatus?.isPaused === true) out.paused.push(name);
  }
  return out;
}

export function buildMetrics({
  about = null, storage = null, statistics = null,
  jobs = null, versionCheck = null, config = null, denied = [],
} = {}) {
  const version = str(about?.version);
  const releaseVersion = str(versionCheck?.releaseVersion);
  const byUser = Array.isArray(statistics?.usageByUser) ? statistics.usageByUser : null;
  // The largest consumer, so the row points at something rather than merely
  // counting. /api/users is deliberately never called — it returns email
  // addresses, and usageByUser already carries the names.
  const top = byUser?.length
    ? byUser.reduce((best, u) => ((num(u?.usage) ?? 0) > (num(best?.usage) ?? -1) ? u : best), null)
    : null;
  const pct = num(storage?.diskUsagePercentage);

  return {
    version,
    releaseVersion,
    updateAvailable: !!(version && releaseVersion && normVersion(version) !== normVersion(releaseVersion)),
    checkedAt: str(versionCheck?.checkedAt),
    photos: num(statistics?.photos),
    videos: num(statistics?.videos),
    libraryBytes: num(statistics?.usage),
    users: byUser ? byUser.length : null,
    topUser: top ? { name: str(top.userName) ?? 'unknown', bytes: num(top.usage) } : null,
    diskUsedBytes: num(storage?.diskUseRaw),
    diskSizeBytes: num(storage?.diskSizeRaw),
    diskFreeBytes: num(storage?.diskAvailableRaw),
    // The server reports a float (39.06); a dashboard row has no use for it.
    diskUsedPct: pct == null ? null : Math.round(pct),
    // null means "this key may not read the queues", which is a different
    // statement from a rollup of zeroes meaning "the queues are idle".
    jobs: jobs == null ? null : buildJobRollup(jobs),
    maintenanceMode: config?.maintenanceMode === true,
    denied: [...denied],
  };
}
