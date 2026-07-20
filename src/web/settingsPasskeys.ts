// Settings → Passkeys: a readiness row, the enrolled-credential list, and the
// passkey-only ("require a passkey") sign-in policy toggle.
import { el, input, field, err, openModal } from './dom';
import { pk, evaluateOrigin, createPasskey, serializeRegistration, hasWebAuthn, type PasskeyState } from './passkeys';

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');

// Shown after a remove that flipped the server's stored passkeyOnly flag off —
// see the disarmed handling in confirmRemove below.
const DISARM_NOTICE = 'Removed. That was your last enrolled passkey, so “require a passkey” was turned off — password and Google sign-in are available again.';

// Settings → Passkeys. A passkey is an additional way in; the password/Google
// path stays available unless "passkey only" is explicitly armed.
export async function renderPasskeysSection(content: HTMLElement, notice?: string): Promise<void> {
  content.replaceChildren(el('div', { class: 'pve-sub' }, ['Loading…']));
  let state: PasskeyState;
  try {
    state = await pk.state();
  } catch (e) {
    const retry = el('button', {
      type: 'button', class: 'pve-btn', onclick: () => { void renderPasskeysSection(content); },
    }, ['Retry']);
    content.replaceChildren(err(e instanceof Error ? e.message : 'Could not load passkeys.'), retry);
    return;
  }
  const verdict = evaluateOrigin({
    rpId: state.rpId, storedRpId: state.storedRpId,
    hostname: location.hostname, protocol: location.protocol, hasWebAuthn: hasWebAuthn(),
  });
  const reload = (next?: string) => { void renderPasskeysSection(content, next); };
  const errLine = el('div', { class: 'pve-err' });
  const fail = (e: unknown) => { errLine.textContent = e instanceof Error ? e.message : 'Something went wrong.'; };

  // --- readiness ---
  const readiness = el('div', { class: verdict.ok ? 'pve-sub' : 'pve-err' }, [verdict.reason]);
  const hint = verdict.hint ? el('div', { class: 'pve-sub' }, [verdict.hint]) : null;

  // --- enrolled list ---
  const rows = state.credentials.map((c) => el('div', { class: 'pve-row' }, [
    el('div', {}, [
      el('strong', {}, [c.label]),
      el('div', { class: 'pve-sub' }, [`added ${when(c.created)} · last used ${when(c.lastUsed)}${c.transports.length ? ` · ${c.transports.join(', ')}` : ''}`]),
    ]),
    el('button', {
      type: 'button', class: 'danger',
      onclick: () => confirmRemove(c.id, c.label, state, reload, fail),
    }, ['Remove']),
  ]));
  const list = state.credentials.length
    ? el('div', {}, rows)
    : el('div', { class: 'pve-sub' }, ['No passkeys enrolled yet.']);

  // --- add ---
  const addBtn = el('button', {
    type: 'button', class: 'pve-primary', onclick: () => addPasskey(reload),
  }, ['Add passkey']) as HTMLButtonElement;
  if (!verdict.ok) { addBtn.disabled = true; addBtn.title = verdict.reason; }

  // --- passkey-only toggle ---
  // GET /api/passkeys reports passkeyOnly (the stored flag) and killSwitch
  // separately; the server ignores the stored flag entirely while the kill
  // switch is set (passkeyOnlyArmed in server.js). Showing the checkbox as
  // checked whenever passkeyOnly is true would claim enforcement that isn't
  // actually happening, so what's displayed here is the AND of the two.
  const armed = state.passkeyOnly && !state.killSwitch;
  const onlyBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  onlyBox.checked = armed;
  const onlyReason = state.killSwitch
    ? 'TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart to use this.'
    : state.credentials.length === 0
      ? 'Enroll a passkey first.'
      : '';
  if (onlyReason) { onlyBox.disabled = true; onlyBox.title = onlyReason; }
  onlyBox.onchange = () => {
    if (!onlyBox.checked) { void pk.setOnly(false).then(() => reload()).catch((e) => { onlyBox.checked = true; fail(e); }); return; }
    // Arming is the one action here that can lock the user out of the fleet.
    confirmArm(() => void pk.setOnly(true).then(() => reload()).catch((e) => { onlyBox.checked = false; fail(e); }),
      () => { onlyBox.checked = false; });
  };

  content.replaceChildren(
    el('h3', {}, ['Passkeys']),
    el('p', { class: 'pve-sub' }, ['A passkey signs you in with your device’s fingerprint, face or PIN instead of a password. It is phishing-resistant: it only works on this exact hostname.']),
    ...(notice ? [el('div', { class: 'pve-warning' }, [notice])] : []),
    readiness,
    ...(hint ? [hint] : []),
    el('div', { class: 'pve-eyebrow' }, ['Enrolled passkeys']),
    list,
    addBtn,
    el('div', { class: 'pve-eyebrow' }, ['Sign-in policy']),
    el('label', { class: 'check-field' }, [onlyBox, el('span', {}, ['Require a passkey (disable password and Google sign-in)'])]),
    ...(onlyReason ? [el('div', { class: 'pve-sub' }, [onlyReason])] : []),
    el('p', { class: 'pve-sub' }, ['If you lose your authenticator, set TMUXIFIER_PASSKEY_ONLY=off in .env and restart Tmuxifier to sign in the old way.']),
    errLine,
  );
}

