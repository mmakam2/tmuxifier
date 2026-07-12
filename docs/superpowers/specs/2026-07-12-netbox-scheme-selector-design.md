# NetBox settings scheme selector — design

Date: 2026-07-12
Status: implemented same-session (autonomous run); pending owner review

## Problem

The NetBox settings tab takes one free-text URL including the scheme. The TLS options already
hide when the typed URL isn't `https://`, but the scheme lives inside the text field: it's easy
to typo, the visibility rule is invisible until you type the right prefix, and the http
cleartext warning appears only after `http://` is fully typed.

## Goal

An explicit `http`/`https` selector next to a scheme-less host field. The TLS verification
options (ca / pin / insecure + fingerprint hint) render only when `https` is selected; the
cleartext-token warning renders only when `http` is selected.

## Approaches considered

1. **Scheme select + scheme-less host input; stored `url` stays canonical (chosen).** Pure
   split/compose helpers in `settingsForm.ts` keep the logic unit-testable; the server, API
   payloads, and `data/netbox.json` shape are untouched (`assertSettingsInput` already derives
   TLS applicability from the URL scheme).
2. Keep the single URL input and add a selector that rewrites the text prefix. Two sources of
   truth inside one string; typos still possible; rejected.
3. Store the scheme as a separate settings field. Server schema change and migration for
   something derivable from `url`; rejected (YAGNI).

## Design

All changes are client-side, in the two NetBox settings modules.

### `src/web/settingsForm.ts` (pure helpers)

- `NetboxFormState` replaces `url: string` with `scheme: 'http' | 'https'` and `host: string`
  (host may carry an optional port and path, e.g. `192.168.1.20:8000/netbox`).
- New `splitNetboxUrl(url: string): { scheme: 'http' | 'https'; host: string }` — parses a
  stored URL into the two controls; empty or scheme-less input defaults to
  `{ scheme: 'https', host: <input> }`.
- New `normalizeHostInput(scheme, raw): { scheme, host }` — if the host field receives a full
  URL (pasting from a browser tab is the common case), the pasted scheme wins and the selector
  follows; the scheme prefix is stripped from the host text. Otherwise returns the inputs
  unchanged.
- `buildSavePayload` composes `url = `${scheme}://${host}`` and keeps the existing validation
  flow; the empty-host error becomes "NetBox host is required". TLS fields go into the payload
  only when `scheme === 'https'`.
- `isHttps` is removed: both consumers (the TLS-group visibility check and the Test Connection
  body builder) now read the selector directly.

### `src/web/settingsNetbox.ts` (tab wiring)

- The URL field becomes one field row holding a `<select>` (`https` first/default, `http`) and
  the host input (placeholder `netbox.example.com`). Stored settings load through
  `splitNetboxUrl`.
- `syncSchemeUi` keys off the select: TLS fieldset hidden unless `https`; the cleartext note
  hidden unless `http`. It runs on select `change`, on host `input` (after
  `normalizeHostInput`, which may flip the select), and once at render.
- Test Connection and Save both build the URL via the same composed form state, so the
  behavior of `nbx.test` / `nbx.save` payloads is unchanged for equivalent input.

### Unchanged

Server validation (`netboxValidate.js`), routes, storage shape, and `netbox.ts` types. A stored
`http://` URL round-trips: it loads as `scheme=http`, shows no TLS options, and saves back
without TLS fields — exactly as before.

## Error handling

- Empty host → save blocked with "NetBox host is required" (same explicit-Save semantics).
- Junk that `new URL` rejects is still caught server-side by `parseNetboxUrl` on save/test and
  surfaced in the existing error line; the client stays permissive.

## Testing

`test/settingsForm.test.js` (node-env vitest, pure functions): `splitNetboxUrl` round-trips
https/http/scheme-less/empty; `normalizeHostInput` passes plain hosts through and adopts a
pasted scheme (case-insensitive, with path preserved); `buildSavePayload` cases updated to the
scheme+host state, including: https composes TLS fields, http omits them, empty host errors,
pin-without-fingerprint still errors. The `isHttps` test is removed with the helper.

Manual: selector defaults to https on an empty form; switching to http hides TLS options and
shows the cleartext warning; pasting `http://…` into the host flips the selector.

## Out of scope

- The Proxmox host settings tab: PVE's API (`pveproxy` on 8006) is HTTPS-only, so a scheme
  selector there would offer a choice that cannot work.
