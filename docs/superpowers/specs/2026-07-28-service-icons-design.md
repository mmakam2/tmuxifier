# Service tile icons — design

Date: 2026-07-28
Status: approved

## Summary

The `glyph` field on a service record is removed entirely. In its place a service resolves
a real logo — a vendored SVG from a curated catalog, or the service's own scraped favicon
— which the standby dashboard renders in the top row of both plain tiles and the wide
`pihole`/`truenas`/`unifi` cards.

Matching is automatic. A service whose check kind is `unifi`, `truenas` or `pihole` is
identified with certainty from that kind alone; anything else is guessed from the service
name, then from the URL hostname. A Settings control overrides the guess (pick a catalog
entry, or suppress the icon entirely) so a bad guess is never a trap.

The catalog is populated once by `npm run fetch-icons` into gitignored `vendor/icons/`.
At runtime the server never reaches the public internet — the only outbound traffic the
feature adds is a favicon fetch against the LAN service the user already configured.

## Motivation

The glyph model has three problems, and the third is fatal on a real install.

1. **The input is hostile.** A glyph is a free-form string of up to four characters that
   must be a Nerd Font codepoint the bundled Meslo face happens to carry. The Settings
   palette offers ten starters; anything else means finding and pasting a codepoint by
   hand.
2. **The rendering is fragile.** `style.css` carries per-glyph advance-width corrections
   because Nerd Font glyphs do not share a common advance box, and a glyph the bundled
   face lacks silently renders as a replacement box.
3. **It is invisible on the deployments that matter.** Only plain `http`/`tcp`/`none`
   tiles draw a glyph. A `pihole`, `truenas` or `unifi` service renders as a wide card,
   and the card layers never had a glyph slot. On a fleet composed entirely of those check
   kinds the field is dead weight: it validates, persists, and displays nothing.

## Decisions (from brainstorming)

- **Catalog is scraped once, offline thereafter.** A one-time `npm run fetch-icons` pulls
  a pinned slug list from a public icon CDN into `vendor/icons/`. The running server never
  contacts that CDN. The alternative — a lazy per-service CDN lookup on save — was
  rejected because it makes every service creation depend on outbound internet, and this
  project's self-contained principle treats the surrounding network as something the app
  should not need.
- **Catalog lives in gitignored `vendor/`, not committed to the repo.** This mirrors
  `npm run setup-voice` populating `vendor/whisper`, and keeps roughly fifty third-party
  trademarked logos out of a public GitHub repository. The cost is that a fresh clone which
  never runs the script resolves favicons only, which is graceful degradation rather than
  breakage.
- **Matching is automatic with a manual override.** Fully automatic matching with no UI was
  rejected: a service named for its host rather than its software (a Jellyfin box called
  "Media Box") would match nothing with no way to correct it. Picker-only matching was
  rejected as not being the requested behaviour.
- **The icon renders on cards as well as tiles.** Tiles-only placement was rejected because
  it renders nothing at all on the current deployment, whose every service is a card.
