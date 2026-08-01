# README restructure — design record (2026-08-01)

## Goal

The README had grown to ~1030 lines. Restructure it into a ~300-line overview + quickstart,
moving every deep dive into topic guides under `docs/`, without losing any content.

## Decisions

- **README depth:** overview + quickstart. Keeps intro, screenshots, requirements, setup, an
  essentials-only configuration table, the architecture diagram, one short linking section per
  feature area, a condensed security section, deployment pointer, attributions, development.
- **Docs layout:** grouped topic guides rather than one file per old README section or a single
  manual.

## File map

| New file | Absorbed README sections |
| --- | --- |
| `docs/configuration.md` | Configuration (full option table, TLS/proxy notes, `config.json`, terminal font, settings modal tour) |
| `docs/authentication.md` | Authentication + Passkeys |
| `docs/boxes-and-setup.md` | How persistence works (setup jobs, tools checklist, statusline push, AI CLI auth seeding) |
| `docs/terminal.md` | Split terminals; Pasting images & files; Voice dictation; Host Shell & per-box Reconnect |
| `docs/dashboard.md` | Standby dashboard; Tile icons; Pi-hole/TrueNAS/UniFi/Immich tiles |
| `docs/fleet-and-health.md` | Status, multiplexing & rate-limit safety; Box health history & events; Fleet Command |
| `docs/proxmox.md` | Proxmox LXC provisioning (incl. shell-framework update clamps); Proxmox guest lifecycle |
| `docs/DEPLOY.md` (existing) | Deployment (gained the inline systemd unit listing; cross-links updated) |

Content moved verbatim except: section headings promoted/demoted to fit each file, cross-README
anchor links rewritten to cross-file links, and two small transition phrases ("below"/"above")
adjusted where the referent moved to another file.

## Deliberate content changes

- The README Security section's "only credentials Tmuxifier persists" list was stale — it
  predated the credentialed service tiles. The rewritten section now includes the
  `data/services.json` secrets (Pi-hole app password, TrueNAS/UniFi/Immich API keys).
- A new README **Documentation** section tables all guides.
- CLAUDE.md/AGENTS.md "Docs" lists gained the new guides, marked as living documentation.

## Verification

- Script-verified every relative link and `#anchor` across README + all `docs/*.md` against
  computed GitHub heading slugs.
- Script-verified every `TMUXIFIER_*` variable named in the old README still appears in the
  new corpus.
