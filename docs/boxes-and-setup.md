# Boxes & setup jobs

What happens when a box is added: the server-side setup job, the tools checklist, the Claude
Code statusline push, and AI CLI auth seeding. Part of the [Tmuxifier docs](../README.md).

Each terminal runs `ssh -tt <box> "tmux -u new-session -A -D -s <session>"` (`-u` forces UTF-8
output so glyphs survive a C/POSIX locale; `-D` detaches any
other client so a stale connection can't freeze the layout). `<session>` is the box's tmux session
name — set per box in the Add/Edit dialog (a type-or-pick field whose ⟳ button fetches the host's
live sessions), defaulting to `web`. Because tmux runs on the box, the session and its processes
survive disconnects. A 45s server-side grace window makes brief reconnects seamless; after that
the local ssh process is dropped while the on-box session keeps running.

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

## Push Claude Code statusline

Below that checklist sits **"Push Claude Code statusline"** (unchecked by default). Ticking it
copies *this host's own* Claude Code statusline script to the box and merges a `statusLine` block
into the box's `~/.claude/settings.json`, preserving every other key in that file. The box decides
whether it applies: with no Claude Code installed there the push is a recorded no-op, so ticking it
for a box that gets Claude Code later takes effect the next time setup runs. It runs after the
setup job's other work, and a skip or failure is recorded on the job without failing it.

## Agent-state hooks

Every setup run also installs a small Claude Code hook on the box (skipped automatically when
Claude Code is not installed — there is no checkbox for this one). The hook records whether the
agent is working or waiting for you — the dashboard's agent chip and the "claude is waiting for
input" notifications read this instead of guessing from terminal output, so they react faster
and never false-positive on an idle session. It never blocks or modifies the agent: it only
writes a one-line state file under `~/.tmuxifier-agent/` on the box.

To remove it from a box: delete the five `tmuxifier-agent-hook` entries from the box's
`~/.claude/settings.json` and `rm -rf ~/.tmuxifier-agent`. The next setup run reinstalls it.

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
