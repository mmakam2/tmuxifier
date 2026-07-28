// Pure shaping of UniFi integration-API payloads into the metrics object the
// dashboard card renders. No I/O lives here, so every layout decision the card
// depends on is testable without a controller — the same model/DOM split
// truenasCard.ts uses on the web side.

// Model first, features second — deliberately, and the ordering is load-bearing.
// A UniFi gateway advertises `features: ["switching"]` and nothing else: it is
// indistinguishable from a USW switch by feature alone (verified against a live
// UCG Max). Classifying it as a switch would cost the WAN row, the uptime cell,
// and the gateway load row at once, so the model prefix decides the gateway case
// before features are consulted.
const GATEWAY_MODEL = /^(UCG|UDM|UXG|UGW|UDR|UDW)/;
const SWITCH_MODEL = /^(USW|USL|USF)/;
const AP_MODEL = /^(UAP|U6|U7|UWB)/;

export function classifyDevice(device) {
  const model = String(device?.model || '').toUpperCase();
  if (GATEWAY_MODEL.test(model)) return 'gateway';
  const features = Array.isArray(device?.features)
    ? device.features.map((f) => String(f).toLowerCase())
    : [];
  // Kept for firmware that grows an explicit value; today none reports one.
  if (features.includes('gateway') || features.includes('routing')) return 'gateway';
  if (features.includes('switching')) return 'switch';
  if (features.includes('accesspoint')) return 'ap';
  // Firmware that omits `features` still names its hardware.
  if (SWITCH_MODEL.test(model)) return 'switch';
  if (AP_MODEL.test(model)) return 'ap';
  return 'other';
}

const isOnline = (d) => String(d?.state || '').toUpperCase() === 'ONLINE';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// The controller reports utilization as a float (21.6, 80.7); a dashboard row
// has no use for the decimal.
const pct = (v) => (num(v) == null ? null : Math.round(v));
const typeOf = (c) => String(c?.type || '').toUpperCase();

export function buildMetrics({
  devices = [], statsById = new Map(), clients = [], clientsTotal = null, networks = null,
} = {}) {
  const entries = devices.map((d) => ({
    device: d,
    cls: classifyDevice(d),
    online: isOnline(d),
    stats: statsById.get(d?.id) || null,
  }));

  const gatewayEntry = entries.find((e) => e.cls === 'gateway') || null;
  const apIds = new Set(entries.filter((e) => e.cls === 'ap').map((e) => e.device?.id));

  // The worst CPU in a class, not the mean: one pegged switch is the reading
  // the row exists to surface, and averaging it away defeats the point.
  const tally = (cls) => {
    const list = entries.filter((e) => e.cls === cls);
    const cpus = list.map((e) => num(e.stats?.cpuUtilizationPct)).filter((v) => v != null);
    return {
      online: list.filter((e) => e.online).length,
      total: list.length,
      cpuPct: cpus.length ? Math.round(Math.max(...cpus)) : null,
    };
  };

  const uplink = gatewayEntry?.stats?.uplink || null;

  return {
    // totalCount is authoritative; the split is computed from the pages actually
    // fetched, so on a site past the page cap it undercounts while the total
    // stays exact.
    clientsTotal: num(clientsTotal) ?? clients.length,
    clientsWired: clients.filter((c) => typeOf(c) === 'WIRED').length,
    clientsWireless: clients.filter((c) => typeOf(c) === 'WIRELESS').length,
    networks: Array.isArray(networks) ? networks.length : null,
    wanState: gatewayEntry ? (gatewayEntry.online ? 'up' : 'down') : 'unknown',
    wanTxBps: num(uplink?.txRateBps),
    wanRxBps: num(uplink?.rxRateBps),
    gateway: gatewayEntry
      ? {
        name: String(gatewayEntry.device?.name || gatewayEntry.device?.model || 'gateway'),
        cpuPct: pct(gatewayEntry.stats?.cpuUtilizationPct),
        memPct: pct(gatewayEntry.stats?.memoryUtilizationPct),
        uptimeSec: num(gatewayEntry.stats?.uptimeSec),
      }
      : null,
    switches: tally('switch'),
    aps: { ...tally('ap'), clients: clients.filter((c) => apIds.has(c?.uplinkDeviceId)).length },
    // Named, not merely counted: a tally cannot tell you which AP to go look at.
    offline: entries
      .filter((e) => !e.online)
      .map((e) => ({ name: String(e.device?.name || e.device?.model || 'unknown'), model: String(e.device?.model || '') })),
  };
}
