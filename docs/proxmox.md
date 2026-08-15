# Proxmox

Provisioning LXC containers over the PVE API and managing the power state and retirement of
linked guests — containers and VMs. Part of the [Tmuxifier docs](../README.md).

## Proxmox LXC provisioning

Tmuxifier can provision a "canned" LXC container on a Proxmox VE host over the PVE HTTP API and
auto-add a box pointed at it, so a freshly created container opens straight into a browser terminal.

**1. Create an API token in Proxmox.** *Datacenter → Permissions → API Tokens → Add*. Pick a
user/realm (e.g. `user@pam`), a token id (e.g. `tmuxifier`), and copy the secret (shown once).
**Grant the token its own permissions** — tokens default to "Privilege Separation", so the token has
no rights even when the user does. In a lab, add the token (*Datacenter → Permissions → Add → API
Token Permission*, path `/`, propagate) the built-in **`PVEVMAdmin`** role (container create/start
plus `Datastore.AllocateSpace`/`Datastore.Audit`) **and `PVEAuditor`** (the `Sys.Audit` that lets
the node/storage/bridge dropdowns populate). Together these two roles also cover guest
**lifecycle** for both containers and VMs: PVE's `VM.Audit`/`VM.PowerMgmt`/`VM.Allocate`/`Sys.Audit`
permissions are path-based on `/vms/<vmid>` and don't distinguish container from VM, so the same
grant that lets you manage a linked container already covers a linked VM too — `VM.Audit`/`Sys.Audit`
for the linked-guest inventory and state, `VM.PowerMgmt` for Start/Shutdown/Stop/Reboot, and
`VM.Allocate` for guest deletion (deprovision) — all already included in `PVEVMAdmin` + `PVEAuditor`,
alongside the provisioning datastore privileges above. For a production token, define a **custom
role** granting only those privileges on only the paths it needs rather than the broad lab roles.
Use a privilege-separated token, not full `Administrator`.

**2. Add the host.** **Settings (⚙) → Proxmox → Add a Proxmox host**: enter the endpoint
(`host:8006`), the token id (`user@pam!tmuxifier`) and the secret. Click **Inspect** to fetch and
**pin** the host's TLS certificate (Proxmox ships a self-signed cert; pinning is
trust-on-first-use, like `ssh accept-new`). Save — Tmuxifier verifies the token before storing it.
Removing a host profile and re-adding it later (any name) with the **same endpoint** re-homes any
boxes still linked through the old profile automatically on the next status poll.

**3. Review LXC secrets.** Same **Settings (⚙) → Proxmox** tab, below the host list. Tmuxifier's
own host key is auto-detected and shown as the **default management key** — injected into every
container so Tmuxifier can SSH in (set `TMUXIFIER_PVE_DEFAULT_PUBKEY` if your key isn't at
`~/.ssh/id_*`). Optionally add more **public keys** (e.g. your laptop's) and/or an **optional root
password**. Added keys and the password are encrypted at rest and shown masked after saving; the
private half of any key stays in your own SSH setup — Tmuxifier never stores private keys.

**4. Define a preset and provision.** Back in the dashboard's **Proxmox** hub (the sidebar
button appears once at least one host is configured in Settings): **Presets → Add** a
blueprint (template, CPU/mem/disk, storage, network). Network IP mode is `dhcp`, `static` (a
fixed CIDR + gateway), or `auto-static` — pick just a VLAN on the preset and Tmuxifier
reserves the next free address from the NetBox prefix for that VLAN at provision time (the
gateway is inferred as the prefix's first usable IP and is never handed out), stamps it into the
container, and releases it if provisioning fails or when the container is deprovisioned
(requires the NetBox integration in Settings (⚙) — the `auto-static` option appears once
NetBox is configured (and stays visible on a preset already set to it), and provisioning an
existing `auto-static` preset without NetBox is rejected immediately instead of starting a job). Deprovisioning also deletes any NetBox
IP record matching the box's current IP — including records created by hand — so manually
linked containers don't leave stale IPAM entries behind. An optional **DNS suffix** (e.g.
`lan.example.com`) is appended to the hostname and written to the allocated record's
`dns_name`; the provision form also previews the next available IP for auto-static presets
(non-binding). Then **Provision → pick a preset → enter a
hostname** (optionally a tag, oh-my-tmux/zsh/bash, and the same "Additional tools" checklist as the
Add/Edit Box modal — see [Boxes & setup jobs](boxes-and-setup.md)). Watch the live task log; once
the container is up Tmuxifier installs tmux
(and any selected frameworks/tools) over SSH, then an **Open terminal** button drops you into it.

