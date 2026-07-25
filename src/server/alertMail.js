// This system both sends and receives mail (phase 2 adds the SMTP sink), so
// every outbound message is stamped with a header the sink refuses on the
// way back in. Without it, a relay that bounces or forwards a message back
// to the sink would produce alerts about generating alerts, without end.
// Exported (not a private literal) so the sink imports this exact string
// rather than duplicating it — a typo between the two would silently
// disable the guard.
export const LOOP_GUARD_HEADER = 'X-Tmuxifier-Alert';

// alert.firstTs is null for a resolved alert (see alertFold.js) — never feed
// that into `new Date()` (which would print misleadingly as the epoch, not
// "Invalid Date", but is still meaningless for a fold that has no start).
// Callers guard the call with a truthiness check instead of calling this on
// a possibly-null value.
const iso = (ms) => new Date(ms).toISOString();

// The operator reads this, not the raw event log, so it must carry the fold
// (how many times, first seen, last seen) rather than just the newest
// occurrence — a single 502 looks routine; forty-seven of them since 03:12
// is the actual incident.
export function formatAlertMail(alert, reason) {
  const subject = `[${alert.severity.toUpperCase()}] ${alert.title}`;
  const text = [
    alert.title,
    '',
    `Source: ${alert.source}`,
    `Key: ${alert.key}`,
    `Severity: ${alert.severity}`,
    `Occurrences: ${alert.count}`,
    alert.firstTs ? `First seen: ${iso(alert.firstTs)}` : null,
    alert.lastTs ? `Last seen: ${iso(alert.lastTs)}` : null,
    `Reason: ${reason}`,
    '',
    alert.body || '',
  ].filter((line) => line !== null).join('\n');
  return { subject, text };
}

// The digest is what a `held:below-persistence`/`skipped:info` alert gets
// instead of an interruption — it must still say something explicit when
// there is nothing to report, since a blank mail reads as a broken job, not
// as "nothing happened".
export function formatDigest(alerts, { dayKey }) {
  const subject = `[digest] Tmuxifier alerts for ${dayKey}`;
  const lines = alerts.map((a) => `- [${a.severity}] ${a.title} (x${a.count}, ${a.source})`);
  const text = lines.length
    ? ['Below the notification line today:', '', ...lines].join('\n')
    : 'Nothing below the line today.';
  return { subject, text };
}

// alertManager.js already turns a thrown error into { ok: false, error }
// via .catch(), but this channel returns that shape itself rather than
// relying on the caller's safety net — a channel is expected to report its
// own failures, not merely fail in a way the caller happens to survive.
export function createMailChannel({ mailer }) {
  return {
    name: 'mail',
    async deliver(alert, reason) {
      const { subject, text } = formatAlertMail(alert, reason);
      return mailer.send({ subject, text, headers: { [LOOP_GUARD_HEADER]: '1' } });
    },
  };
}
