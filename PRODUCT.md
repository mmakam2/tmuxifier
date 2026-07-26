# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a self-hosting homelab operator running a fleet of headless Linux
machines (LXC containers, VMs, bare metal) reached over SSH. Each Tmuxifier instance is
single-operator by design: one login, one person's fleet, one person's SSH trust.

Community adoption is an explicit goal (confirmed 2026-07-26): the repo is public and MIT,
and other self-hosters are a real audience. Onboarding, docs, and defaults must work for a
stranger cloning the repo — but the product remains single-operator per instance; multi-user
features are out of scope.

## Product Purpose

A web dashboard that gives every box a persistent browser terminal backed by a tmux session
running **on the box**. Closing the tab, losing the network, or restarting Tmuxifier leaves
work running; reconnecting reattaches the same session. Around that core: grouped box health
monitoring, Fleet Command (one command/script across many boxes), Proxmox LXC provisioning
with NetBox IP allocation, server-side box setup jobs, and local voice dictation.

Success means the operator can walk away — from the tab, the network, or the host — and
trust that work on the boxes continued, that reattaching always lands back in the same
state, and that the dashboard tells them when something needs their attention.

## Positioning

Two claims a neighboring web-terminal product (ttyd, wetty, Guacamole-style gateways) could
not truthfully copy:

- **Stores no SSH secrets.** Tmuxifier shells out to the operator's OpenSSH client and
  borrows their existing keys, agent, and `~/.ssh/config`. There is no credential vault to
  breach or migrate.
- **The middlebox is disposable.** Session state lives in tmux on each box, not in
  Tmuxifier. Restarting or even losing the Tmuxifier host loses nothing but convenience.

## Core Job

When priorities conflict, the job Tmuxifier most has to be great at is **supervising AI
coding agents** (Claude Code, Codex) working across the fleet (confirmed 2026-07-26):
knowing when an agent is working, idle, or waiting for input; reattaching to its session
instantly; seeding boxes with the host's AI CLI credentials; pushing the operator's
statusline. Persistent terminals, provisioning, and health monitoring all serve this job.

## Operating Context

- Runs as a systemd service on a LAN host, self-contained in the repo folder; binds
  `127.0.0.1` by default and is exposed only behind TLS.
- The surrounding homelab: a Proxmox VE cluster (LXC provisioning), NetBox (IPAM — IP
  allocation and `dns_name` write-back), and the operator's existing SSH setup as the trust
  root for every connection.
- **Primary scene: a desktop browser at a workstation.** **Secondary scene (confirmed
  2026-07-26): phone check-ins** — opening the dashboard on a phone to check box health or
  an agent's progress. Monitoring must be genuinely usable on small screens; driving
  terminals and fleet actions from a phone is not a design target.
- Voice dictation is transcribed by a local whisper.cpp process; audio never leaves the host.

## Capabilities and Constraints

Capabilities (shipped): persistent reattachable terminals (xterm.js + on-box tmux over SSH
ControlMaster); grouped box list with reachability, resource metrics, sparklines, and health
events; agent idle/done detection with browser notifications; Fleet Command with bounded
concurrency and persisted job history; Proxmox LXC provisioning from presets with auto
box-linking and server-side setup jobs (tools catalog, shell frameworks, AI auth seeding,
statusline push); NetBox next-free-IP allocation and release; password, Google OAuth, and
passkey login (passkey-only mode with `.env` break-glass); terminal file uploads with
pane-aware path injection; local voice dictation; box list export/import.

Durable constraints:

- **Self-contained principle**: configuration, secrets, and runtime state live inside the
  repo folder; no `$HOME`-level dependencies beyond the operator's SSH setup.
- **No SSH secrets stored**; the few stored credentials (Proxmox API token, NetBox token,
  management keys) are AES-256-GCM sealed at rest and never returned to the browser.
- The login gate is the security crown jewel — Tmuxifier can SSH into the whole fleet.
- The GitHub repo is public: committed files never contain real hostnames, IPs, emails, or
  box names; placeholders only.
- Node 20+, ESM everywhere; server is dependency-light plain JS, client is TypeScript;
  TDD with real code, not mocks.

Terminology: **box** (a managed machine), **fleet** (all boxes), **Fleet Command** (run
across selected boxes), **provision** (create an LXC and link it as a box), **seed** (copy
host AI CLI credentials to a box), **Host Shell** (terminal on the Tmuxifier host itself),
**hub** (the Proxmox operations modal).

## Brand Commitments

- Name: **tmuxifier** (lowercase nameplate in-product).
- Logo: `src/web/assets/tmuxifier-logo.png`.
- License: MIT.

## Evidence on Hand

- Real product screenshots: `docs/screenshots/dashboard.png`, `fleet-command.png`,
  `proxmox-provision.png` (used in README).
- README.md documents real setup, configuration, and security posture.
- No testimonials, case studies, user counts, or benchmarks exist — future marketing or
  landing surfaces must not fabricate any.

## Product Principles

1. **The box is the source of truth.** Work lives in tmux on the box; Tmuxifier stays
   disposable. Never move session state into the middle.
2. **Never hold what you can borrow.** SSH trust comes from the operator's existing setup;
   the few secrets that must be stored are sealed, redacted on read, and never shipped to
   the browser.
3. **The operator's attention is the product.** Surface the edges that matter — agent
   waiting, box down, key changed — and stay quiet when the operator is already watching.
4. **A stranger can clone it and run it.** Self-contained layout, placeholder counterparts
   for every secret file, working defaults; adoption by other self-hosters is a goal, not
   an accident.
5. **Never lock the operator out.** Every hardening step ships with a recovery path
   (passkey-only arming proves a live credential and has an `.env` break-glass; corrupt
   stores fail open where failing closed would brick fleet access).

## Accessibility & Inclusion

No product-specific user requirement was established, but WCAG 2.1 AA is treated as a
working release bar: the interaction layer is keyboard-operable with screen-reader
semantics (v1.14.2 accessibility pass), and every animation has a reduced-motion
alternative that preserves the state change. The phone check-in scene (above) makes
small-screen monitoring an accessibility-adjacent commitment, not an afterthought.