- **Icons are served by a dynamic route, not a second static mount.** See
  [Serving](#serving) — this is a correctness requirement, not a preference.
- **Icons are always rendered through `<img>`, never inlined into the DOM.** See
  [Security posture](#security-posture).

## Data model

`glyph` is deleted from `servicesStore.js`'s `normalize()`. Because `normalize()` builds
its output object fresh on every write rather than spreading the stored record, a `glyph`
key already present in `data/services.json` is dropped the next time that service is
updated. To keep it from reaching the browser in the meantime, `redact()` strips it in the
same destructure that strips `secret`:

```js
function redact(svc) {
  const { secret, glyph, ...rest } = svc;
  return { ...rest, hasPassword: !!secret };
}
```

No migration script and no forced rewrite of `data/services.json`. Existing services keep
working and pick up the automatic guess.

`icon` replaces it as an optional string, validated by the same `optionalString` helper
with `max: 64`, and additionally constrained to a slug:

```
ICON_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
```

Three states:

| Stored value | Meaning |
| --- | --- |
| absent | Resolve automatically (the default). |
| `"none"` | Render no icon. The one reserved slug; the catalog never contains it. |
| a slug | Use `vendor/icons/<slug>.svg`, falling back to nothing if absent. |

`null` in a PATCH clears the field back to automatic, consistent with how `glyph` and
`group` already behave.

The slug regex is a security boundary, not input hygiene: the value becomes a path
component. See [Security posture](#security-posture).

## Resolution

### `src/server/iconResolve.js` — pure

```js
slugCandidates(svc) -> string[]   // ordered, deduped, all matching ICON_SLUG
isSafeSlug(s)       -> boolean
```

`slugCandidates` produces, in order:

1. **Check kind.** `unifi` → `unifi`, `truenas` → `truenas`, `pihole` → `pi-hole`.
   Certain rather than guessed: the user declared the software when they chose the check.
   `http`, `tcp` and `none` contribute nothing here.
2. **Service name**, lowercased, non-alphanumerics collapsed to single hyphens, leading and
   trailing hyphens trimmed. `"Grafana"` → `grafana`, `"Home Assistant"` →
   `home-assistant`.
3. **URL hostname's first label**, same normalization. `https://jellyfin.example.com/` →
   `jellyfin`. Dotted-quad hosts yield nothing, since `192` is not a product.

Any candidate failing `ICON_SLUG` after normalization is dropped rather than repaired.

Pure and dependency-free, so it is testable without disk or DOM — the repo's standing
convention for this kind of module.

### `src/server/iconStore.js` — factory

```js
createIconStore({ catalogDir, cacheDir, fetchImpl })
  .resolve(svc)        -> { path, contentType, etag } | null
  .listCatalog()       -> string[]
  .refreshFavicon(svc) -> { ok: boolean, reason?: string }
  .forget(serviceId)   -> void
```

`resolve` walks, first hit wins:

1. `svc.icon === 'none'` → `null`, immediately. An explicit suppression is not a failure to
   fall through.
2. `svc.icon` set → `catalogDir/<icon>.svg`. If absent, fall through rather than 404 — a
   catalog that has not been fetched yet should still yield a favicon.
3. Each `slugCandidates(svc)` entry → `catalogDir/<slug>.svg`.
4. `cacheDir/<serviceId>.<ext>` — the scraped favicon.
5. `null`.

`forget(serviceId)` removes a cached favicon and is called from the service-delete path, so
a removed service does not leave bytes behind in `data/icons/`.

Every path is resolved and then checked to still be inside its directory before any read.
The regex should already make this impossible; the check is defence in depth, and it is the
part that stays correct if the regex is ever relaxed.

## Catalog

`src/server/iconCatalog.js` exports the pinned slug list. It plays exactly the role
`voiceCatalog.js` plays for speech models: the single chokepoint that guarantees no
user-supplied string ever reaches a download. `fetch-icons` iterates this list and nothing
else — there is no "fetch arbitrary slug" path, from the CLI or from the API.

Roughly fifty entries covering the self-hosted set this project's users are likely to run:
the four check kinds (`unifi`, `truenas`, `pi-hole`, `proxmox`), plus the common services —
`grafana`, `prometheus`, `home-assistant`, `jellyfin`, `plex`, `nextcloud`, `portainer`,
`gitea`, `netbox`, `uptime-kuma`, `adguard-home`, `vaultwarden`, `paperless-ngx`,
`immich`, `sonarr`, `radarr`, `qbittorrent`, `traefik`, `nginx-proxy-manager`, `pfsense`,
`opnsense`, `openwrt`, `influxdb`, `minio`, `syncthing`, `frigate`, and similar.

Each slug is confirmed to exist upstream when the list is written; a slug the CDN does not
carry is caught by the run's "missing" summary rather than shipping as a silently dead
entry in the picker.

`scripts/fetch-icons.mjs` (`npm run fetch-icons`), structured after `scripts/setup-voice.mjs`:

- Source: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/<slug>.svg`.
  Verified reachable at time of writing (`200 image/svg+xml`).
- Writes `vendor/icons/<slug>.svg` via temp file plus rename, so an interrupted run never
  leaves a truncated icon in place.
- Idempotent: skips a slug already on disk unless `--force`.
- A slug the CDN does not carry is reported and skipped, never fatal — a single renamed
  upstream icon must not fail the whole run.
- Reports a summary line: fetched, skipped, missing.

**No pinned SHA-256**, deliberately, and this is the one place the design departs from the
`voiceDownload.js` precedent it otherwise follows. A speech model is a fixed artifact whose
hash is the correctness guarantee. A logo is redesigned by its vendor from time to time, so
pinning digests would turn every upstream refresh into a failed run demanding a repo commit
to fix. The guarantees kept instead are the pinned slug list, a content-type check, a size
cap, and the `<img>` rendering rule that makes SVG content inert regardless.

## Serving

Two routes, both behind the existing session auth like every other `/api/*` route.

```
GET /api/services/:id/icon   -> the bytes, or 404
GET /api/icons               -> { slugs: string[] } for the Settings picker
```

`GET /api/services/:id/icon` responds with the resolved file, `Content-Type` from the
resolution, and an `ETag` derived from a hash of the content. A conditional request matching
the ETag gets a 304. 404 when `resolve` returns `null`.

Caching is `private, no-cache`, which is revalidate-every-load rather than don't-cache. The
URL is stable while its content is not — an icon changes under it when a favicon is
refreshed or the catalog is fetched — so a `max-age` would strand a stale logo for its
duration. Paired with the ETag, revalidation costs a 304 and a refreshed icon appears on the
next load.

**This must be a dynamic route rather than a second `@fastify/static` mount.** `index.js`
registers static serving with `wildcard: false`, which registers one route per file *at
boot*. That behaviour is already documented in the deploy checklist as the reason a
freshly-swapped `dist/` requires a restart. Under a static mount the same rule would apply
to `data/icons/`: a favicon scraped after boot would be unservable until the next restart,
which defeats the point of scraping it on save.

**The Content-Security-Policy is unchanged.** `server.js:40` already sets
`img-src 'self' data:`, and every icon is served same-origin by Tmuxifier itself. This was
a design constraint from the start — it is why fetching icons directly from a CDN in the
browser was never an option.

## Favicon fallback

`refreshFavicon(svc)` runs best-effort:

- on service **add**, and on **update** when the URL changed, **only if `resolve` finds no
  catalog match** — a UniFi service already has a real logo, and scraping the controller for
  a favicon it will never display is pure waste,
- from an explicit **Refresh icon** button in the Settings form, which scrapes
  unconditionally, since that is the user asking for exactly this,

and never on the polling path — the sweep interval must not turn into a favicon crawl.

A failure is recorded and returned but never propagated: a service save succeeds whether or
not its favicon could be fetched. Losing an icon is a cosmetic outcome and must not block
configuration.

Procedure:

1. `GET` the service URL. Read at most 64 KB of the response body.
2. If the response is HTML, parse `<link rel="icon">`, `rel="shortcut icon"` and
   `rel="apple-touch-icon"` out of that prefix, preferring the largest declared `sizes`,
   then SVG over raster. Resolve the href against the service URL.
3. Otherwise, or if no link element is found, try `/favicon.ico` at the URL's origin.
4. Enforce a content-type allowlist — `image/svg+xml`, `image/png`, `image/x-icon`,
   `image/vnd.microsoft.icon`, `image/jpeg`, `image/webp` — and a 256 KB cap, aborting the
   stream once exceeded rather than buffering and then rejecting.
5. Write `data/icons/<serviceId>.<ext>` via temp file plus rename.

Redirects are followed to a depth of three, staying within http/https.

TLS uses `rejectUnauthorized: false`, matching `serviceCheck.js:20`. The reasoning already
recorded for the `http`/`tcp` checks applies unchanged: these are LAN hosts with self-signed
certificates, and **no credential is transmitted** — the fetch carries no API key, no
password, no session. The credentialed integrations (Pi-hole, TrueNAS, UniFi) verify TLS by
default precisely because they do send secrets; this fetch does not, so it takes the same
posture as the uncredentialed liveness probes rather than the credentialed clients.

## Security posture

Three distinct concerns, three separate mitigations.

**Path traversal.** The `icon` slug becomes a filename. It is constrained by `ICON_SLUG`
at validation time in `servicesStore.js`, re-checked by `isSafeSlug` before any filesystem
access, and the resolved absolute path is verified to remain inside its directory before
the read. A cached favicon is named from the service id — server-minted
`svc-<randomUUID()>`, never user-controlled — so it is not a traversal surface at all.

**SVG script execution.** An SVG can carry `<script>`, event-handler attributes and
external references, and Tmuxifier serves these files same-origin, so an inline-rendered
malicious SVG would execute in the app's origin. The mitigation is the rendering rule:
icons are **always** loaded through `<img src="…">` and **never** inlined into the DOM.
Browsers load SVG in an `<img>` in a restricted mode with scripting and external references
disabled, which makes the content inert regardless of what the CDN or a LAN host served.
This is why no SVG sanitizer is specified: sanitization would be a weaker guarantee applied
in addition to a stronger one that already holds.

**Server-side request forgery.** `refreshFavicon` fetches a URL derived from one the user
typed into their own single-user dashboard, which the server already dials on every service
sweep. It adds no reachability the `http` check does not already have. The redirect depth
limit and the http/https scheme restriction keep a redirect chain from wandering to another
protocol.

**Outbound internet.** Confined to `npm run fetch-icons`, run deliberately by the operator.
The server process never contacts the CDN.

## Web client

### `src/web/serviceIcon.ts` — new

```ts
buildServiceIcon(): { root: HTMLImageElement; update(svc: Service): void }
```

Builds `<img class="dash-icon" alt="" loading="lazy">`, sets `src` to
`/api/services/<id>/icon`, and installs an `error` handler that hides the element. A
service with no resolvable icon therefore degrades silently to today's appearance, with no
pre-flight request and no resolution state duplicated into the client.

`update()` rewrites `src` only when the service id changes, so a poll repaint does not
retrigger a fetch — the same in-place-update contract the tiles and cards already hold.

That leaves one seam worth stating rather than discovering: an `<img>` whose `src` is
unchanged does not re-request, so a favicon refreshed from Settings does not appear on an
already-mounted tile. It appears on the dashboard's next mount, which returning from
Settings performs anyway. The Settings preview, which is what the user is actually looking
at during a refresh, busts its own URL with a counter query parameter. No cross-module
invalidation signal is introduced for this.

### Edited

- `api.ts` — `glyph` removed from `Service` and `ServiceSpec`; `icon?: string | null`
  added, with the same `null`-means-clear comment the sibling optional fields carry.
- `dashboard.ts` — `GLYPHS`-era markup goes: the `.dash-glyph` span, its creation in
  `makeTile()`, its assignment in `paintTile()`, and the `Tile` type's `glyph` member. The
  icon is appended into `.dash-tile-top` ahead of the lamp. `makeCard()` gains the same.
- `truenasCard.ts`, `unifiCard.ts` — mount `buildServiceIcon()` in their headers. One
  helper, three call sites.
- `settingsServices.ts` — `GLYPHS`, `glyphIn`, `palette` and the `svc-glyph-*` markup are
  deleted. An icon control replaces them: three radios (Auto / Choose / None), and when
  Choose is active a filterable list of `GET /api/icons` slugs with a live `<img>` preview
  beside each. Auto shows the resolved guess so the default is legible rather than
  mysterious. A **Refresh icon** button sits alongside, calling the favicon refresh for the
  service being edited.
- `buildServicePayload` — `glyph: f.glyph.trim() || null` becomes
  `icon: f.icon ?? null`, where `f.icon` is `undefined` for Auto, `'none'` for None, and
  the slug for Choose.
- `style.css` — `.dash-glyph`, `.svc-glyph-palette`, `.svc-glyph-key` and
  `.svc-glyph-input` rules removed, along with the per-glyph advance-width correction
  comments they exist to explain. `.dash-icon` added: 18px square, `object-fit: contain`,
  `flex: none`.

## Testing

Following the repo convention — real code, no mocks, enabled by the injection seams.

**`test/iconResolve.test.js`**
- Candidate order: check kind before name before hostname.
- `pihole` maps to `pi-hole`, not `pihole`.
- Name normalization: spaces, mixed case, punctuation, leading/trailing separators.
- Dotted-quad hostnames contribute no candidate.
- `isSafeSlug` refuses `../etc/passwd`, `/abs`, `a/b`, empty, over-long, uppercase, and
  unicode homoglyphs.

**`test/iconStore.test.js`** (real temp dirs)
- Precedence: explicit slug beats guess beats favicon cache.
- `'none'` short-circuits even when a catalog file exists.
- An explicit slug missing from the catalog falls through to the favicon rather than
  returning `null`.
- A path escaping `catalogDir` is refused even when handed in directly, bypassing the
  regex.
- Favicon fetch: content-type rejection, size cap aborts mid-stream, temp file removed on
  failure, redirect depth limit, `<link rel>` preferred over `/favicon.ico`.
- `forget()` removes the cached file.

**`test/servicesStore.test.js`** (extended)
- `glyph` in a spec is rejected or ignored, never persisted.
- A stored legacy `glyph` is absent from `listServices()` output.
- `icon` validates against the slug rule; `null` clears it; over-long is refused.

**`test/serviceRoutes.test.js`** (extended)
- 404 when nothing resolves; 200 with correct content-type when it does.
- ETag returned, and a matching `If-None-Match` yields 304.
- Both routes reject an unauthenticated request.
- `GET /api/icons` lists exactly the catalog directory's slugs.

**`test/settingsServices.test.js`** (extended)
- `buildServicePayload` emits absent / `'none'` / slug for the three control states.

**`test/iconCatalog.test.js`**
- Every catalog entry matches `ICON_SLUG`; no duplicates; `none` is not present.

No DOM-rendering tests: vitest runs `environment: 'node'` in this repo, so the card and
tile DOM layers are verified by their pure model functions and by live validation, as with
the existing card modules.

## Docs

- `CLAUDE.md` and `AGENTS.md` — the module list gains `iconResolve.js`, `iconStore.js` and
  `iconCatalog.js`; the `servicesStore.js` entry loses its `glyph` mention; the web-client
  paragraph gains `serviceIcon.ts`; the commands block gains `npm run fetch-icons`; the
  self-contained section notes `vendor/icons/` and `data/icons/`.
- `README.md` — a short note that icons resolve automatically and that
  `npm run fetch-icons` populates the catalog.
- `.env.example` — unchanged; the feature introduces no configuration knob.

## Out of scope

- **Uploading a custom icon.** The catalog plus favicon fallback plus suppression covers
  the cases; an upload path means new storage, new validation and a new attack surface for
  marginal benefit.
- **Automatic catalog updates.** `fetch-icons` is operator-run. A scheduled refresh would
  reintroduce the runtime internet dependency this design deliberately removed.
- **Icons for boxes or Proxmox nodes.** This change is scoped to service tiles.
- **Per-icon color or theming.** Vendor logos carry their own color; recoloring them is
  both wrong and, under the `<img>` rule, not possible without inlining.
- **Deduplicating identical icons.** Five Pi-hole services will render five identical
  logos. That is correct — they are five distinct services — and any visual distinction
  belongs to their names and groups, which already carry it.

## References

- `src/server/servicesStore.js` — the record being changed.
- `src/server/voiceCatalog.js` / `voiceDownload.js` — the pinned-allowlist and verified
  download precedents this design follows and, in the case of digest pinning, deliberately
  departs from.
- `scripts/setup-voice.mjs` — the `vendor/` population precedent.
- `src/server/serviceCheck.js:20` — the uncredentialed-probe TLS posture reused here.
- `src/server/index.js:279-280` — the `wildcard: false` static registration that forces a
  dynamic icon route.
- `src/server/server.js:40` — the CSP this design fits inside rather than widens.
