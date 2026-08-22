#!/usr/bin/env node
// Fetch the published Android app into data/app/ so Settings → Devices offers
// it immediately. The alternative — Settings → Devices → "Build app" — needs a
// JDK, the Android SDK and ~3 GB of RAM on the host (docs/DEPLOY.md), which is
// a lot to ask of a box whose job is to hold ssh connections open.
//
// The binary is a GitHub *release asset*, not a committed file: an 8.5 MB APK
// per app release would live in git history forever, and every clone would pay
// for it. Release assets sit outside git objects, so this costs a download and
// nothing permanent.
//
// The download goes through voiceDownload.js's downloadVerified — the same
// streamed, digest-verified, temp-then-rename path the whisper model uses — so
// an interrupted fetch can never leave a truncated APK where the server would
// serve it, and an unpinned binary can never land at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified } from '../src/server/voiceDownload.js';

// The published build this checkout endorses. Bump all four together when a new
// app release goes out; the digest is what makes the URL safe to trust, so it is
// never derived at runtime from whatever the server happens to answer with.
const RELEASE = {
  version: '1.2.2',
  versionCode: 22,
  url: 'https://github.com/mmakam2/tmuxifier/releases/download/android-v1.2.2/tmuxifier-console-v1.2.2.apk',
  sha256: '247c1a84ea68e5714ec18f84a0efd5b66f5f17ad18cb3c4500b62dc4fc3eeb18',
};

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dest = path.join(repoRoot, 'data', 'app', 'tmuxifier-console.apk');

// This is the Play-signed build. A server-side "Build app" run without
// android/keystore.properties produces a DEBUG-signed one, and Android refuses
// to update across a signature change — so a phone carrying one must uninstall
// before taking the other. Worth saying out loud rather than discovering it as
// an "App not installed" dialog.
console.log(`Fetching Tmuxifier console ${RELEASE.version} (versionCode ${RELEASE.versionCode})`);

if (fs.existsSync(dest)) {
  console.log(`  ${path.relative(repoRoot, dest)} already exists — replacing it.`);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });

try {
  await downloadVerified({ url: RELEASE.url, dest, sha256: RELEASE.sha256 });
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  console.error('The app can also be built on this host (Settings → Devices → Build app,');
  console.error('toolchain per docs/DEPLOY.md), or installed from the Play internal testing');
  console.error('track linked in docs/android-app.md.');
  process.exit(1);
}

// No chmod: downloadVerified writes 0o600, which is what jsonFile.js gives
// everything else under data/, and the server reads this as its own user. The
// server-side build path lands on 0o644 instead (a plain copyFileSync inheriting
// Gradle's output mode), so the same artifact carries different modes depending
// on how it arrived — harmless while one user owns both, and tightening here
// rather than loosening there is the right direction to differ in.
const size = fs.statSync(dest).size;
console.log(`  wrote ${path.relative(repoRoot, dest)} (${(size / 1024 / 1024).toFixed(1)} MB, digest verified)`);
console.log('  Settings → Devices now offers "Download the Android app".');
