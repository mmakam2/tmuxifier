# Alert aggregation and triage — design

Date: 2026-07-25
Status: design agreed, phase 1 ready for an implementation plan

## Problem

Alerts for production workloads, homelab services, and infrastructure currently arrive as SMTP
mail in a single inbox. Two failures follow from that:

1. **Repeats drown the signal.** One problem re-alerts on the sender's own schedule, so a single
   issue becomes dozens of messages and the inbox stops being readable.
2. **The rare important thing is indistinguishable** from routine mail, because email gives every
   message identical weight.

The operator's stated goal is not only to tame the current volume but to make it *safe to add many
more sources*. Attention cost must not scale with source count, or the system will not be extended.

A third problem surfaced during design and turned out to dominate the first two. The conditions the
operator actually needs to know about mostly **produce no message at all when they fail**:

- Backups that do not run — nothing emails you about a cron job that never fired.
- An integration whose OAuth connection silently expires (for example an accounting integration on
  a customer-facing invoicing app), discovered later by a customer.
- Customer-facing web surfaces returning errors — no appliance mails you about that.
- A dual-WAN gateway where transient failover is *normal* and only a sustained outage matters.
- Storage/node workloads (Storj, Mysterium) with continuous conditions — QUIC reachability, disk
  pressure, online score — rather than discrete notifications.

The dominant operational risk is therefore **silence, not noise**. A design that only filters
inbound mail would deliver none of the above.

## Goals

- One place to see everything, with history that is searchable.
- Adding a source is free: it is captured and visible immediately, and cannot interrupt anyone
  until it clears an explicit bar.
- Conditions that fail silently are actively detected.
- What did and did not notify is auditable, with a reason for every decision.
- No new attack surface on the process that holds SSH access to the whole fleet.

## Non-goals

- **Real-time correlation / incident clustering.** Storms from a single root cause are not a
  current pain. Grouping is a later, retrospective, read-path feature (phase 4) and never
  suppresses delivery.
- **On-call scheduling, escalation policies, paging rotations.** Single operator.
- **Multi-user, roles, or tenancy.** Tmuxifier is single-user by design.
- **Metrics storage or graphing.** This system stores events and check results, not time series.
  Existing box health sparklines already cover per-box resource trends.
- **Replacing the inbox for everything.** Mail that is not an alert stays in mail.

## Key decisions

### 1. Silence is the primary enemy, so pull comes before push

Phase 1 is the check runner, not the mail sink. Active checks and heartbeats address the operator's
stated risks directly, and — unlike inbound mail — they carry explicit stable identities, so phase 1
contains none of the heuristic subject-parsing guesswork.

### 2. Three input classes, one pipeline

| Class | Mechanism | Examples |
| --- | --- | --- |
| **Checks** (pull) | Scheduled probe, emits on failure, resolves on recovery | HTTP surfaces, TLS expiry, TCP reachability, JSON field assertions, on-box commands |
| **Heartbeats** (absence) | Job checks in on success; absence within a window is the event | Backups, nightly jobs, anything cron-driven |
| **Events** (push) | Sender delivers a message | SMTP from appliances, webhooks |

All three normalize to one event shape. Everything downstream — dedup, policy, delivery, UI — is
shared and unaware of which class produced an event.

### 3. Deterministic rules decide interruption; a model never does

Any AI assistance (phase 4) sits on the **read path**: summarizing and grouping what has already
happened, after delivery decisions are final. A hallucination costs a paragraph, never an alert. An
unpredictable classifier is what makes operators stop trusting an alert system, which is the exact
failure this project exists to prevent.

### 4. Two processes, split by exposure, one repository

The dashboard holds SSH access to the whole fleet and binds loopback by default. Accepting
unauthenticated input from every appliance on the network in that process is a material change to
its security posture. So inbound listeners move to a separate, minimal daemon that holds no
credentials. Both ship from one repository, one test suite, one deploy.

### 5. Append-only files, single writer per file

Node 20 has no `node:sqlite` (`require('node:sqlite')` throws `ERR_UNKNOWN_BUILTIN_MODULE`), and
adding a native SQLite dependency is a real cost for a five-dependency project. It is also
unnecessary: giving each process exclusive ownership of the files it writes removes the need for
locking, IPC, or a shared-store library entirely.

