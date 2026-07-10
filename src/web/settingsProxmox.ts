// The Proxmox tab of the settings modal: host profiles (endpoint/token/TLS)
// and LXC secrets (default key, additional SSH keys, root password).
// Immediate-CRUD semantics, moved from the Proxmox hub.
import { pve } from './proxmox';
import { el, input, field, err } from './dom';

export async function renderProxmoxSection(content: HTMLElement): Promise<void> {
  const rerender = () => { void renderProxmoxSection(content); };
  const [hostsPart, secretsPart] = await Promise.all([hostsSection(rerender), secretsSection(rerender)]);
  content.replaceChildren(hostsPart, el('hr', { class: 'pve-hr' }), secretsPart);
}

// --- Hosts (moved from proxmoxUi.ts renderHosts) ---
async function hostsSection(rerender: () => void): Promise<HTMLElement> {
  const hosts = await pve.hosts().catch(() => []);
  const list = el('div', { class: 'pve-list' }, hosts.map((h) => {
    const status = el('span', { class: 'pve-test-status', 'aria-live': 'polite' });
    const testBtn = el('button', { type: 'button', onclick: async () => {
      status.className = 'pve-test-status pending'; status.textContent = '…'; status.title = 'Testing…';
      try {
        await pve.testHost(h.id);
        status.className = 'pve-test-status ok'; status.textContent = '✓'; status.title = 'Reachable';
      } catch (e) {
        status.className = 'pve-test-status err'; status.textContent = '✗'; status.title = `Test failed: ${(e as Error).message}`;
      }
    } }, ['Test']);
    return el('div', { class: 'pve-row' }, [
      el('div', {}, [el('strong', {}, [h.name]), el('span', { class: 'pve-sub' }, [` ${h.endpoint} · ${h.verifyMode}`])]),
      el('div', { class: 'pve-row-actions' }, [
        status,
        testBtn,
        el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove host ${h.name}?`)) { await pve.removeHost(h.id); rerender(); } } }, ['Remove']),
      ]),
    ]);
  }));

  const name = input('', { placeholder: 'lab-pve' });
  const endpoint = input('', { placeholder: 'pve.example.com:8006' });
  const tokenId = input('', { placeholder: 'user@pam!tmuxifier' });
  const tokenSecret = input('', { placeholder: 'token secret (uuid)', type: 'password' });
  const defaultNode = input('', { placeholder: 'pve (optional default node)' });
  const fpLine = el('div', { class: 'pve-sub' }, ['Click Inspect to fetch and pin the TLS certificate.']);
  let verifyMode: 'pin' | 'ca' | 'insecure' = 'pin';
  let fingerprint256: string | null = null;
  const box = el('div', {});

  const inspectBtn = el('button', { type: 'button', class: 'pve-btn', onclick: async () => {
    try {
      const r = await pve.inspect(endpoint.value.trim());
      if (!r.reachable) { fpLine.replaceChildren(err(r.error || 'unreachable')); return; }
      fingerprint256 = r.fingerprint256;
      verifyMode = r.caValid ? 'ca' : 'pin';
      fpLine.replaceChildren(`${r.caValid ? 'CA-valid ✓ (will verify normally)' : 'self-signed → pin'} · ${r.fingerprint256 || ''}`);
    } catch (e) { fpLine.replaceChildren(err((e as Error).message)); }
  } }, ['Inspect']);

  const save = el('button', { type: 'submit', onclick: async (e) => {
    e.preventDefault();
    box.querySelector('.pve-err')?.remove();
    if (verifyMode === 'pin' && !fingerprint256) { box.append(err('Inspect the endpoint first to pin its certificate.')); return; }
    try {
      await pve.addHost({ name: name.value.trim(), endpoint: endpoint.value.trim(), tokenId: tokenId.value.trim(), tokenSecret: tokenSecret.value, verifyMode, fingerprint256, defaultNode: defaultNode.value.trim() || null });
      rerender();
    } catch (er) { box.append(err((er as Error).message)); }
  } }, ['Add host']);

  box.append(
    el('h3', {}, ['Add a Proxmox host']),
    field('Name', name), field('Endpoint', endpoint), field('Token id', tokenId), field('Token secret', tokenSecret),
    el('div', { class: 'pve-inline' }, [inspectBtn, fpLine]),
    field('Default node', defaultNode),
    el('div', { class: 'modal-actions' }, [save]),
  );
  return el('div', {}, [list, el('hr', { class: 'pve-hr' }), box]);
}

// --- LXC Secrets (moved from proxmoxUi.ts renderSecrets) ---
async function secretsSection(rerender: () => void): Promise<HTMLElement> {
  const [keys, dk, pw] = await Promise.all([
    pve.keys().catch(() => []),
    pve.defaultKey().catch(() => ({ publicKey: null })),
    pve.rootPasswordStatus().catch(() => ({ set: false })),
  ]);

  // Default management key (read-only) — the Tmuxifier host's own key, always injected.
  const defaultSection = el('div', {}, [
    el('h3', {}, ['Default management key']),
    dk.publicKey
      ? el('div', { class: 'pve-row' }, [el('span', { class: 'pve-sub' }, [`Tmuxifier host key (auto-injected): ${dk.publicKey.slice(0, 54)}…`])])
      : el('div', { class: 'pve-err' }, ['No key found in the Tmuxifier host’s ~/.ssh. Create one or set TMUXIFIER_PVE_DEFAULT_PUBKEY, or Tmuxifier won’t be able to connect to provisioned containers.']),
  ]);

  // Additional keys — sealed at rest, shown masked.
  const list = el('div', { class: 'pve-list' }, keys.map((k) => el('div', { class: 'pve-row' }, [
    el('div', {}, [el('strong', {}, [k.name]), el('span', { class: 'pve-sub' }, [' · ••• set'])]),
    el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove key ${k.name}?`)) { await pve.removeKey(k.id); rerender(); } } }, ['Remove']),
  ])));
  const name = input('', { placeholder: 'laptop' });
  const pk = el('textarea', { class: 'pve-textarea', placeholder: 'ssh-ed25519 AAAA… you@example.com', rows: 3 });
  const keyBox = el('div', {});
  const addKey = el('button', { type: 'submit', onclick: async (e) => {
    e.preventDefault(); keyBox.querySelector('.pve-err')?.remove();
    try { await pve.addKey({ name: name.value.trim(), publicKey: (pk as HTMLTextAreaElement).value.trim() }); rerender(); }
    catch (er) { keyBox.append(err((er as Error).message)); }
  } }, ['Add key']);
  keyBox.append(el('h3', {}, ['Additional keys']), el('div', { class: 'pve-sub' }, ['Injected into every provisioned container, alongside the default key.']), list, field('Name', name), field('Public key', pk), el('div', { class: 'modal-actions' }, [addKey]));

  // Root password — optional, write-only.
  const pwBox = el('div', {});
  const p1 = input('', { type: 'password', placeholder: pw.set ? 'enter a new password to replace' : 'root password (optional)' });
  const p2 = input('', { type: 'password', placeholder: 'confirm' });
  const pwActions = el('div', { class: 'modal-actions' }, [
    el('button', { type: 'submit', onclick: async (e) => {
      e.preventDefault(); pwBox.querySelector('.pve-err')?.remove();
      if (p1.value !== p2.value) { pwBox.append(err('Passwords do not match.')); return; }
      try { await pve.setRootPassword(p1.value); rerender(); }
      catch (er) { pwBox.append(err((er as Error).message)); }
    } }, ['Save password']),
  ]);
  if (pw.set) pwActions.append(el('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm('Clear the root password?')) { await pve.clearRootPassword(); rerender(); } } }, ['Clear']));
  pwBox.append(
    el('h3', {}, [pw.set ? 'Root password (••• set)' : 'Root password (optional)']),
    el('div', { class: 'pve-sub' }, ['Set as the container root password on every provision. At least 5 characters. Leave blank for key-only access.']),
    field('Password', p1), field('Confirm', p2), pwActions,
  );

  return el('div', {}, [defaultSection, el('hr', { class: 'pve-hr' }), keyBox, el('hr', { class: 'pve-hr' }), pwBox]);
}
