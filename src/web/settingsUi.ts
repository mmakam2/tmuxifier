// The app-wide settings modal. NetBox is the first section; future sections
// (each backed by its own server-side store) append below it.
import { nbx, type NetboxSettings } from './netbox';
import { buildSavePayload, describeTestResult, isHttps, type NetboxFormState } from './settingsForm';

function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.append(span, input);
  return wrap;
}

export async function openSettingsModal(): Promise<void> {
  let current: NetboxSettings | null = null;
  try { current = (await nbx.get()).settings; } catch { /* render empty form */ }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal settings-modal';

  const title = document.createElement('h2');
  title.textContent = 'Settings';
  const section = document.createElement('h3');
  section.textContent = 'NetBox API integration';

  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'https://netbox.example.com';
  url.value = current?.url ?? '';
  url.autocomplete = 'off';

  const token = document.createElement('input');
  token.type = 'password';
  token.placeholder = current?.hasToken ? 'token saved — leave blank to keep' : 'NetBox API token';
  token.autocomplete = 'new-password';

  const httpNote = document.createElement('p');
  httpNote.className = 'settings-hint';
  httpNote.textContent = 'http:// — the token travels in cleartext; LAN use only.';

  // TLS mode (https only)
  const tlsGroup = document.createElement('fieldset');
  tlsGroup.className = 'radio-group';
  const tlsLegend = document.createElement('legend');
  tlsLegend.textContent = 'TLS verification';
  tlsGroup.append(tlsLegend);
  let tlsMode: 'ca' | 'pin' | 'insecure' = current?.tlsMode ?? 'ca';
  let fingerprint256: string | null = current?.fingerprint256 ?? null;
  const fpHint = document.createElement('p');
  fpHint.className = 'settings-hint settings-fp';
  function renderFp() {
    fpHint.textContent = tlsMode === 'pin'
      ? (fingerprint256 ? `pinned: ${fingerprint256}` : 'no fingerprint pinned yet — run Test Connection to fetch it')
      : '';
  }
  function makeTls(value: 'ca' | 'pin' | 'insecure', label: string) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'netboxTlsMode';
    input.value = value;
    input.checked = tlsMode === value;
    input.addEventListener('change', () => { if (input.checked) { tlsMode = value; renderFp(); } });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return wrap;
  }
  tlsGroup.append(
    makeTls('ca', 'CA-verified (default)'),
    makeTls('pin', 'Pinned fingerprint (self-signed)'),
    makeTls('insecure', 'No verification (not recommended)'),
    fpHint,
  );
  renderFp();

  function syncSchemeUi() {
    const https = isHttps(url.value);
    tlsGroup.hidden = !https;
    httpNote.hidden = https || !/^http:\/\//i.test(url.value.trim());
  }
  url.addEventListener('input', syncSchemeUi);

  // Test Connection
  const testRow = document.createElement('div');
  testRow.className = 'settings-test';
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.textContent = 'Test Connection';
  const testOut = document.createElement('span');
  testOut.className = 'settings-hint';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.textContent = 'Pin this certificate';
  pinBtn.hidden = true;
  testRow.append(testBtn, pinBtn);

  function formState(): NetboxFormState {
    return { url: url.value, token: token.value, tlsMode, fingerprint256, hasToken: !!current?.hasToken };
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    pinBtn.hidden = true;
    testOut.className = 'settings-hint';
    testOut.textContent = 'Testing…';
    try {
      const body: Record<string, unknown> = { url: url.value.trim() };
      if (token.value.trim()) body.token = token.value.trim();
      if (isHttps(url.value)) { body.tlsMode = tlsMode; if (fingerprint256) body.fingerprint256 = fingerprint256; }
      const result = describeTestResult(await nbx.test(body));
      testOut.textContent = result.text;
      testOut.className = `settings-hint ${result.ok ? 'ok' : 'err'}`;
      if (result.offerPin) {
        pinBtn.hidden = false;
        pinBtn.onclick = () => {
          fingerprint256 = result.offerPin;
          tlsMode = 'pin';
          (tlsGroup.querySelector('input[value="pin"]') as HTMLInputElement).checked = true;
          renderFp();
          pinBtn.hidden = true;
          testOut.textContent = 'fingerprint pinned — run Test Connection again';
          testOut.className = 'settings-hint';
        };
      }
    } catch (ex) {
      testOut.textContent = ex instanceof Error ? ex.message : 'test failed';
      testOut.className = 'settings-hint err';
    } finally { testBtn.disabled = false; }
  });

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'settings-clear';
  clearBtn.hidden = !current;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  actions.append(clearBtn, cancel, submit);

  form.append(title, section, field('NetBox URL', url), httpNote, field('API token', token), tlsGroup, testRow, testOut, err, actions);
  backdrop.appendChild(form);
  document.querySelector('#app')!.appendChild(backdrop);
  syncSchemeUi();

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  // Only close on a genuine backdrop click (see the box modal for why mousedown
  // must also have started on the backdrop).
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Remove the NetBox integration settings (including the stored token)?')) return;
    try { await nbx.clear(); close(); }
    catch (ex) { err.textContent = ex instanceof Error ? ex.message : 'could not clear settings'; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const { payload, error } = buildSavePayload(formState());
    if (!payload) { err.textContent = error ?? 'invalid settings'; return; }
    submit.disabled = true;
    try { await nbx.save(payload); close(); }
    catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : 'could not save settings';
      submit.disabled = false;
    }
  });
}