// Errors from this flow surface inside its own modal, not on the tab behind it.
function addPasskey(reload: () => void): void {
  const nameField = input('', { placeholder: 'Laptop Touch ID', maxlength: 32 }) as HTMLInputElement;
  const errLine = el('div', { class: 'pve-err' });
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal });
  const save = el('button', { type: 'button', class: 'pve-primary' }, ['Create']) as HTMLButtonElement;
  save.onclick = async () => {
    save.disabled = true;
    errLine.textContent = '';
    try {
      const options = await pk.registerBegin();
      const credential = await createPasskey(options);
      await pk.registerFinish(nameField.value.trim() || 'passkey', serializeRegistration(credential));
      close();
      reload();
    } catch (e) {
      save.disabled = false;
      // A cancelled browser prompt is not an error worth shouting about. Check
      // `instanceof Error` before touching .name/.message — a rejection value
      // that isn't an Error (a bare string, or a non-conforming WebAuthn
      // implementation) must not throw a second error out of this handler.
      if (e instanceof Error && e.name === 'NotAllowedError') { errLine.textContent = 'Cancelled.'; return; }
      errLine.textContent = e instanceof Error ? e.message : 'Something went wrong.';
    }
  };
  modal.append(
    el('h2', {}, ['Add a passkey']),
    field('Name', nameField),
    el('p', { class: 'pve-sub' }, ['Your browser will ask you to confirm with your fingerprint, face, PIN or security key.']),
    errLine,
    el('div', { class: 'modal-actions' }, [el('button', { type: 'button', onclick: close }, ['Cancel']), save]),
  );
  nameField.focus();
}

function confirmRemove(id: string, label: string, state: PasskeyState, reload: (notice?: string) => void, fail: (e: unknown) => void): void {
  const last = state.credentials.length === 1;
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal });
  modal.append(
    el('h2', {}, ['Remove passkey']),
    el('p', {}, [`Remove “${label}”? The passkey stays on your device but will no longer sign you in here.`]),
    ...(last && state.passkeyOnly
      ? [el('p', { class: 'pve-sub' }, ['This is the last passkey, so “require a passkey” will be turned off and password sign-in re-enabled.'])]
      : []),
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', onclick: close }, ['Cancel']),
      el('button', {
        type: 'button', class: 'danger',
        // result.disarmed is the server's authoritative answer (it may differ
        // from the "last" prediction above if another session changed the
        // credential set in the meantime), so the actual outcome — not the
        // prediction — is what gets surfaced after the reload.
        onclick: () => { close(); void pk.remove(id).then((result) => reload(result.disarmed ? DISARM_NOTICE : undefined)).catch(fail); },
      }, ['Remove']),
    ]),
  );
}

// onClose fires on Escape, backdrop click and the Cancel button alike, so the
// checkbox has to be un-ticked from there — guarded by a flag so confirming
// does not also run the cancel path.
function confirmArm(onConfirm: () => void, onCancel: () => void): void {
  let confirmed = false;
  const modal = el('div', { class: 'modal' });
  const { close } = openModal({ modal, onClose: () => { if (!confirmed) onCancel(); } });
  modal.append(
    el('h2', {}, ['Require a passkey?']),
    el('p', {}, ['Password and Google sign-in will be refused. Only an enrolled passkey will get you in.']),
    el('p', { class: 'pve-sub' }, ['If you lose your authenticator: set TMUXIFIER_PASSKEY_ONLY=off in .env and restart Tmuxifier.']),
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', onclick: close }, ['Cancel']),
      el('button', {
        type: 'button', class: 'pve-primary',
        onclick: () => { confirmed = true; close(); onConfirm(); },
      }, ['Require a passkey']),
    ]),
  );
}