Events are appended and never mutated. An alert — "one problem, 47 occurrences, first seen 03:12,
last seen 06:40" — is a **fold over the log by key**, computed at read time. This is why the dedup
requirement does not need updatable rows.

If volume ever outgrows this, the store sits behind a small interface and swapping in SQLite is a
contained change.

## Architecture

### Processes

**`tmuxifier-ingest`** — hostile-input-facing, holds nothing sensitive: no SSH keys, no cookie
secret, no box store, no Proxmox/NetBox credentials. Binds a LAN address. Its only job is to accept
input and append it.

- Phase 1: the heartbeat endpoint only.
- Phase 2: SMTP sink and generic webhook receiver.
- Writes: `data/events/inbound-YYYY-MM-DD.ndjson`.

**`tmuxifier`** (the existing dashboard) — keeps its current loopback posture and its existing
credential handling. Runs the check runner (outbound only), the policy engine, delivery, and the UI.

- Writes: `data/events/checks-YYYY-MM-DD.ndjson`, `data/events/decisions-YYYY-MM-DD.ndjson`,
  `data/checks.json`, `data/alert-rules.json`, `data/alert-triage.json`.

Each process reads the other's files and writes none of them. Appends of modest lines under
`O_APPEND` are atomic; the reader only ever tails files it does not touch.

### Files

| Path | Writer | Contents |
| --- | --- | --- |
| `data/events/checks-*.ndjson` | dashboard | Check-produced occurrences, including heartbeat misses |
| `data/events/inbound-*.ndjson` | ingest | Heartbeat check-ins; later, mail and webhooks |
| `data/events/decisions-*.ndjson` | dashboard | One line per policy evaluation, with reason code |
| `data/checks.json` | dashboard | Check definitions; credentials sealed |
| `data/alert-rules.json` | dashboard | Mutes, per-source overrides, threshold overrides |
| `data/alert-triage.json` | dashboard | Ack marks and read state |
| `data/ingest-heartbeat.json` | ingest | Liveness stamp the dashboard reads |

All gitignored, all `0o600`, all created at runtime, consistent with the existing self-contained
model. New `.env` knobs are documented in `.env.example` in the same change that introduces them.

Note the asymmetry: ingest records heartbeat *check-ins*, while a heartbeat *miss* is derived by the
dashboard's policy loop and appended to the dashboard's own log. Absence cannot be observed by the
process that only ever sees arrivals.

### Retention

Day-partitioned files are pruned after 90 days by the process that owns them, at the first write
following a midnight rollover. No separate cleanup job and no cron. The decision log is pruned on
the same schedule as the event logs, so an alert and the record of why it did or did not notify
always expire together.

### Data model

An occurrence line:

```json
{"id":"1753440000123-7","ts":1753440000123,"via":"check","source":"check:invoice-app",
 "key":"check:invoice-app","norm":null,"severity":"critical","state":"firing",
 "title":"HTTP 502 from https://invoices.example.com/health","body":"…"}
```

`norm` carries the normalized text a derived key was computed from (phase 2, inbound mail), stored
so that a wrong merge is diagnosable rather than mysterious. Check-produced events have explicit
keys and leave it null.

## Input class 1: checks

A check is a stored definition; credentials are sealed with `secretBox.js` and redacted on read, as
`netboxStore.js` already does for the NetBox token.

### Types

| Type | Purpose |
| --- | --- |
| `http` | URL, expected status range, optional body substring/regex, optional TLS-expiry threshold. Covers customer-facing surfaces and status endpoints. |
| `tcp` | Connect to host:port. Reachability where HTTP semantics do not apply. |
| `json` | Fetch with optional auth header, assert on a field (`$.online_score < 0.95`, `$.quic == "OK"`, `$.disk_free_pct > 10`). Covers node dashboards and API-token validity probes. |
| `exec` | Run a command on a box over the existing ControlMaster. Non-zero exit, or a stdout assertion, fails the check. |
| `heartbeat` | No outbound work; see the next section. Stored in `data/checks.json` alongside the others, so one definition list, one UI, one policy path. |

