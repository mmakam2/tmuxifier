# Tmuxifier Android app (agent console)

Native Kotlin/Compose client of the Tmuxifier server APIs — an **agent console**, not a
terminal: fleet glance, pane snapshot viewer, action row, composer, FCM push. All tmux/ssh
intelligence stays in the Node server; the app renders `GET /api/boxes/:id/pane` snapshots as
native text and sends input through `POST /api/boxes/:id/keys`. Design:
`docs/superpowers/specs/2026-08-09-android-agent-console-design.md`; plan:
`docs/superpowers/plans/2026-08-09-android-agent-console.md`.

## Build prerequisites (one-time, machine-global)

```bash
apt-get install -y openjdk-17-jdk-headless unzip
# Android cmdline-tools into /opt/android-sdk, then:
yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses
/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
# Gradle 8.10.2 into /opt/gradle-8.10.2 (bootstrap only; the wrapper takes over)
cp local.properties.example local.properties   # points sdk.dir at /opt/android-sdk
```

Versions pinned here: JDK 17, AGP 8.7.3, Kotlin 2.1.0, Compose BOM 2024.12.01, compileSdk 35,
minSdk 26. If a download URL 404s, the pinned version moved — pick the nearest current one and
record the change here.

## Commands

```bash
./gradlew test           # pure-Kotlin JVM unit tests (SGR parser, models, arming, composer)
./gradlew assembleDebug  # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease # signed release APK (needs keystore.properties — see Signing)
```

The memory caps in `gradle.properties` are load-bearing: the build box has ~3 GB RAM. If the
Kotlin daemon OOMs, lower the caps rather than raising them.

The app's Gradle build is fully separate from the repo's `npm test` — Node never runs Kotlin
tests and vice versa. Compose UI is validated **on the real device** (the repo's
validate-on-live rule); there is no emulator tier.

## Firebase (push notifications) — optional, per-instance, zero build coupling

**Nothing Firebase is baked into the APK.** The app initializes Firebase at runtime from the
client config its own server serves (`GET /api/devices/fcm-config`), so one published APK
works against any operator's Firebase project. An operator enabling push for their instance:

1. Firebase console → create a (free) project → add an **Android app** with package name
   `com.tmuxifier.console` (no SHA-1 needed) → download `google-services.json`. Put it on the
   **server box** (outside the repo, e.g. `/root/secrets/`) and set
   `TMUXIFIER_FCM_APP_CONFIG=<path>` in `.env`. These are public client identifiers — the
   server just hands them to enrolled devices. (`app/google-services.json.example` shows the
   file's shape; the build itself never reads it.)
2. Project settings → Service accounts → generate a private key; save it beside the first
   file and set `TMUXIFIER_FCM_CREDENTIALS=<path>`. This one IS a secret — it can send push
   as the Firebase project; treat it like the cookie secret.
3. Grant the service account the **Firebase Cloud Messaging API Admin** role in Google Cloud
   IAM (a fresh project's auto-created roles are not sufficient; sends 403 without it).
4. Restart Tmuxifier. Devices fetch the config on their next launch/enrollment and register
   against that project; "push on" appears in Settings → Devices.

No config on the server = no push, everything else unaffected.

## Play Store (internal testing track)

Optional distribution channel that removes sideload friction (Play Protect prompts, unknown
sources) and adds auto-updates. The app lives on the **internal testing** track permanently —
no public listing, no production review, and no closed-testing tester quota (that gauntlet
only gates the production track).

- Build the bundle: `./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`
  (signed by the same `keystore.properties` config; under Play App Signing this key becomes the
  **upload key** while Google holds the actual app signing key).
- Play Console: create the app (package `com.tmuxifier.console`), enroll in Play App Signing,
  upload the AAB to **Internal testing**, add your own Google account as a tester, and install
  from the opt-in link. Data-safety form: the app sends data only to the user-configured
  Tmuxifier server; nothing is collected by the developer.
- **Signature migration**: Play re-signs with its own key, so the first Play install requires
  uninstalling a sideloaded build (then re-pair). To keep the Settings → Devices download link
  usable alongside Play, serve the **Play-signed universal APK** (Console → App Bundle
  Explorer → download) at `data/app/tmuxifier-console.apk` — same signature, either channel
  updates the other.
- **Republish for other deployments**, so `npm run fetch-apk` stops handing out the previous
  build. Nothing enforces this — the pin is a constant, and a stale one fetches happily:

  ```bash
  gh release create android-v<version> --title "android-v<version> — <summary>" --notes "…"
  cp data/app/tmuxifier-console.apk /tmp/tmuxifier-console-v<version>.apk
  gh release upload android-v<version> /tmp/tmuxifier-console-v<version>.apk
  sha256sum data/app/tmuxifier-console.apk       # → scripts/fetch-apk.mjs RELEASE.sha256
  ```

  Then update all four fields of `RELEASE` in `scripts/fetch-apk.mjs` together — version,
  versionCode, url, sha256. `test/fetchApkScript.test.js` checks the URL and version agree with
  each other, but it cannot know which release you *meant*, so a wholesale-stale manifest still
  passes.

## Signing & distribution

Lands with the release task: keystore under `android/keystore/` (gitignored),
`keystore.properties` from its `.example`. **Back up the keystore off this box the day it is
generated — losing it breaks update-in-place installs forever.** The signed APK is published to
the server's `data/app/tmuxifier-console.apk`, where `GET /api/devices/apk` serves it and
Settings → Devices shows the download link.
