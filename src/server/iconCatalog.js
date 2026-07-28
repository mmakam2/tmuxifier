// The pinned slug list, playing exactly the role voiceCatalog.js plays for
// speech models: the single chokepoint guaranteeing no user-supplied string
// ever reaches a download. fetch-icons iterates this list and nothing else —
// there is no "fetch an arbitrary slug" path from the CLI or from the API.
//
// Unlike voiceCatalog.js there are deliberately no pinned digests. A speech
// model is a fixed artifact whose hash is the correctness guarantee; a logo is
// redesigned by its vendor from time to time, and pinning would turn every
// upstream refresh into a failed run demanding a commit to fix. The guarantees
// kept instead are this list, a content-type check, a size cap, and the rule
// that icons are only ever rendered through <img> (which makes SVG inert).

export const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/';

// SVG first, PNG as the fallback. Not gold-plating: 545 of upstream's 2798
// icons are PNG-only, including apps a self-hoster is very likely to run
// (Homepage, Dashy, speedtest-tracker), so an SVG-only catalog would silently
// forfeit a fifth of the available coverage. Both are raster-safe at the 18px
// the tile renders — upstream PNGs are 512px, so they downscale rather than up.
export const CATALOG_EXTS = ['svg', 'png'];

export const CATALOG_SLUGS = [
  // The four check kinds and this project's own integrations.
  'unifi', 'truenas', 'pi-hole', 'proxmox', 'netbox',
  // Observability.
  'grafana', 'prometheus', 'influxdb', 'uptime-kuma', 'netdata', 'zabbix', 'graylog',
  // Home and media.
  'home-assistant', 'jellyfin', 'plex', 'emby', 'navidrome', 'audiobookshelf',
  'immich', 'photoprism', 'frigate', 'esphome', 'zigbee2mqtt', 'mosquitto', 'node-red',
  // Media automation.
  'sonarr', 'radarr', 'prowlarr', 'bazarr', 'jellyseerr', 'overseerr',
  'qbittorrent', 'transmission', 'sabnzbd',
  // Files, docs and backup.
  'nextcloud', 'seafile', 'filebrowser', 'paperless-ngx', 'syncthing', 'duplicati', 'mealie',
  // Networking and access.
  'traefik', 'nginx-proxy-manager', 'caddy', 'pfsense', 'opnsense', 'openwrt',
  'mikrotik', 'wireguard', 'tailscale', 'guacamole', 'authentik', 'authelia',
  // Platform and development.
  'portainer', 'docker', 'kubernetes', 'rancher', 'gitea', 'forgejo', 'gitlab',
  'jenkins', 'minio', 'n8n', 'ollama', 'open-webui',
  // Storage appliances and other dashboards.
  'synology', 'unraid', 'homarr', 'homepage', 'dashy',
  // Secrets, wikis and utilities.
  'vaultwarden', 'bitwarden', 'wikijs', 'bookstack', 'stirling-pdf', 'it-tools',
  'vikunja', 'firefly-iii', 'actual-budget', 'watchtower', 'speedtest-tracker',
  'adguard-home',
];

const SLUG_SET = new Set(CATALOG_SLUGS);

// Set membership rather than object indexing: a bare object lookup would
// resolve 'constructor' and 'toString' to Object.prototype members, the same
// trap voiceCatalog.js guards against with hasOwnProperty. The extension is
// checked against its own allowlist for the same reason — both halves of the
// path are closed sets, so no caller can steer this at a URL it chose.
export function iconUrl(slug, ext = 'svg') {
  if (typeof slug !== 'string' || !SLUG_SET.has(slug)) return null;
  if (!CATALOG_EXTS.includes(ext)) return null;
  return `${ICON_CDN}${ext}/${slug}.${ext}`;
}