The hostname becomes the new box's label, and box labels are unique — so a hostname already
taken by a box is refused when you press Provision, before anything is created in Proxmox
(the form also warns as you type). The same check covers the IP for a static preset. This used
to surface only at the very end, when the finished container was linked, leaving a real guest
behind a failed job for you to clean up by hand.

The Provision tab's setup options include a **post-setup script** picker: one of
Fleet Command's saved scripts, run on the container after every other install and
before its tmux session is created. See
[Post-setup script](boxes-and-setup.md#post-setup-script).

### Shell-framework update clamps

Shell-framework auto-updaters are disabled on every box setup — not only when Tmuxifier
installs the framework, so a hand-installed one is covered too. Unattended boxes shouldn't
self-update at a random shell start: that puts a network round trip in front of your session,
bumps versions nobody asked for, and oh-my-zsh's reminder mode blocks the shell outright waiting
for a `Y/n`. Each clamp is applied only where the framework is actually present, so an rc file
that doesn't use one is left alone:

| Framework | What is set | Where |
|---|---|---|
| Oh My Zsh | `zstyle ':omz:update' mode disabled` | `~/.zshrc`, immediately before the `oh-my-zsh.sh` source line |
| Oh My Bash | `DISABLE_AUTO_UPDATE="true"` | `~/.bashrc`, before the `oh-my-bash.sh` source line |
| Oh My Tmux | `tmux_conf_update_plugins_on_launch=false` and `..._on_reload=false` | `~/.tmux.conf.local` |

That last one matters more than it looks: oh-my-tmux ships both flags as `true`, so an unclamped
box runs `git fetch` for tpm and every plugin on **each** tmux server launch and **each** config
reload.

The same clamps are applied to the Tmuxifier host's own shell whenever its local-shell
framework is provisioned (the ✎ host-shell choice, persisted as `localShell` in
`config.json`) — so the host stops prompting too.

**Update deliberately, when you choose to.** Both shell-framework updaters are shell *functions*,
so a non-interactive Fleet Command run has to call the underlying scripts:

```sh
sh ~/.oh-my-zsh/tools/upgrade.sh     # Oh My Zsh  (interactively: omz update)
bash ~/.oh-my-bash/tools/upgrade.sh  # Oh My Bash (interactively: upgrade_oh_my_bash)
git -C ~/.tmux pull                  # Oh My Tmux (plugins: tpm's prefix + U)
```

**Boxes added before this shipped** need one sweep, since the clamps are applied at setup time.
Select every box in Fleet Command and run:

```sh
[ -f ~/.zshrc ] && ! grep -q "^zstyle ':omz:update' mode disabled" ~/.zshrc \
  && sed -i "/oh-my-zsh\.sh/i zstyle ':omz:update' mode disabled" ~/.zshrc
[ -f ~/.bashrc ] && ! grep -q '^DISABLE_AUTO_UPDATE=' ~/.bashrc \
  && sed -i '/oh-my-bash\.sh/i DISABLE_AUTO_UPDATE="true"' ~/.bashrc
[ -f ~/.tmux.conf.local ] \
  && sed -i 's/^tmux_conf_update_plugins_on_launch=true/tmux_conf_update_plugins_on_launch=false/' ~/.tmux.conf.local \
  && sed -i 's/^tmux_conf_update_plugins_on_reload=true/tmux_conf_update_plugins_on_reload=false/' ~/.tmux.conf.local
true
```

The trailing `true` keeps the exit status zero on a box that simply has no oh-my-tmux, so Fleet
Command doesn't report a failure. Re-running is harmless.

**Security.** The API token, any added SSH keys, and the optional root password are **encrypted at
rest** (AES-256-GCM; key derived from your cookie secret) in the gitignored `data/proxmox.json`
(`0600`), and are never sent to the browser. TLS is pinned for self-signed certs and CA-verified
when the host presents a valid certificate. If you rotate `TMUXIFIER_COOKIE_SECRET`, previously-saved
secrets become undecryptable — re-add each Proxmox host (and re-enter keys/password) afterward.

## Proxmox guest lifecycle

Once a box is **linked** to a Proxmox guest — an LXC container or a QEMU VM — Tmuxifier can manage
that guest's power state and retire it. Lifecycle control applies **only to verified linked
guests** — a box with no confirmed Proxmox link stays an ordinary SSH box and exposes none of these
actions. **Provisioning stays LXC-only** (see [Proxmox LXC provisioning](#proxmox-lxc-provisioning)
above); a VM can be linked and lifecycle-managed, but Tmuxifier cannot create one for you.

**Linking is explicit.** A provisioned container is linked automatically; any other box — container
or VM — is linked by hand in **Edit box → Proxmox association** (pick host → node → guest, listed
with a CT/VM label and sorted by VMID; already-linked targets are disabled). Unlinking there never
stops or destroys the guest — it only drops Tmuxifier's record. **Importing boxes never restores
lifecycle authority:** an imported box starts unlinked and must be re-linked deliberately before any
power or deprovision action is offered.

**State comes from a live PVE confirmation.** A guest PVE reports stopped shows a grey **Stopped**
state with its node/VMID instead of a dead terminal; clicking it opens the Proxmox **Guests** tab
focused on that box. A PVE lookup failure never hides an SSH outage — reachability still comes from
SSH, so a genuinely down box still shows red. Guests migrated between nodes are followed
automatically — Tmuxifier updates the stored node on its next status poll — and the same `PVEAuditor`
grant also powers this cluster-wide inventory lookup.

**A VMID that changed kind is never auto-corrected.** VMIDs get reused once a guest is destroyed, so
if the number your box is linked to now belongs to a guest of the *other* kind — a container where
you linked a VM, or vice versa — Tmuxifier shows a **mismatch** state with an explanation instead of
guessing, and the only action offered is **Edit link** to re-point the box. Nothing about the stored
link changes on its own, even the node, until you resolve it by hand.

**Actions** live in the Proxmox hub's **Guests** tab (each row carries a **CT** or **VM** badge, and
the search box filters on it too — type `vm` or `ct` to narrow the list), gated by state: a stopped
guest offers **Start** and **Deprovision**; a running one offers **Shutdown**, **Stop** (a forceful
immediate stop), **Reboot**, and **Deprovision**; a guest PVE can't find offers **Deprovision** as a
local-only link cleanup. Each action runs as a pollable job.

**Shutdown on a VM needs a way to receive it.** Proxmox sends a shutdown request as an ACPI
power-button event; any guest OS running `acpid` or a systemd equivalent handles that with no extra
setup, and the QEMU guest agent (if installed in the guest) gives PVE a second, more reliable path.
A VM with neither — for example one sitting at a boot menu or BIOS prompt with no OS loaded — cannot
act on either signal, so **Shutdown** will run out **Tmuxifier's own** 10-minute job timeout and
fail — Tmuxifier sends PVE no timeout of its own for a plain Shutdown, so PVE's underlying task
keeps waiting even after Tmuxifier gives up on it. A container's Shutdown is on a shorter, PVE-owned
clock: the LXC shutdown API defaults its own timeout to 60 seconds when none is given, so the same
action fails much sooner for a container than for a VM. Use **Stop** for an
immediate power-off, or **Deprovision**, which escalates to a forced stop on its own (see below) once
its grace period passes.

**A paused VM reads as unreachable, not as paused.** Pausing is a VM-only operation — a container
can't be paused — so this is a state the rest of Tmuxifier has no vocabulary for. PVE reports
`paused`, which Tmuxifier folds into `unknown` along with every other state that isn't exactly
`running` or `stopped`; meanwhile the guest's CPU is frozen, so the SSH probe fails and the box
paints red with a connection error. Nothing destructive can follow — an `unknown` guest offers no
lifecycle actions at all — but the reading points at the network when PVE knows the real answer. If
a linked VM goes unreachable for no apparent reason, check whether it is paused in Proxmox before
you debug anything else. Resume it and it returns to normal on the next poll.

**Deprovision** is the destructive path and stays disabled until you type the box's exact label to
confirm. It asks PVE to shut the guest down gracefully, then — this now applies to containers as well
as VMs — hands PVE a 120-second grace period and a force-stop flag on that same request, so PVE
itself escalates to a hard stop if the guest hasn't gone down cleanly by then; there's no window
where Tmuxifier and PVE disagree about whether the guest is still running. Once stopped, Tmuxifier
destroys the guest **and its attached disks/volumes**, **keeps** any independent backup archives,
then removes the local box. The hub's **Activity** tab merges lifecycle and provision jobs
newest-first (history persists to `data/proxmox-lifecycle-jobs.json`).
