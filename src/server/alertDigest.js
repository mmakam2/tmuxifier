import { formatDigest, LOOP_GUARD_HEADER } from './alertMail.js';

// One plain list a day of everything that stayed below the notification line.
// This is what makes adding a source safe: a new check can be confirmed working
// without ever having interrupted anyone. Retention pruning rides the same pass
// so there is no separate cleanup job and no cron.
const DIGEST_KEY = 'digest';
const DIGEST_REASON = 'digest';

export function createDigestScheduler({
  alertManager, eventLogs = [], decisionLog = null, mailer,
  now = () => Date.now(), retentionDays = 90, digestHourUtc = 8,
  intervalMs = 900000, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let lastSentDay = null;
  let timer = null;

  // "Already sent today" cannot live only in memory: a deploy restart is
  // routine, and every restart past digestHourUtc would send the day's digest
  // again — turning the one message whose whole purpose is to be a calm daily
  // summary into one per restart. So the fact of sending is recorded in the
  // append-only decision log and re-derived here, the same way alertManager.js
  // re-derives its cooldown watermark rather than holding it in memory.
  //
  // The marker deliberately does NOT use reason 'notified': lastNotifiedMap()
  // in alertManager.js starts a cooldown for any decision wearing that reason,
  // so a digest marker would silence a real alert for the whole cooldown window.
  async function sentDayFromLog(dayKey) {
    if (!decisionLog) return null;
    const since = now() - 3 * 86400000;
    const decisions = await decisionLog.readSince(since, now()).catch(() => []);
    return decisions.some((d) => d.key === DIGEST_KEY && d.reason === DIGEST_REASON && d.day === dayKey)
      ? dayKey : null;
  }

  async function tick() {
    const d = new Date(now());
    const dayKey = d.toISOString().slice(0, 10);
    if (d.getUTCHours() < digestHourUtc || lastSentDay === dayKey) return null;
    if (await sentDayFromLog(dayKey)) { lastSentDay = dayKey; return null; }

    const alerts = (await alertManager.listAlerts()).filter((a) => a.reason !== 'notified');
    const { subject, text } = formatDigest(alerts, { dayKey });
    const res = mailer ? await mailer.send({ subject, text, headers: { [LOOP_GUARD_HEADER]: '1' } })
      : { ok: false, error: 'no mailer configured' };

    // Only a delivered digest counts as today's. A relay that refused must not
    // consume the day's single slot, or one transient failure at 08:00 means no
    // digest at all — the same rule alertMail applies to notify:failed.
    if (res?.ok) {
      lastSentDay = dayKey;
      if (decisionLog) {
        await decisionLog.append({
          via: 'digest', source: DIGEST_KEY, key: DIGEST_KEY, norm: null,
          severity: 'info', state: 'resolved', reason: DIGEST_REASON, day: dayKey,
          title: `digest sent for ${dayKey}`, body: '',
        }).catch(() => {});
      }
    }

    for (const log of [...eventLogs, decisionLog].filter(Boolean)) {
      await log.prune(retentionDays).catch(() => []);
    }
    return res;
  }

  return {
    tick,
    async start() {
      await tick().catch(() => null);
      timer = setIntervalFn(() => { tick().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
