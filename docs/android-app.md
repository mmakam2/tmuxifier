# The Android app (agent console)

A native Android companion for driving **Claude Code sessions** from a phone — check what an
agent did, answer its question, send the next prompt — built for a cover-screen-sized display.
It is deliberately **not a terminal**: the server captures the tmux pane it already maintains
and ships a snapshot; the app renders it as native, selectable, soft-wrapped text. Real shell
work stays in the browser ("browser" button in the session header opens the full web app).

Because a snapshot viewer never attaches a tmux client, phone viewing can never resize the
desktop's tmux window.

## Getting the app

**From Play (simplest).** The app lives permanently on an **[internal testing
track](https://play.google.com/apps/internaltest/4701129402312577506)** — no public listing, no
production review. Opt in with that link, install from Play, and it auto-updates. Nothing about
the build is instance-specific: it fetches your Firebase client config and your server URL after
pairing, so one published build serves every operator.

**From your own server.** Once a signed APK has been published there, **Settings → Devices** in
the web dashboard shows a **Download the Android app** link. Open the dashboard in the phone's
browser (signed in — the same session cookie authenticates the download), download, and install.
Play Protect challenges sideloaded apps once: "More details → Install anyway" (or briefly toggle
Play Protect scanning off and back on). A fresh deployment has no APK yet (`data/` is gitignored,
so none ships with a clone): publish one with **Settings → Devices → Build app**, which runs
Gradle on the host and needs the Android SDK there.

The two are signed by different keys unless your server build uses the same keystore, so moving
between them means uninstalling first — pick one per phone.

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
  background. Tap a card to open its session. **Long-press** a card for its session sheet:
  every tmux session on the box with its windows beneath it, a ✓ on the one you're looking
  at. Tap a row to switch the box to that session or window, `×` to kill it (two taps — the
  first arms and says what it will take, including when a window is the session's last), or
  **+ New session…** to create one without switching to it.
- **Session** — the pane snapshot at 1 s cadence: full terminal colors, cursor marker,
  stick-to-bottom with a "▼ latest" jump chip. While you're viewing, the server keeps an
  **invisible tmux client** attached at your phone's geometry, so tmux reflows the session to
  phone shape exactly as a narrowed desktop browser would — pinch is effectively a resize, and
  your pinched size persists per box (the ⤢ fit chip returns to auto). When a desktop client
  is active it takes the size back (tmux follows the most recently used client), and the pane
  then renders the wide window auto-fitted: full-screen TUIs (Claude Code, vim) never
  soft-wrap — they fit or pan horizontally at intact layout. Plain shell panes keep larger
  soft-wrapped text at the Settings font size. Leaving the session detaches the invisible
  client within ~30 s; the window keeps its last size until another client acts. The pane is **inert to touch** — scroll and select only. Below it: the
  action row (`Esc ↑ ↓ Tab ⏎ 1 2 3 y n`, and `^C` behind a two-tap arm) and the composer — a
  real Android text field where drafting, autocorrect, and voice dictation stay local until
  **Send** (literal text + Enter). Drafts persist per box; empty Send is a bare Enter.
  A full-screen app like Claude Code keeps its conversation history inside itself, not in tmux
  scrollback — so for those panes the snapshot stops at the top of the screen (no more sliding
  up into stale shell output), and "▲ older" / "▼ newer" chips on the right edge scroll the
  app's own transcript instead, by sending it the same wheel events a desktop scroll would.
  Plain shell panes keep their ordinary scrollback. The header's `web ▾` chip opens the same
  session sheet, so you can retarget without leaving the pane. Switching the **session**
  repoints the box everywhere — open browsers reconnect to it; switching a **window** needs
  no reconnect at all. Killing the session the app is showing is allowed: the pane goes dark
  and the row it leaves behind recreates it in one tap.
- **Settings** — server/device identity, per-kind notification toggles, font size, sign out.

## Push notifications

Push is **fully per-instance**: nothing Firebase is baked into the APK. Your server hands the
app your own Firebase project's client config (`TMUXIFIER_FCM_APP_CONFIG`) and sends through
your own service account (`TMUXIFIER_FCM_CREDENTIALS`) — see `android/README.md` for the
four-step setup. With both set, an agent flipping to **waiting** (or finishing) buzzes the
phone even when locked —
suppressed while that session is attached in a browser, and filtered by the per-kind toggles.
Tapping the notification opens that box's session directly.

## Building and releasing

Toolchain, memory caps, Firebase config, signing, and the **keystore backup obligation** are
documented in `android/README.md`. The signed APK is published by copying it to the server's
`data/app/tmuxifier-console.apk` — the download link appears immediately (no restart), and the
APK is deliberately not attached to GitHub releases.
