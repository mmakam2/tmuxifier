# Settings modal + NetBox API integration setup — design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with owner)

## Goal

Add a settings surface to the dashboard: a gear icon in the sidebar brand actions that opens a
settings modal. The first settings section configures the NetBox API integration — URL, API
token, TLS handling, and a Test Connection probe.

**Long-term vision (context, not this phase):** NetBox IPAM becomes the source of truth for
provisioning — validate available IPs before Proxmox provisioning, release IPs on
decommissioning, and eventually enrich/sync box metadata from NetBox.

**This phase stops at:** settings UI + persisted connection settings + Test Connection. No IPAM
lookups in the provisioning flow yet.

## Approach decision

Persist NetBox settings as a per-feature store following the existing Proxmox pattern
(`data/netbox.json` + `secretBox` sealing), rather than a generic `data/settings.json` or `.env`
writes. Rationale: inherits the proven security posture (AES-256-GCM at rest, `0o600`, redacted
reads) and the test patterns; `.env` would leave the token unencrypted and imply restart
semantics. Future settings sections can each get their own store — the **modal** is the shared
surface, not the file.

## UI

- Gear button `⚙` (`id="settings"`, `type="button"`, title/aria-label "Settings") in
  `.brand-actions` in `main.ts`, between `#sidebar-toggle` and `#export`.
- Opens a settings modal using the existing `modal-backdrop` / `modal` pattern, somewhat wider
  than the box-edit modal. Section heading structure so future sections slot in; "NetBox" is the
  only section now. New client module `src/web/settingsUi.ts`.

### NetBox section fields

- **URL** — accepts `http://` and `https://`. When `http://`, show an inline note that the token
  travels in cleartext (LAN-only advisory).
- **API token** — write-only, like the Proxmox token: the server never returns it; the UI shows a
  "token is set" state when one exists; leaving the field blank on save keeps the stored token.
- **TLS verification** (visible for `https://` only): `CA-verified` (default), `pinned
  fingerprint` (TOFU — a failed-verify or inspect response surfaces the server's certificate
  fingerprint with an option to pin it, like Proxmox `inspectEndpoint`), or explicit `insecure`
  (off by default, discouraged in the UI).
- **Test Connection** button — server-side probe of NetBox `GET /api/status/` using the stored
  (or just-entered) settings. Success shows the NetBox version as proof of life. A 403 error hint
  mentions NetBox token allowed-IP lists, including the IPv4-mapped-IPv6 form (`::ffff:a.b.c.d`)
  that source addresses can take.
- **Clear** button — removes the stored integration (with confirm).

## Server

New modules following the factory/DI conventions:

- `src/server/netboxValidate.js` — pure validators/parsers: URL (scheme/shape), token (non-empty,
  sane charset/length), fingerprint format, TLS mode enum. No I/O.
- `src/server/netboxStore.js` — `createNetboxStore({ dataDir, secretBox })`: CRUD for
  `data/netbox.json`, written `0o600`. Token sealed via `secretBox` on write; reads are redacted
  to `hasToken`. `getSettings({ withSecret: true })` is the only decrypting path (server-internal).
- `src/server/netboxApi.js` — dependency-free client over `node:http`/`node:https` implementing
  the three TLS modes (CA-verified / pinned fingerprint / insecure) plus plain HTTP;
  `testConnection(settings)` hits `/api/status/` with `Authorization: Token …`. The token never
  leaves the server.

Routes in `server.js`, behind the existing auth gate:

- `GET /api/netbox/settings` — redacted settings (`{ url, tlsMode, fingerprint, hasToken }` or
  empty state).
- `PUT /api/netbox/settings` — validate via `netboxValidate`, seal + persist. Blank token field
  keeps the existing token.
- `POST /api/netbox/test` — run `testConnection`; body may carry unsaved form values (with the
  blank-token-means-stored-token rule) so users can test before saving. Response includes NetBox
  version on success, and on TLS verification failure includes the observed fingerprint so the UI
  can offer to pin it.

## Error handling

- Validation errors return 400 with a field-level message; the modal shows them inline.
- Test Connection distinguishes: unreachable / TLS verification failed (with fingerprint offer) /
  401-403 auth failure (with the allowed-IP hint) / non-NetBox endpoint (unexpected response
  shape).
- Store reads tolerate a missing `data/netbox.json` (returns empty state); corrupt JSON surfaces
  a clear error rather than silently resetting.

## Testing (TDD, real code, no mocks)

- `netboxValidate` unit tests: accept/reject matrices for URL, token, fingerprint, TLS mode.
- `netboxStore` unit tests against real temp dirs: seal/redact round-trip, `0o600` mode,
  blank-token-keeps-existing, clear.
- Route integration tests: auth required; redaction invariant (raw token string never appears in
  any response body); PUT/GET round-trip; test endpoint error mapping (can use a local throwaway
  HTTP server acting as a fake NetBox, consistent with the existing sshd-backed e2e approach).
- Client: any pure helpers extracted (e.g., form → payload mapping) get unit tests.

## Docs & housekeeping

- CLAUDE.md / AGENTS.md architecture lists gain the three new server modules and `data/netbox.json`
  (gitignored; created at runtime via the UI — that is its placeholder story).
- README security notes: NetBox token joins the "encrypted at rest, never returned to the
  browser" set alongside the Proxmox secrets.

## Out of scope (future phases)

- IP availability validation during Proxmox provisioning.
- IP release on decommissioning workflows.
- Enrichment/sync of box metadata from NetBox.
