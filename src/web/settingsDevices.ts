// Settings → Devices: enrolled Android devices — list, last-seen, revoke.
// Enrollment happens in the app itself (URL + password), so this tab only
// reads and revokes. Revoke is irreversible for the device (it must re-enroll
// with the password), so it goes through the shared arm-then-fire reducer.
import { el } from './dom';
import { listDevices, revokeDevice, mintPairingCode, apkInfo, startApkBuild, apkBuildStatus, type PairingCode, type ApkInfo, type ApkBuildJob, type DeviceInfo } from './devices';
import { fmtBytes } from './fmt';
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';

function when(t: number | null): string {
  if (!t) return 'never';
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// The armed-revoke timeout and an in-flight DELETE both outlive a single
// paint — a tab switch (or modal close) while a revoke is armed, or while its
// request is still in flight, must not let either one's callback repaint the
// Devices list over whatever the shell now shows. Same shape as
// settingsVoice.ts's watchGen/stopVoiceWatch: a module-level generation the
// settings shell bumps via dispose, checked by paint() before every repaint,
// with a detached-node check as the backstop (mirrored from settingsVoice.ts's
// settle(), compared to false explicitly for the same reason: the lightweight
// DOM stand-in the render tests use has no isConnected at all).
let gen = 0;
let armTimer: number | undefined;
let codeTimer: number | undefined;
let buildTimer: number | undefined;

export function stopDevicesWatch(): void {
  window.clearTimeout(armTimer);
  armTimer = undefined;
  window.clearInterval(codeTimer);
  codeTimer = undefined;
  window.clearInterval(buildTimer);
  buildTimer = undefined;
  gen += 1;
}

export async function renderDevicesSection(content: HTMLElement): Promise<void> {
  const my = gen;
  content.replaceChildren(el('p', { class: 'muted' }, ['Loading…']));
  let devices: DeviceInfo[];
  let apk: ApkInfo = { available: false };
  let build: ApkBuildJob | null = null;
  try {
    // The APK/build readouts are niceties: their failure must not blank the list.
    [devices, apk, build] = await Promise.all([
      listDevices(),
      apkInfo().catch(() => ({ available: false })),
      apkBuildStatus().then((r) => r.job).catch(() => null),
    ]);
  } catch {
    content.replaceChildren(el('p', { class: 'muted' }, ['Could not load devices.']));
    return;
  }

  let arm: ArmState = IDLE;
  let pairing: PairingCode | null = null;

  // The pairing row: a mint button, or the live code with a 1s countdown. The
  // interval respects gen/isConnected exactly like paint() — a tab switch or
  // modal close must not leave it repainting a dead panel.
  const pairRow = (): HTMLElement => {
    const p = pairing;
    if (!p) {
      return el('button', {
        type: 'button',
        onclick: () => {
          void mintPairingCode().then((minted) => {
            if (my !== gen || content.isConnected === false) return;
            pairing = minted;
            window.clearInterval(codeTimer);
            codeTimer = window.setInterval(() => {
              if (my !== gen || content.isConnected === false) { window.clearInterval(codeTimer); return; }
              if (pairing && pairing.expiresAt <= Date.now()) { pairing = null; window.clearInterval(codeTimer); }
              paint();
            }, 1000);
            paint();
          }).catch(() => paint());
        },
      }, ['Pair new device']);
    }
    const left = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
    return el('div', { class: 'pair-code' }, [
      el('code', {}, [p.code]),
      el('span', { class: 'muted' }, [` expires in ${left}s — enter it in the app: Settings → Pair`]),
    ]);
  };

  // Poll the running build every 2.5s; on completion refresh the APK readout
  // so the download link appears (or updates) without a tab reload. Same
  // gen/isConnected discipline as every other timer in this tab.
  const watchBuild = () => {
    window.clearInterval(buildTimer);
    buildTimer = window.setInterval(() => {
      void apkBuildStatus().then(async (r) => {
        if (my !== gen || content.isConnected === false) { window.clearInterval(buildTimer); return; }
        build = r.job;
        if (build?.status !== 'running') {
          window.clearInterval(buildTimer);
          if (build?.status === 'done') {
            apk = await apkInfo().catch(() => ({ available: false }));
          }
        }
        paint();
      }).catch(() => { /* transient poll failure: keep polling */ });
    }, 2500);
  };
  if (build?.status === 'running') watchBuild();

  // The server-side Gradle build behind "Build app": what the operator gets
  // (signed release vs debug) is decided server-side by which gitignored
  // files exist — see docs/DEPLOY.md § Building the Android app.
  const buildRow = (): HTMLElement => {
    const b = build;
    if (b && b.status === 'running') {
      return el('p', { class: 'muted' }, [`Building the app on the server (${b.phase ?? '…'}) — takes a few minutes on first run.`]);
    }
    const btn = el('button', {
      type: 'button',
      onclick: () => {
        void startApkBuild().then((r) => {
          if (my !== gen || content.isConnected === false) return;
          build = r.job;
          watchBuild();
          paint();
        }).catch(() => paint());
      },
    }, [apk.available ? 'Rebuild the app on the server' : 'Build the app on the server']);
    const note = b && b.status === 'error'
      ? el('span', { class: 'muted' }, [` last build failed: ${b.error ?? 'unknown'}`])
      : null;
    return el('div', { class: 'apk-build-row' }, note ? [btn, note] : [btn]);
  };

  const paint = () => {
    // A stale generation (the shell disposed this render) or a detached
    // `content` (the modal closed) means this callback fired after the tab
    // moved on; painting now would draw the device list over whatever the
    // operator is looking at instead.
    if (my !== gen || content.isConnected === false) return;
    const rows = devices.map((d) => {
      const armed = arm.armed === d.id;
      const revoke = el('button', {
        type: 'button',
        class: armed ? 'danger armed' : 'danger',
        onclick: () => {
          const out = armReduce(arm, { type: 'click', id: d.id, armable: true });
          arm = out.state;
          window.clearTimeout(armTimer);
          if (out.fire) {
            void revokeDevice(out.fire).then(() => {
              devices = devices.filter((x) => x.id !== out.fire);
              paint();
            }).catch(() => paint());
          } else {
            armTimer = window.setTimeout(() => { arm = IDLE; paint(); }, ARM_MS);
          }
          paint();
        },
      }, [armed ? 'Really revoke?' : 'Revoke']);
      return el('div', { class: 'device-row' }, [
        el('div', { class: 'device-id' }, [
          el('strong', {}, [d.name]),
          el('span', { class: 'muted' }, [` · enrolled ${when(d.created)} · last seen ${when(d.lastSeen)}${d.hasFcmToken ? ' · push on' : ''}`]),
        ]),
        revoke,
      ]);
    });
    // A plain same-origin link: the browser's session cookie authenticates the
    // download, so this works from a signed-in phone browser — install, then pair.
    const apkRow = apk.available
      ? el('p', { class: 'muted' }, [
          el('a', { href: '/api/devices/apk' }, ['Download the Android app']),
          ` (APK, ${fmtBytes(apk.size)}) — install on the phone, then pair above.`,
        ])
      : null;
    content.replaceChildren(
      el('h3', {}, ['Devices']),
      el('p', { class: 'muted' }, ['Android devices enrolled with the Tmuxifier app. Revoking a device signs it out on its next request; it re-enrolls with a pairing code (or the password, in password mode).']),
      pairRow(),
      ...(apkRow ? [apkRow] : []),
      buildRow(),
      devices.length ? el('div', { class: 'device-list' }, rows)
        : el('p', { class: 'muted' }, ['No devices enrolled. In the app: Settings → server URL + a pairing code from the button above.']),
    );
  };
  paint();
}