`exec` carries most of the node-workload coverage at almost no cost: `boxActions.execCommand`
already runs commands on every box over an authenticated multiplexed connection, and
`mapWithConcurrency` already bounds fan-out. Container state, unit state, disk usage, and log growth
are all one command each, with no agent, no exposed API, and no inbound surface.

### Scheduling

One loop following `statusPoller.js`: per-check intervals with jitter to avoid a thundering herd,
bounded concurrency, and an in-flight guard so a slow check never overlaps itself — the same
coalescing `status.js` performs today.

### Failure semantics

For pull checks, persistence is counted rather than timed. Each check carries
`failuresBeforeNotify`, defaulting from the severity matrix below. This makes opposite requirements
land correctly with one mechanism: a customer-facing surface at a 30s interval with a threshold of 2
is reported within a minute, while a dual-WAN gateway at a 30s interval with a 15-minute gate stays
silent through normal failover and speaks only for a sustained outage.

**Recovery requires two consecutive successes**, not one. A flapping check would otherwise emit a
resolve-and-refire pair every cycle, which is its own form of drowning.

### Known unknown

Gateway/controller APIs (UniFi in this deployment) vary in authentication and endpoint shape across
firmware generations. The design treats this as a `json` check with an API key, and treats
"confirm the correct endpoint and auth for the deployed gateway" as a **spike during
implementation** rather than a settled fact.

## Input class 2: heartbeats

A job checks in on success by requesting an opaque per-check URL on the ingest daemon. The absence
of a check-in within the configured window is the event. This is the only correct construction for
"did my backup run", because it is the sole mechanism that fires when something does *not* happen.

- The token is the authentication; tokens are random and per-check, so a known URL grants nothing
  and reveals no others.
- The window is per-check, with a grace period.
- Miss detection runs in the dashboard's policy loop, which already reads both logs. The ingest
  daemon only records check-ins.

## Input class 3: events (phase 2)

Inbound SMTP and webhooks, deferred. The design for it is settled and recorded here so phase 2 does
not re-litigate it.

- **Derived dedup key.** Hashing a raw subject fails immediately: real subjects embed timestamps,
  IPs, and counters, so "Disk usage 91%" and "Disk usage 92%" would become two alerts. The key is
  `hash(source + normalized_subject)`, where normalization strips digits, timestamps, IP and MAC
  addresses, UUIDs, and hex ids. It is a heuristic, it will occasionally over- or under-merge, and
  per-source key rules (a regex with a capture group) are a first-class override, not an
  afterthought.
- **Derived severity.** Mail has no severity field. Resolution order is per-source override table,
  then subject keyword heuristics. Unmatched mail defaults to **`warning`, not `info`** — `info`
  would render every new source permanently silent, which is the "rare but buried" failure in a new
  costume. Defaulting to `warning` hands the decision to the persistence gate, so an unclassified
  source can still reach the operator, but only by repeating or persisting.
- **MIME is the real work.** Text parts only, hard size cap, attachments discarded, HTML never
  parsed. This is the largest single component of phase 2.
- **Loop guard.** This system both sends and receives mail. Outbound messages carry an identifying
  header that ingest refuses, and ingest additionally refuses mail from its own sender identity.
  Without this, a relay that bounces or forwards back to the sink produces alerts about generating
  alerts, without end.

## Policy engine

Evaluated in the dashboard over both event logs, against a watermark so a restart re-derives rather
than loses decisions.

### The matrix

- **critical** — notifies on first occurrence, immediately.
- **warning** — notifies once the key has been firing for ≥15 minutes *or* recurred ≥3 times within
  60 minutes (for checks: once `failuresBeforeNotify` consecutive failures are reached).
- **info** — never notifies; accumulates in the feed.
- **muted** key or source — never notifies, at any severity.

All thresholds are global defaults with per-source and per-check overrides.

### Re-notify suppression

Once a key notifies, it does not notify again until it resolves or a cooldown elapses (default 6
hours). **This is the single most important rule in the document.** Without it, a problem persisting
for a day sends ninety-six messages and the system has reproduced the inbox it replaced.

### Resolution

