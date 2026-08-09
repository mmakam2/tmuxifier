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

## Firebase (push notifications) — optional

The build works with **no Firebase config present**: the google-services plugin is applied only
when `app/google-services.json` exists (see `app/build.gradle.kts`), and push is simply off.
To enable push:

1. Firebase console → add an **Android app** with package name `com.tmuxifier.console`,
   download `google-services.json` into `android/app/` (gitignored; see
   `app/google-services.json.example` once the FCM task lands).
2. Project settings → Service accounts → generate a private key; save it on the server box
   **outside the repo** and set `TMUXIFIER_FCM_CREDENTIALS=<path>` in the server's `.env`.
   That file can send push as your Firebase project — treat it like the cookie secret.

## Signing & distribution

Lands with the release task: keystore under `android/keystore/` (gitignored),
`keystore.properties` from its `.example`. **Back up the keystore off this box the day it is
generated — losing it breaks update-in-place installs forever.** The signed APK is published to
the server's `data/app/tmuxifier-console.apk`, where `GET /api/devices/apk` serves it and
Settings → Devices shows the download link.
