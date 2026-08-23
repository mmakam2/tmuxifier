# Tmuxifier Android app (agent console)

Native Kotlin/Compose client of the Tmuxifier server APIs — an **agent console**, not a
terminal: fleet glance, pane snapshot viewer, action row, composer, FCM push. All tmux/ssh
intelligence stays in the Node server; the app renders `GET /api/boxes/:id/pane` snapshots as
native text and sends input through `POST /api/boxes/:id/keys`. Design:
`docs/superpowers/specs/2026-08-09-android-agent-console-design.md`; plan:
`docs/superpowers/plans/2026-08-09-android-agent-console.md`.

## Build prerequisites (one-time, machine-global)

The toolchain install — JDK 17, Android cmdline-tools and SDK packages, `local.properties`,
the signing keystore — is scripted step by step in `docs/DEPLOY.md` (§ Publishing the Android
app). Follow it there rather than a copy here. No standalone Gradle install is needed: the
wrapper (`gradlew` + `gradle/wrapper/gradle-wrapper.jar`) is committed and downloads Gradle
8.10.2 itself on first run.

Versions pinned here: JDK 17, AGP 8.7.3, Kotlin 2.1.0, Compose BOM 2024.12.01, Gradle 8.10.2
(wrapper), compileSdk/targetSdk 35, minSdk 26; SDK packages `platform-tools`,
`platforms;android-35`, `build-tools;35.0.0`. If one of DEPLOY.md's download URLs 404s, the
pinned version moved — pick the nearest current one and record the change in both files.

## Commands

```bash
./gradlew test            # pure-Kotlin JVM unit tests (api/, fleet/, keys/, pane/, session/)
./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk (debug-signed, installable)
./gradlew assembleRelease # app/build/outputs/apk/release/app-release.apk — signed with
                          # keystore.properties when it exists, otherwise UNSIGNED (Android
                          # refuses to install it); see Signing
./gradlew bundleRelease   # app/build/outputs/bundle/release/app-release.aab (Play upload)
```

The memory caps in `gradle.properties` are load-bearing: the build box has ~3 GB RAM. If the
Kotlin daemon OOMs, lower the caps rather than raising them.

The app's Gradle build is fully separate from the repo's `npm test` — Node never runs Kotlin
tests and vice versa. Compose UI is validated **on the real device** (the repo's
validate-on-live rule); there is no emulator tier.

When writing Kotlin with `\uXXXX` escapes, run the control-byte check
(`grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' app/src`) before building — generated escapes
have repeatedly landed as raw bytes.

## Building on the server (Settings → Devices → Build app)

`src/server/apkBuild.js` runs the same Gradle build as a persisted, single-flight background
job (`POST`/`GET /api/devices/apk/build`, history in `data/apk-build-jobs.json`) and publishes
the result itself. What it does, so a hand build can match it:

- Preflight: `android/gradlew` must exist, and either `android/local.properties` or
  `ANDROID_HOME` must point at the SDK.
- The variant is decided by which gitignored file exists, never by the request:
  `keystore.properties` present → `assembleRelease` (signed); absent → `assembleDebug`
  (debug-signed, installable). It never produces the unsigned release a bare
  `assembleRelease` without the keystore would.
- Runs `gradlew --no-daemon --console=plain <task>` as the service user under a 20-minute
  deadline; `--no-daemon` so a resident daemon does not hold ~1.5 GB beside the live server.
- Verifies the APK exists after `BUILD SUCCESSFUL`, then copies it to
  `data/app/tmuxifier-console.apk` — **overwriting whatever is there**.

That last step is the trap. If `data/app/` holds the **Play-signed** APK (see Play Store
below), one press of Build app replaces it with a build signed by your upload key. The two
signatures do not update each other, so every phone that installed from the download link is
then stuck until it uninstalls. Press Build app only on a server whose download link is meant
to serve your own key, or restore the Play-signed file afterwards.

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
  updates the other. Copy it there by hand; do **not** press Build app on that server
  afterwards, which would overwrite it with an upload-key-signed build (see Building on the
  server above).
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

The release keystore lives under `android/keystore/` (gitignored) with `keystore.properties`
copied from its `.example`; `docs/DEPLOY.md` has the `keytool` command. **Back up the keystore
off this box the day it is generated — losing it breaks update-in-place installs forever.** The
signed APK is published to the server's `data/app/tmuxifier-console.apk`, where
`GET /api/devices/apk` serves it and Settings → Devices shows the download link — Build app
copies it there itself; a hand build needs the `cp` in DEPLOY.md. A fresh deployment needs no
toolchain at all: `npm run fetch-apk` downloads the build attached to the `android-v<version>`
GitHub release against the digest pinned in `scripts/fetch-apk.mjs`.
