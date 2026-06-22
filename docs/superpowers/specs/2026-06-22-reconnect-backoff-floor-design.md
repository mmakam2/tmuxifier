# Terminal Reconnect Backoff Floor Design

## Summary

The browser terminal (`src/web/terminal.ts`) auto-reconnects when its `/term` WebSocket
closes. Today the reconnect delay (`backoff`, 500ms doubling to a 5s cap) is reset on every
`ws.onopen` — but the WebSocket connects to the Tmuxifier server (always up), not to the box,
so `onopen` fires every cycle and the backoff never accumulates. For an unreachable box, the
interactive `ssh` fails at the `ConnectTimeout` (~10s) and the client retries ~500ms later,
producing a steady ~10s reconnect loop forever (≈6 attempts/min) while the tab is open — enough
to trip a box's connection-rate limiter.

This change makes the reconnect delay escalate to a **5-minute floor that never fully stops**,
and keys the reset off a connection that proves *stable* rather than off `onopen`. A down box
settles to ~1 attempt / 5 min (gentle, comparable to the status probe), and a box that comes back
auto-reconnects within ≤5 min — the dot was already self-healing via the separate status probe;
now the terminal does too. No hard "give up" state.

## Behavior

- On WebSocket close (not user-initiated): increment a consecutive-failure counter and schedule
  the next reconnect after `reconnectDelay(failures)`.
- `reconnectDelay(n)` = `min(baseMs * 2^(n-1), capMs)`, with `baseMs = 1000`, `capMs = 300000`
  (5 min). So delays grow 1s → 2s → 4s → … and settle at a steady 5-minute floor. It never
  returns Infinity / never stops.
- Reset (`failures = 0`) only when a connection proves **stable**: the WebSocket stays open longer
  than `STABLE_MS = 15000` (15s, safely above the 10s `ConnectTimeout`). A failed connect closes at
  ~10s — before the stable timer — so it correctly counts as a failure and the timer is cleared.
- `closedByUser` (tab close / `dispose`) still stops reconnection entirely, as today.
- The "[disconnected — reconnecting…]" line shows the human-readable retry delay (e.g. "retrying in
  5m") so the backoff is visible, not a mystery.

## Architecture

- New pure module `src/web/reconnect.ts` exporting `reconnectDelay(failures, { baseMs?, capMs? })`.
  Pure and deterministic → unit-tested without a DOM.
- `src/web/terminal.ts` replaces the `backoff` variable with a `failures` counter + a `stableTimer`,
  calls `reconnectDelay(failures)` on close, and resets `failures` from the stable timer set in
  `ws.onopen`. `dispose()` clears the stable timer.

## Error handling

No new failure surfaces. If `reconnectDelay` is somehow called with a non-positive count it clamps
to 1 (base delay). The reconnect loop is unchanged except for timing; a working box that briefly
drops reconnects fast (first failure = 1s) and resets once stable.

## Testing

- Unit-test `reconnectDelay` (Vitest, `test/reconnect.test.js`): base/escalation values (1s, 2s,
  4s), monotonic growth, caps at 5 min and never exceeds it (e.g. `reconnectDelay(100) === 300000`),
  custom opts respected.
- `terminal.ts` wiring (DOM/xterm) has no unit harness — verified by `npm run build` (type-check) and
  live: drive a down box and confirm the reconnect interval grows to the 5-minute floor (no ~10s
  loop), and that the terminal auto-reconnects when the box returns.
