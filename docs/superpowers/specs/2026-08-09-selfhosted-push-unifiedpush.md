# Self-hosted push (UnifiedPush/ntfy) — high-level spec

Date: 2026-08-09. Status: **recorded direction, pre-brainstorm** — a proper brainstorm +
plan pass should precede implementation; items marked TENTATIVE are recommendations, not
decisions.

Promotes the "ntfy/UnifiedPush sender behind the notifier seam" item from the
2026-08-09 Android agent console spec's v2 list into its own spec.

## Problem

Push notifications currently ride FCM, and an FCM registration token is bound to the Firebase
project baked into the APK (the operator's `google-services.json`). Consequence discovered
while planning Play-track distribution to other testers: **a third party running their own
Tmuxifier instance cannot have push without holding sender credentials to the app author's
Firebase project.** That violates the repo's self-contained principle — every other part of a
Tmuxifier instance (server, web, auth, device pairing) is fully owned by its operator; push is
the one piece coupled to someone else's infra.

Goal: push that works per-instance with **zero dependency on the app author's Google project**
(and, for operators who want it, zero Google at all).

## Direction (TENTATIVE, brainstorm to confirm)

**UnifiedPush** as the delivery standard, with ntfy as the reference distributor:

- **App side**: add the UnifiedPush connector (`org.unifiedpush.android:android-connector` —
  small, standard). When a UnifiedPush distributor app (e.g. the ntfy Android app, pointed at
  ntfy.sh or the operator's self-hosted ntfy server) is installed, the app registers and
  receives an **endpoint URL**, which it reports to its Tmuxifier server. Delivery arrives in
  OUR app (via the distributor's single connection), so the existing local-notification +
  boxId tap-through path is reused unchanged. FCM remains as a second path when
  `google-services.json` was baked in — dual-stack, device picks whichever is available
  (preference order TBD at brainstorm).
- **Server side**: a new `ntfyPush.js`-style sender (name TBD — it POSTs to UnifiedPush
  endpoints, which ntfy happens to serve) subscribing to the same `healthHistory.onEvent`
  seam beside `fcmPush.js`, in the same dependency-free mold: plain HTTPS POST of the event
  (title/body + boxId/kind payload per the UnifiedPush/ntfy message conventions). Failure
  posture identical: log, never propagate, clear a dead endpoint on permanent-failure
  responses.
- **Device store**: `devices.json` gains a `pushEndpoint` field beside `fcmToken` (absent =
  none; PATCH-merge via the existing `/api/devices/self`, explicit null clears — mirror the
  fcmToken discipline exactly). `listNotifiable` grows endpoint awareness.
- **Config**: ideally **zero server config** — the endpoint URL registered by the device IS
  the capability; the server just POSTs to it. No new `.env` knob unless the brainstorm finds
  one necessary (e.g. a hard disable).

## Security considerations to settle at plan time

- **SSRF surface**: the server POSTs to a device-supplied URL. Mitigations to weigh: endpoint
  registrable only via an authenticated device token (already true of `/api/devices/self`),
  https-only allowlist on scheme, private-address blocking (or explicitly NOT blocking, since
  a self-hosted ntfy on the LAN is a first-class target — this tension is the main brainstorm
  question), size/rate bounds, and the fact that the POSTed body carries only box label +
  event kind + ids (no secrets).
- Endpoint URLs are capabilities — treat like the FCM token: never returned to the browser
  (redact to `hasPushEndpoint` in public views).

## Explicitly in scope

- Other operators' instances get working push with their own ntfy (or any UnifiedPush
  distributor) — no Firebase project, no Google account, no app author involvement.
- The app author's own FCM path keeps working untouched.
- Docs: android-app.md + authentication.md push sections; a short "for testers running your
  own instance" walkthrough.

## Explicitly out of scope

- Web Push for desktop browsers (separate 2026-08-05 spec).
- Per-tester Firebase service-account issuance (rejected: couples testers to the author's
  project — the exact thing this spec removes).
- Any push for iOS.

## Context for the next session

Play-track distribution work is in flight (developer-account identity verification submitted
2026-08-09; internal-testing flow documented in android/README.md). This spec is what makes
the app genuinely multi-instance once other testers arrive via that track. The notifier seam
(`healthHistory.onEvent`) and the `fcmPush.js` structure were built with this second sender in
mind; `PATCH /api/devices/self`'s PATCH-merge and the deviceStore field discipline are the
patterns to extend.
