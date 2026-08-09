// Settings → Devices: enrolled Android devices — list, last-seen, revoke.
// Enrollment happens in the app itself (URL + password), so this tab only
// reads and revokes. Revoke is irreversible for the device (it must re-enroll
// with the password), so it goes through the shared arm-then-fire reducer.
import { el } from './dom';
import { listDevices, revokeDevice, mintPairingCode, apkInfo, type PairingCode, type ApkInfo, type DeviceInfo } from './devices';
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

export function stopDevicesWatch(): void {
  window.clearTimeout(armTimer);
  armTimer = undefined;
  window.clearInterval(codeTimer);
  codeTimer = undefined;
  gen += 1;
}

export async function renderDevicesSection(content: HTMLElement): Promise<void> {
  const my = gen;
  content.replaceChildren(el('p', { class: 'muted' }, ['Loading…']));
  let devices: DeviceInfo[];
  let apk: ApkInfo = { available: false };
  try {
    // The APK readout is a nicety: its failure must not blank the device list.
    [devices, apk] = await Promise.all([listDevices(), apkInfo().catch(() => ({ available: false }))]);
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
      devices.length ? el('div', { class: 'device-list' }, rows)
        : el('p', { class: 'muted' }, ['No devices enrolled. In the app: Settings → server URL + a pairing code from the button above.']),
    );
  };
  paint();
}
