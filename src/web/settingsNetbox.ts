// The NetBox tab of the settings modal: URL + write-only token + TLS mode +
// Test Connection (with the TOFU pin offer) + Clear. Form semantics: explicit Save.
import { nbx, type NetboxSettings } from './netbox';
import { buildSavePayload, describeTestResult, splitNetboxUrl, normalizeHostInput, type NetboxFormState } from './settingsForm';
import { field } from './dom';

export async function renderNetboxSection(content: HTMLElement, close: () => void): Promise<void> {
  let current: NetboxSettings | null = null;
  try { current = (await nbx.get()).settings; } catch { /* render empty form */ }

  const form = document.createElement('form');
  form.className = 'settings-section';

  const section = document.createElement('h3');
  section.textContent = 'NetBox API integration';

  const stored = splitNetboxUrl(current?.url ?? '');
  let scheme: 'http' | 'https' = stored.scheme;
  const schemeSel = document.createElement('select');
  for (const value of ['https', 'http'] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value}://`;
    schemeSel.append(opt);
  }
  schemeSel.value = scheme;
  const host = document.createElement('input');
  host.type = 'text';
  host.placeholder = 'netbox.example.com';
  host.value = stored.host;
  host.autocomplete = 'off';
  const urlRow = document.createElement('div');
  urlRow.className = 'settings-url-row';
  urlRow.append(schemeSel, host);

  const token = document.createElement('input');
  token.type = 'password';
  token.placeholder = current?.hasToken ? 'token saved — leave blank to keep' : 'NetBox API token';
  token.autocomplete = 'new-password';

  const httpNote = document.createElement('p');
  httpNote.className = 'settings-hint';
  httpNote.textContent = 'http:// — the token travels in cleartext; LAN use only.';

  const dnsSuffix = document.createElement('input');
  dnsSuffix.type = 'text';
  dnsSuffix.placeholder = 'lan.example.com (optional)';
  dnsSuffix.value = current?.dnsSuffix ?? '';
  dnsSuffix.autocomplete = 'off';
  const suffixHint = document.createElement('p');
  suffixHint.className = 'settings-hint';
  suffixHint.textContent = 'Appended to the hostname as the NetBox record’s dns_name when provisioning (auto-static).';

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
    tlsGroup.hidden = scheme !== 'https';
    httpNote.hidden = scheme !== 'http';
  }
  schemeSel.addEventListener('change', () => { scheme = schemeSel.value as 'http' | 'https'; syncSchemeUi(); });
  host.addEventListener('input', () => {
    const norm = normalizeHostInput(scheme, host.value);
    if (norm.scheme !== scheme || norm.host !== host.value) {
      scheme = norm.scheme;
      schemeSel.value = scheme;
      host.value = norm.host;
      syncSchemeUi();
    }
  });

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
    return { scheme, host: host.value, token: token.value, tlsMode, fingerprint256, hasToken: !!current?.hasToken, dnsSuffix: dnsSuffix.value };
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    pinBtn.hidden = true;
    testOut.className = 'settings-hint';
    testOut.textContent = 'Testing…';
    try {
      const body: Record<string, unknown> = { url: `${scheme}://${host.value.trim()}` };
      if (token.value.trim()) body.token = token.value.trim();
      if (scheme === 'https') { body.tlsMode = tlsMode; if (fingerprint256) body.fingerprint256 = fingerprint256; }
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

  const errLine = document.createElement('p');
  errLine.className = 'err';
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

  form.append(section, field('NetBox URL', urlRow), httpNote, field('API token', token), field('DNS suffix', dnsSuffix), suffixHint, tlsGroup, testRow, testOut, errLine, actions);
  content.replaceChildren(form);
  syncSchemeUi();

  cancel.addEventListener('click', close);

  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Remove the NetBox integration settings (including the stored token)?')) return;
    try { await nbx.clear(); close(); }
    catch (ex) { errLine.textContent = ex instanceof Error ? ex.message : 'could not clear settings'; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    const { payload, error } = buildSavePayload(formState());
    if (!payload) { errLine.textContent = error ?? 'invalid settings'; return; }
    submit.disabled = true;
    try { await nbx.save(payload); close(); }
    catch (ex) {
      errLine.textContent = ex instanceof Error ? ex.message : 'could not save settings';
      submit.disabled = false;
    }
  });
}
