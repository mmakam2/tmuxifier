# Boxes & setup jobs

What happens when a box is added: the server-side setup job, the tools checklist, the Claude
Code statusline push, and AI CLI auth seeding. Part of the [Tmuxifier docs](../README.md).

Each terminal runs `ssh -tt <box> "tmux -u new-session -A -s <session>"` (`-u` forces UTF-8
output so glyphs survive a C/POSIX locale). `<session>` is the box's tmux session
name — set per box in the Add/Edit dialog (a type-or-pick field whose ⟳ button fetches the host's
live sessions), defaulting to `web`. Because tmux runs on the box, the session and its processes
survive disconnects. A 45s server-side grace window makes brief reconnects seamless; after that
the local ssh process is dropped while the on-box session keeps running.

Editing a box refreshes its session bubbles automatically from the host, so sessions created
outside Tmuxifier — including from the command line — show up without clicking ⟳. The Edit
dialog can also **create** a session on the box right away (detached, without switching to it):
type a name next to the bubbles and hit Create. It appears as a bubble and in the pane header's
session dropdown, ready to be switched to. Switching the active session — by saving the dialog
with a different pick, or from the [pane header's dropdown](terminal.md) — reconnects every open
terminal for that box to the new session; the old session keeps running on the box.

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
curl, git, the GitHub CLI, Node.js + npm, Bubblewrap, and the Codex, Claude Code, and
Antigravity CLIs — using the same idempotent multi-distro install script, so re-running
provisioning skips anything already installed.

## The Claude Code checkbox

The **Claude Code** entry in that tools checklist is one knob for the whole Claude stack.
Ticking it makes the setup run do three things, each skipping cleanly when already present:

- **Install the CLI** if the box doesn't have it (an existing install is left untouched).
- **Push this host's statusline**: merges a `statusLine` block into the box's
  `~/.claude/settings.json`, preserving every other key in that file.
- **Install the agent-state hook**: a small Claude Code hook that records whether the agent
  is working or waiting for you — the **only** source the dashboard's agent chip, the sidebar
  badge, and the "claude is waiting for input" notifications read. There is no guessing from
  terminal output. The hook never blocks or modifies the agent: it only writes a one-line
  state file under `~/.tmuxifier-agent/`, and its settings.json entries are merged
  alongside any hooks you already have, never over them.

On a box with a pre-existing Claude install, ticking the checkbox simply adds whatever is
missing. Unchecked means setup touches nothing Claude-related — no install, no statusline,
no hook refresh. So if the agent chip or badge is missing for a running claude: open the
box's Edit dialog, tick **Claude Code**, save, and once the setup job reports done, restart
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
  → your saved script → tmux session created
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
