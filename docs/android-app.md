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

**From your own server.** Once an APK has been published there, **Settings → Devices** in the web
dashboard shows a **Download the Android app** link. Open the dashboard in the phone's browser
(signed in — the same session cookie authenticates the download), download, and install. Play
Protect challenges sideloaded apps once: "More details → Install anyway" (or briefly toggle Play
Protect scanning off and back on).

A fresh deployment has no APK yet — `data/` is gitignored, so none ships with a clone. Get one
with `npm run fetch-apk`, which downloads the published build into `data/app/` against a pinned
digest and needs no toolchain, or build your own with **Settings → Devices → Build app** (Gradle
on the host, Android SDK required — see [docs/DEPLOY.md](DEPLOY.md)).

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

- **Fleet** — one card per box (status dot, distro + cores, RAM + disk) with a row under it for
  every agent running on the box, one per tmux pane. A row is named the way the browser's sidebar
  names it: the window's number and name, such as `2:build`. When one window holds several agents
  the pane's number follows (`2:build.1`), and when the box has agents in several sessions the
  session leads (`work › 2:build`). Each row ends in a state chip: `blocked` (with its cause, as in
  `blocked · permission`), `done` (a finished turn you have not looked at yet), `working` or
  `idle`. An agent that has not reported a state yet has no row. Cards are ordered by their most
  urgent agent, blocked first, then done, working and idle, with boxes that have no agent last
  and the box name deciding between equals. The Host Shell has no rows in the app. Polls every 10 s
  while open; never in the background. **Tap an agent row** to go to that agent: if it is in a
  different session than the one the box is set to, the box is switched to that session (the
  same change the session sheet makes, so the browser sees it too and reconnects its terminals
  for that box), then the agent's window and pane are selected (every client attached to that
  session follows), then the session screen opens. If the window or pane has just closed, or a
  setup job is running on the box, the session screen still opens and says `agent not selected:`
  and the reason for a few seconds; a session switch that was already made is not undone. While a
  jump is running the list says `opening…` and ignores further row taps. When it finishes, the
  session screen opens only if you are still on the screen you tapped from and still signed in
  to the same server; a later tap (a card, or a notification) wins over an earlier jump still
  running. **Tap anywhere else on a card** to open the box as it is, on the session it is set
  to. **Long-press** a card for its session sheet:
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
  and the row it leaves behind recreates it in one tap. The header's state chip is the state of
  the pane on screen, the one the snapshot shows, not of the session as a whole. While the
  session screen is in front (the app on screen and the session sheet closed) and the pane on screen
  reads `done`, the app tells the server you have seen it, and it turns `idle` everywhere,
  the browser included. Nothing is acknowledged with the app in the background or the screen
  off, and agents in the session's other windows stay `done` until you look at them.
- **Settings** — server/device identity, per-kind notification toggles, font size, sign out.

## Push notifications

Push is **fully per-instance**: nothing Firebase is baked into the APK. Your server hands the
app your own Firebase project's client config (`TMUXIFIER_FCM_APP_CONFIG`) and sends through
your own service account (`TMUXIFIER_FCM_CREDENTIALS`) — see `android/README.md` for the
four-step setup. With both set, an agent needing you, finishing a turn, or exiting buzzes the
phone even when locked — suppressed while that agent's pane is on screen in a client attached to
its session (a browser terminal, for one), and filtered by the per-kind toggles (the app has
toggles only for finished-turn and exited; it has none for the blocked push).

A notification names the agent's pane: its text gives the box and where the agent is, as
`session › window`, with the pane's number added when that window holds several agents. Each agent
keeps its own, so two agents on one box do not replace each other, while a newer notification
from the same agent replaces its older one. **Tapping a notification** takes you to that agent
the way a row tap on the fleet list does (the session if it differs, the window and pane, then
the session screen), but only if the server still lists that session and window; if either is
gone, the box simply opens where it points now. A notification from a server that has not been
upgraded carries no window or pane, and a tap on it opens the box as before. Folding or rotating the phone,
or reopening the app from recents, never repeats a jump.

Push is the one feature that needs **Google Play Services on the phone** — FCM has no other
delivery path. On a de-googled phone (GrapheneOS, CalyxOS, LineageOS without GApps) everything
else works unchanged: the app is plain HTTPS polling of your server, and with no Firebase
config on the server it never touches the messaging library. Leave `TMUXIFIER_FCM_APP_CONFIG`
unset for such a deployment rather than pointing it at a project the phone can't register
with; the fleet glance is the no-push way to see who needs you (the boxes with a blocked agent are
at the top, and each agent's row carries its state). A
Google-free sender (UnifiedPush/ntfy) is a planned follow-up, not a current feature.

## Versions

App 1.3.0 shows agents per pane, which needs a Tmuxifier server that tracks agent state per
pane. Against a server that has not been upgraded it still works, but shows no agent rows,
acknowledges nothing, and a notification tap opens the box. An older app against an upgraded
server shows no agents in its fleet list until it is updated; its session screen still shows the
state of the pane on screen.

## Other apps on the phone

The app's main screen can be opened by other apps on the same phone, with a box and an agent
named in the request. A notification tap is such a request, and any app can send one. The app
checks every value in it, and jumps only to a session and window the server currently lists, but
such a request can still change a box's configured session and switch its window and pane, which
moves every viewer of that session, the browser included. It cannot type anything, read anything
out, or reach a box or session the server does not list, and the app comes to the front when it
happens. Before version 1.3.0 such a request could only open a box. Whether that is acceptable on
a given phone is for you to decide.

## Building and releasing

Toolchain, memory caps, Firebase config, signing, the server-side Build app job, and the
**keystore backup obligation** are documented in `android/README.md`. The signed APK is
published by copying it to the server's `data/app/tmuxifier-console.apk` — Build app does that
itself, and the download link appears immediately (no restart). Each app version is also
attached to its own `android-v<version>` GitHub release (separate from the server's `vX.Y.Z`
releases); that is where `npm run fetch-apk` downloads it from, against the digest pinned in
`scripts/fetch-apk.mjs`. Build app **overwrites** that file: on a server serving the
Play-signed build, pressing it swaps in an upload-key signature, and phones that installed from
the link must uninstall before they can update.