Resolution differs by input class, because the available evidence differs:

- **Checks** resolve on two consecutive successes. The probe is authoritative — absence of failure
  is a positive observation.
- **Heartbeats** resolve on the next check-in.
- **Push events** have no probe to consult, so a key resolves on an explicit recovery event, or by
  going quiet for twice its repeat window.

Recovery notifications default to **off**, consistent with `notifyPrefs.ts`, which already defaults
`up` and `threshold-clear` to off.

### The decision log

Every evaluation appends a line carrying the key and a reason code: `notified`,
`held:below-persistence`, `suppressed:cooldown`, `suppressed:muted`, `skipped:info`, `notify:failed`.

This is nearly free, because the policy engine already computes it, and it answers the question
every alerting system is eventually asked at the worst possible moment: *why did this not reach me?*

It is also load-bearing for trust. A system that quietly withholds things is only credible if what
it withheld, and why, can be audited — otherwise "working quietly" and "broken" are
indistinguishable, and the operator reverts to reading everything. Each alert shows its reason
inline in the UI.

## Delivery

Phase 1 delivers curated email through the operator's existing relay. Configuration lives in `.env`;
credentials are sealed.

- One message per notification decision. Severity-prefixed subject. Body carries the fold:
  occurrence count, first and last seen, source, latest excerpt, and the policy reason.
- **A plain daily digest** of everything below the line — not the phase 4 AI digest, just a list.
  This is what makes adding a source psychologically safe: a new source can be confirmed working
  without ever having interrupted anyone.
- Delivery failure is recorded as `notify:failed` and retried with bounds. A decision is never lost
  because a transport failed.

Phase 3 adds outbound push to a phone. The delivery layer is written behind a channel interface from
the start so adding one is additive.

## UI

A sidebar entry opening a hub panel, structurally mirroring `proxmoxUi.ts`:

- **Alerts** — open alerts folded by key, in severity lanes. Each row shows title, source,
  occurrence count, first/last seen, and policy reason, with two actions: *ack* (seen; drops out of
  the open lane, key stays live) and *mute* (never notify on this key again).
- **Checks** — every check with last run, current state, consecutive failure count, latency, next
  run, plus enable/disable and run-now. Creation forms per type.
- **Feed** — raw chronological occurrences, searchable. Where a newly added source appears so it can
  be confirmed without notifying anyone.
- **Sources** — every source seen, with last-seen, volume, and its overrides. Rules live here rather
  than in a separate tab, because a rule is only meaningful next to the source it corrects. In phase
  1 a source is a check, and the overrides are mute and threshold; the severity mapping and custom
  key rule appear in phase 2, when sources start arriving unannounced and need correcting.

A prominent banner appears when the ingest daemon's heartbeat file goes stale.

## Failure modes

The governing principle: **failures fail loud.** A quiet alerting system and a dead one look
identical from outside, and that ambiguity destroys trust precisely where this project is most
vulnerable.

| Failure | Behaviour |
| --- | --- |
| Ingest daemon down | Heartbeat file goes stale; dashboard shows a banner. `Restart=always`. The most dangerous failure, because nothing else looks wrong. |
| Dashboard down | Ingest keeps recording. Policy re-derives from the logs on restart against its watermark. Nothing is lost. |
| Disk full / write failure | Never crash, never silently drop. Reject the inbound transaction with a temporary failure so a conforming sender retries; log loudly. |
| Relay down | Bounded retry, `notify:failed` recorded, undelivered notifications surfaced in the UI. |
| Unreadable rules file | Keep last known-good rules in memory and warn. Fallback direction is *notify per the base matrix*, never *mute everything* — a bug must produce noise, not silence. |
| Check target hangs | Per-check timeout, in-flight guard, and the failure is itself a check failure. |
| One source flooding | Beyond a per-source rate ceiling, stop appending individual lines, collapse into a counter, and raise one meta-alert that the source is flooding. |
| Corrupt line in an append log | Skip the line, count and surface skips. Deliberately unlike `jsonFile.js`, which quarantines a whole corrupt file: right for a state document, wrong for an append log where one bad line must not cost a day of history. |
| Clock skew | Day files are chosen by receipt time, never sender time. |

