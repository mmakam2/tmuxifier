# The Android app (agent console)

A native Android companion for driving **Claude Code sessions** from a phone — check what an
agent did, answer its question, send the next prompt — built for a cover-screen-sized display.
It is deliberately **not a terminal**: the server captures the tmux pane it already maintains
and ships a snapshot; the app renders it as native, selectable, soft-wrapped text. Real shell
work stays in the browser ("browser" button in the session header opens the full web app).

Because a snapshot viewer never attaches a tmux client, phone viewing can never resize the
desktop's tmux window.

## Getting the app

Once a signed APK has been published on the server, **Settings → Devices** in the web dashboard
shows a **Download the Android app** link. Open the dashboard in the phone's browser (signed
in — the same session cookie authenticates the download), download, and install. Play Protect
challenges sideloaded apps once: "More details → Install anyway" (or briefly toggle Play
Protect scanning off and back on). There is no Play Store listing, deliberately.

## Pairing

In web **Settings → Devices**, press **Pair new device** — a single-use `XXXX-XXXX` code with a
2-minute countdown appears. In the app: Settings → server URL + device name + that code →
Enroll. The app receives a long-lived device token (stored in Android-Keystore-encrypted
preferences); the code is spent. Works in every server auth mode, including passkey-only.
Revoking the device (web Settings → Devices) locks it out on its next request; the app's own
Sign out only forgets the token locally.

## Screens

- **Fleet** — box cards (status dot, distro + cores, RAM + disk, agent chip with "waiting 4m"
  durations), waiting agents sorted to the top. Polls every 10 s while open; never in the
  background. Tap a card to open its session.
- **Session** — the pane snapshot at 1 s cadence: full terminal colors, pinch to set font size
  (persisted), soft-wrap (never squeezed to 80 columns), cursor marker, stick-to-bottom with a
  "▼ latest" jump chip. The pane is **inert to touch** — scroll and select only. Below it: the
  action row (`Esc ↑ ↓ Tab ⏎ 1 2 3 y n`, and `^C` behind a two-tap arm) and the composer — a
  real Android text field where drafting, autocorrect, and voice dictation stay local until
  **Send** (literal text + Enter). Drafts persist per box; empty Send is a bare Enter.
- **Settings** — server/device identity, per-kind notification toggles, font size, sign out.

## Push notifications

With `TMUXIFIER_FCM_CREDENTIALS` set on the server (see `android/README.md` for the Firebase
setup), an agent flipping to **waiting** (or finishing) buzzes the phone even when locked —
suppressed while that session is attached in a browser, and filtered by the per-kind toggles.
Tapping the notification opens that box's session directly.

## Building and releasing

Toolchain, memory caps, Firebase config, signing, and the **keystore backup obligation** are
documented in `android/README.md`. The signed APK is published by copying it to the server's
`data/app/tmuxifier-console.apk` — the download link appears immediately (no restart), and the
APK is deliberately not attached to GitHub releases.
