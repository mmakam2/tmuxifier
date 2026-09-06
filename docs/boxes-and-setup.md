# Boxes & setup jobs

What happens when a box is added: the server-side setup job, the tools checklist, the Claude
Code statusline push, and AI CLI auth seeding. Part of the [Tmuxifier docs](../README.md).

Each terminal runs `ssh -tt <box> "tmux -u new-session -A -s <session>"` (`-u` forces UTF-8
output so glyphs survive a C/POSIX locale). `<session>` is the box's tmux session
name — set per box in the Add/Edit dialog's **tmux session** dropdown, defaulting to `web`.
The dropdown carries the same hierarchy as the [pane header's](terminal.md): every live
session (from the cached status snapshot, or a fresh probe via ⟳) with its windows indented
beneath it, plus a `Create New Session…` row that reveals a free-text field for a session that
doesn't exist yet. Because tmux runs on the box, the session and its processes survive
disconnects. A 45s server-side grace window makes brief reconnects seamless; after that the
local ssh process is dropped while the on-box session keeps running.

Editing a box refreshes the dropdown automatically from the host, so sessions and windows
created outside Tmuxifier — including from the command line — show up without clicking ⟳.
Picking a window row there acts immediately: it's a live tmux window-select on the box, not
form state, so it doesn't wait on Save — the session half is still written on Save like any
other field, and a failed live switch snaps the dropdown back rather than saving a change
that never happened. Picking a window that belongs to a *different* session moves that
session's window on the box straight away too, but the pane won't show it until Save
switches the box over, which is what the hint under the dropdown says. Add mode has no box
yet to run a live window-select against, so once you ⟳ a host's sessions their windows
appear in the dropdown for orientation but disabled — `web (default)` and `Create New Session…`
are the only rows you can actually pick until the box exists.

The Edit dialog can also **create** a session on the box right away (detached, without
switching to it): type a name below the dropdown and hit Create. It appears in the dropdown
and in the [pane header's](terminal.md), ready to be switched to. Switching the active
session — by saving the dialog with a different pick, or from the pane header's dropdown —
reconnects every open terminal for that box to the new session; the old session keeps
running on the box.

## The setup job

When a box is added, Tmuxifier persists the box immediately and starts a **server-side setup
job**. The job checks for `tmux`, installs it through a known package manager when possible
(`apt-get`, `dnf`, `yum`, `pacman`, `apk`, or `zypper`), applies any selected shell/theme
options and tools, and creates the configured tmux session last. Because the job runs on the
server rather than in the page, closing the panel — or the tab, or losing the network — does not
interrupt it; reopening shows the same job still running.

A failed setup **keeps the box**. The panel offers **Retry**, and removal is a separate,
explicit action, so a box is never silently withdrawn from your list. Two cases surface their own
button instead of a plain error: a sudo-password prompt or a password-authenticating box stalls
the job as *needs interactive*, with **Finish interactively** opening a real terminal to answer
it. While a box's setup job is still running, clicking that box shows the live setup panel rather
than a terminal — a shell started mid-setup would hold an environment predating the tools and
credentials being installed.

Removing a box closes any local terminal process for that box and best-effort kills the
configured remote tmux session before deleting the box. It does **not** forget the host's
`known_hosts` entry: the machine still exists, and that file is shared with your ordinary ssh
usage.

## Additional tools

The Add/Edit Box modal (and the [Proxmox Provision form](proxmox.md)) also offer an **"Additional
tools"** checklist that runs in the same provisioning step — a full system update/upgrade,
curl, git, the GitHub CLI, Node.js 24 + npm, Bubblewrap, and the Codex, Claude Code, and
Antigravity CLIs — using the same idempotent multi-distro install script, so re-running
provisioning skips anything already installed.

Node.js is the one entry that does more than install-if-missing. Debian and Ubuntu archives
ship a Node several majors behind (both Debian 12 and Ubuntu 24.04 carry 18), older than the
agent CLIs want, so on apt-, dnf- and yum-based boxes the tool installs the pinned major from
[NodeSource](https://github.com/nodesource/distributions) instead; Arch, Alpine and openSUSE
keep their own current packages. The check is on the version, not just presence: re-running
setup with Node.js ticked upgrades a box whose Node is older than the pin, removing the
distro's `npm` and `libnode-dev` packages first (the NodeSource package bundles npm and
ships the headers libnode-dev owns, so neither can stay). A box already at or above the pin
is left alone.

## The Claude Code checkbox

The **Claude Code** entry in that tools checklist is one knob for the whole Claude stack.
Ticking it makes the setup run do four things, each skipping cleanly when already present:

- **Install the CLI** if the box doesn't have it (an existing install is left untouched).
- **Push this host's statusline**: merges a `statusLine` block into the box's
  `~/.claude/settings.json`, preserving every other key in that file.
- **Install the agent-state hook**: a small Claude Code hook that records whether the agent
  is working or waiting for you — the **only** source the dashboard's agent chip, the sidebar
  badge, and the "claude is waiting for input" notifications read. There is no guessing from
  terminal output. The hook never blocks or modifies the agent: it only writes a one-line
  state file under `~/.tmuxifier-agent/`, and its settings.json entries are merged
  alongside any hooks you already have, never over them.
- **Prepare the voice link**: writes a user-level ALSA config (`~/.asoundrc`) that makes the
  box's default microphone a pipe Tmuxifier feeds from your browser, creates that pipe under
  `~/.tmuxifier-voice/`, installs `alsa-utils`, and turns Claude Code's voice mode on in its
  settings.json unless you already chose (`/voice off` stays off). A box that already has its own
  `~/.asoundrc` is left alone and the step reports `skipped`. See [Voice dictation](terminal.md#voice-dictation)
  for what the link does. The pipe is fed by a small Python program the step installs on the box
  (`~/.tmuxifier-voice/writer.py`): your browser's audio while a link is up, and otherwise
  **silence, in real time**, from a tiny resident feeder the step starts — so pressing Space in
  Claude Code while nothing is linked simply ends with Claude's own "No speech detected". That
  feeder costs nothing while nobody is listening (its write just blocks), a link takes it over
  and hands back to it when the link ends, and a `SessionStart` hook the step adds to Claude
  Code's settings re-starts it after a reboot (`~/.tmuxifier-voice/ensure.sh`, a no-op while one
  is running). The device the config names, `~/.tmuxifier-voice/mic`, is a symlink onto the
  real pipe (`mic.fifo`, beside it) while something feeds it, and onto a path that does not exist
  after a clean shutdown — so a press then fails with an error rather than a hang (a pipe nobody
  feeds blocks forever) or a crash (a source that never blocks, such as `/dev/zero`, makes ALSA
  capture spin at CPU speed until the box is out of memory; that was v1.24.59). A box without
  `python3` gets no voice link at all (the step reports `skipped`) rather than an unsafe
  substitute. What the pipe carries is whatever Claude Code negotiates with ALSA, and the step
  picks one of two recipes for it: on a VM or a bare-metal box Claude reads the pipe directly
  and hears you at full quality (`pipe=direct` in the setup log); in an unprivileged LXC
  container the kernel may cap every pipe at 8 KB — pipe memory is accounted per user across
  the whole host, and a container's root is the same host user on every container — which is
  too small for Claude's reads, so the step falls back to the recipe that puts ALSA's rate
  converter in the way (`pipe=rate`): it works, with speech reaching Claude slightly
  stretched. To get the direct recipe on containers, set `fs.pipe-user-pages-soft = 0` on the
  Proxmox host (a line in `/etc/sysctl.d/`, then `sysctl --system`; it lifts a limit that only
  guards against unprivileged users hoarding pipe memory) and re-run setup with Claude Code
  ticked — the choice is made when the step runs, and a running `claude` must be restarted to
  read the new recipe.

Two things are worth knowing before you tick it on a box that isn't a plain headless server.
First, the ALSA config claims the **default** device: on a box that has real audio hardware and
no `~/.asoundrc` of its own, capture becomes your browser microphone and playback goes to
`/dev/null` for every program that asks for `default`. A box that already has an `~/.asoundrc`
is never touched (the step reports `skipped`), so writing your own config is how you keep a
real sound card. Second, ticking **Claude Code** now performs a package install over sudo
(`alsa-utils`, unless `arecord` is already there) — so on a box that needs a sudo password the
setup job parks at **needs sudo** and waits for you to finish it interactively, where before it
might have completed unattended.

On a box with a pre-existing Claude install, ticking the checkbox simply adds whatever is
missing. Unchecked means setup touches nothing Claude-related — no install, no statusline,
no hook refresh, no voice link. So if the agent chip or badge is missing for a running claude:
open the box's Edit dialog, tick **Claude Code**, save, and once the setup job reports done, restart
claude in that session (Claude Code reads its hooks at startup).

To remove the hook from a box: delete the five `tmuxifier-agent-hook` entries from the box's
`~/.claude/settings.json` and `rm -rf ~/.tmuxifier-agent`. With it removed, that box reports
no agent state at all; the next setup run with Claude Code ticked reinstalls it.

## Seeding AI CLI auth

Both surfaces also offer a **"Seed AI CLI auth (claude/codex) from this host"** checkbox
(unchecked by default). Ticking it copies the *Tmuxifier host's own* AI CLI subscription
credentials onto the box once its setup job reports done: a Claude Code OAuth token and/or the
host's live Codex login. This needs one-time setup on the Tmuxifier host itself, per CLI you want
seeded — skip either one and that target is silently skipped per box:
- **Claude**: run `claude setup-token` on the Tmuxifier host and put its output in `.env` as
  `TMUXIFIER_CLAUDE_OAUTH_TOKEN=sk-ant-oat-EXAMPLE`.
- **Codex**: run `codex login` on the Tmuxifier host so `~/.codex/auth.json` exists there —
  Tmuxifier reads it live at seed time and never stores a copy of its own.

The form shows per-CLI readiness next to the checkbox — a CLI that isn't set up on the
Tmuxifier host shows the exact command to run (`claude setup-token` / `codex login`), and the
checkbox is disabled when there is nothing to seed yet.

Either secret travels to the box over stdin on the same SSH connection used for provisioning —
never in a command line, a script file, a log, or an API response. **Seeding hands that box your
Claude and/or Codex subscription identity, exactly as if you'd logged in on it yourself — seed
only boxes you trust the way you'd trust anyone holding your own login.**

## Post-setup script

The setup form's last section picks one of Fleet Command's **saved scripts** to run
on the box once everything else is installed. The order is deliberate:

```
tools & shell framework → AI-auth seeding → Claude statusline → agent hooks
  → voice link → your saved script → tmux session created
```

Your script runs *before* the box's tmux session exists, so anything it writes to
`.zshrc`, `.bashrc` or `.tmux.conf` is picked up by that session's first shell. It
runs non-interactively over the same SSH connection as the rest of setup, so it
cannot answer a sudo password prompt — use a box that sudoes without one, or run
the script from Fleet Command afterwards.

The picker appears in both the Add/Edit Box modal and the Proxmox hub's Provision
tab. Selecting **None** (the default) runs nothing.

**A failing script never fails the setup job.** Everything Tmuxifier installed
succeeded and the box is usable, so the job still reaches `done` and the result is
reported on its own line — `bootstrap failed (exited 2)` — with the script's full
output in the job log above it. Re-run it from Fleet Command once you have fixed it;
retrying the setup would reinstall everything just to retry the script.

The script is resolved by id when it runs, not snapshotted when you pick it, so
editing it between clicking Provision and the phase starting means the edited
version runs. One deleted in that window is reported as
`bootstrap skipped (saved script no longer exists)`. The *name* recorded on the job
is frozen, so renaming a script later never rewrites what a past job says it ran.
