import { test, expect } from 'vitest';
import { formatAlertMail, formatDigest, createMailChannel, LOOP_GUARD_HEADER } from '../src/server/alertMail.js';

const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'critical', state: 'firing',
  count: 47, recentCount: 12, firstTs: Date.parse('2026-07-25T03:12:00Z'),
  lastTs: Date.parse('2026-07-25T06:40:00Z'), title: 'Invoice app: HTTP 502',
  body: 'gateway timeout', ...over,
});

test('the loop-guard header name is the exact string the future sink will match on', () => {
  // Phase 2's sink imports this constant rather than a duplicated literal;
  // pinning the value here means a change to it is a deliberate, visible edit.
  expect(LOOP_GUARD_HEADER).toBe('X-Tmuxifier-Alert');
});

test('the subject leads with severity so a mail client can sort on it', () => {
  expect(formatAlertMail(alert(), 'notified').subject).toBe('[CRITICAL] Invoice app: HTTP 502');
});

test('the body carries the fold, not just the latest occurrence', () => {
  const { text } = formatAlertMail(alert(), 'notified');
  expect(text).toContain('Occurrences: 47');
  expect(text).toContain('First seen: 2026-07-25T03:12:00.000Z');
  expect(text).toContain('Last seen: 2026-07-25T06:40:00.000Z');
  expect(text).toContain('Source: check:c1');
});

test('the body identifies the alert key and severity, not just its title', () => {
  const { text } = formatAlertMail(alert(), 'notified');
  expect(text).toContain('Key: check:c1');
  expect(text).toContain('Severity: critical');
});

test('the body includes the underlying check output, not just the fold metadata', () => {
  expect(formatAlertMail(alert(), 'notified').text).toContain('gateway timeout');
});

test('the body states the policy reason, so the mail explains why it arrived', () => {
  expect(formatAlertMail(alert(), 'notified').text).toContain('Reason: notified');
});

test('a resolved alert (firstTs null) formats without crashing or emitting Invalid Date', () => {
  const resolved = alert({ state: 'resolved', count: 0, firstTs: null, lastTs: Date.parse('2026-07-25T06:40:00Z') });
  const { text } = formatAlertMail(resolved, 'notified');
  expect(text).not.toContain('Invalid Date');
  expect(text).not.toContain('First seen');
  expect(text).toContain('Last seen: 2026-07-25T06:40:00.000Z');
});

test('a digest lists withheld alerts one per line and names the day', () => {
  const { subject, text } = formatDigest(
    [alert({ severity: 'info', title: 'Backup ran long', count: 2 })],
    { dayKey: '2026-07-25' },
  );
  expect(subject).toBe('[digest] Tmuxifier alerts for 2026-07-25');
  expect(text).toContain('Backup ran long');
  expect(text).toContain('x2');
});

test('a digest with multiple alerts keeps each on its own line', () => {
  const { text } = formatDigest(
    [
      alert({ key: 'check:a', title: 'Alert A', severity: 'info', count: 2 }),
      alert({ key: 'check:b', title: 'Alert B', severity: 'warning', count: 5 }),
    ],
    { dayKey: '2026-07-25' },
  );
  const lines = text.split('\n');
  expect(lines.some((l) => l.includes('Alert A'))).toBe(true);
  expect(lines.some((l) => l.includes('Alert B'))).toBe(true);
  // Each alert gets its own line, not concatenated onto one.
  expect(lines.find((l) => l.includes('Alert A'))).not.toContain('Alert B');
});

test('an empty digest says so plainly rather than sending a blank message', () => {
  expect(formatDigest([], { dayKey: '2026-07-25' }).text).toContain('Nothing below the line');
});

test('the mail channel is named mail', () => {
  const channel = createMailChannel({ mailer: { send: async () => ({ ok: true, error: null }) } });
  expect(channel.name).toBe('mail');
});

test('every message carries the loop-guard header', async () => {
  const sent = [];
  const channel = createMailChannel({ mailer: { send: async (m) => { sent.push(m); return { ok: true, error: null }; } } });
  await channel.deliver(alert(), 'notified');
  expect(sent[0].headers[LOOP_GUARD_HEADER]).toBe('1');
});

test('the channel forwards the actual alert and reason into the sent message, not fixed text', async () => {
  const sent = [];
  const channel = createMailChannel({ mailer: { send: async (m) => { sent.push(m); return { ok: true, error: null }; } } });
  await channel.deliver(alert({ title: 'Distinctive title xyz' }), 'suppressed:cooldown');
  expect(sent[0].subject).toContain('Distinctive title xyz');
  expect(sent[0].text).toContain('Reason: suppressed:cooldown');
});

test('a mailer failure surfaces as a channel failure rather than an exception', async () => {
  const channel = createMailChannel({ mailer: { send: async () => ({ ok: false, error: 'relay down' }) } });
  expect(await channel.deliver(alert(), 'notified')).toEqual({ ok: false, error: 'relay down' });
});