## Security

- The ingest daemon holds no SSH keys, no cookie secret, no box store, and no API credentials. It
  binds a LAN address with an optional sender CIDR allowlist, and runs with
  `CAP_NET_BIND_SERVICE` rather than as root when it later needs port 25.
- Inbound limits: message size cap, line-length cap, idle timeouts, concurrent-connection cap,
  per-IP rate limiting. Text only; attachments discarded; HTML never parsed.
- Heartbeat tokens are random per check and grant nothing beyond recording one check-in.
- Check credentials are sealed with `secretBox.js` and redacted to a `hasToken`-style flag on read,
  never returned to the browser — the pattern `proxmoxStore.js` and `netboxStore.js` already use.
- `exec` checks run through `boxActions.execCommand`, which is already on the validated
  `assertBoxSafe` path. Check command text is operator-authored and single-quoted the same way
  `startupCommand` is; no user-typed value reaches a shell unquoted.
- The dashboard's own posture is unchanged: loopback by default, existing auth modes untouched.

## Testing

Following the repo's conventions — TDD, real code rather than mocks, dependency-injected factories,
and an injected `now` so no test sleeps.

**Pure units (the majority):**
- The policy matrix, table-driven across severity × persistence × cooldown × mute × resolution,
  asserting the emitted reason code for every cell.
- The fold: given a synthetic day file, assert occurrence counts, first/last seen, and open state.
- Check assertion evaluators (status range, body match, JSON field predicates, exit-code handling).
- Heartbeat miss detection across window and grace boundaries.
- Retention/pruning boundaries.
- Phase 2: subject normalization and key derivation, severity resolution order, MIME text
  extraction.

**Integration (real sockets, real files, no mocks):**
- Heartbeat endpoint: a real HTTP request from a test client produces a recorded check-in; a skipped
  window produces an event.
- `http`/`tcp` checks against a local server the test starts, including timeout and TLS-expiry
  paths.
- `exec` checks against the existing local-box test helper (`test/helpers/localBox.js`), which
  already provides a real sshd-backed box.
- The two-process boundary: a rule written by the dashboard is observed by the policy loop, and an
  append by ingest is observed by the reader.
- Delivery: a local SMTP server started by the test receives exactly one message per decision, and
  the loop guard rejects a message bearing our own header.
- Crash/restart: kill mid-run, restart, assert decisions are re-derived without duplicate
  notifications.

**End-to-end (Playwright), one spec in phase 1:** a failing check appears in the Alerts tab, ack
removes it from the open lane, and mute prevents re-notification.

## Phasing

| Phase | Contents |
| --- | --- |
| **1** | Check runner (`http`, `tcp`, `json`, `exec`), heartbeats plus the minimal ingest daemon, policy engine, decision log, Alerts/Checks/Feed/Sources UI, curated email delivery, plain daily digest. |
| **2** | SMTP sink with MIME normalization, generic webhook receiver, per-source key and severity rules, and Tmuxifier's own health events routed in through the dormant `healthHistory.onEvent` seam. |
| **3** | Phone push as an additional delivery channel. |
| **4** | Scheduled AI digest and retrospective grouping, strictly on the read path. Model selection is deferred to that phase's own spec. |

Each phase gets its own plan and ships independently. Phase 1 is usable on its own: it detects the
silent failures that motivated the project and proves the noise policy before any source volume is
added.

Phase 1 is still large for a single plan, so the plan should sequence it as vertical slices rather
than horizontal layers — one check type working end to end (definition → schedule → policy →
decision log → email → UI row) before the second type is added. That way the first working slice
arrives early and every later type is an increment against a proven pipeline, rather than four
half-built layers that only integrate at the end.

## Open questions

1. **Gateway API shape.** Which endpoint and authentication method the deployed UniFi generation
   exposes for WAN state. Resolved by a spike in phase 1.
2. **Relay identity.** Whether outbound alert mail should be sent from a dedicated address, which
   makes the loop guard trivially reliable and lets inbox rules separate the two directions.
3. **Retention default.** 90 days is proposed; the right number depends on how much history is
   worth keeping for a system whose value is mostly in the present.
