import { Resolver } from 'node:dns/promises';

// Ask one specific resolver to resolve one name. Pointing at the server rather
// than using the host's own configuration is the whole point: a fleet usually
// has several resolvers and loses them one at a time, and the failure is
// invisible because the survivors keep answering. Only a query aimed at each
// one in turn can see that.
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'PTR'];
const MAX_DETAIL = 300;

function defaultResolver({ server, timeoutMs }) {
  // tries:1 so check.timeoutMs is the real bound — c-ares would otherwise
  // retry internally and overshoot it several times over.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  return resolver;
}

// MX, SRV, SOA answer with objects and TXT with nested arrays, so a plain join
// would render "[object Object]" precisely when an operator needs to see what
// the server actually returned.
function renderAnswers(answers) {
  const list = Array.isArray(answers) ? answers : [answers];
  return list.map((a) => {
    if (a === null || a === undefined) return '';
    if (Array.isArray(a)) return a.join('');
    if (typeof a === 'object') {
      if (a.exchange) return `${a.priority ?? ''} ${a.exchange}`.trim();
      if (a.name && a.port) return `${a.name}:${a.port}`;
      return JSON.stringify(a);
    }
    return String(a);
  }).filter((s) => s !== '');
}

export async function runDnsCheck(check, { now = () => Date.now(), makeResolver = defaultResolver } = {}) {
  const started = now();
  const fail = (detail) => ({ ok: false, detail: String(detail).slice(0, MAX_DETAIL + 60), latencyMs: now() - started });
  // Everything sits inside the guard: a malformed stored definition, a server
  // address setServers() rejects, or a resolver that throws on construction
  // must all be this check failing — never a throw that aborts the runner's
  // due cycle and silently skips every check scheduled alongside it.
  try {
    const server = check?.target?.server;
    const name = check?.target?.name;
    const type = String(check?.target?.type || 'A').toUpperCase();
    if (!server || !name) return fail('dns check needs target.server and target.name');
    // Checked before the resolver is built, so an unsupported type is a clear
    // configuration error rather than whatever the resolver library says.
    if (!RECORD_TYPES.includes(type)) return fail(`unsupported record type "${type}"`);

    const resolver = makeResolver({ server, timeoutMs: check?.timeoutMs || 5000 });
    let answers;
    try {
      answers = await resolver.resolve(name, type);
    } catch (e) {
      // The resolver's own code (ENOTFOUND, ETIMEOUT, ECONNREFUSED, SERVFAIL)
      // is the most useful thing an operator can be told here, and it keeps a
      // timeout distinguishable from a name that genuinely does not exist.
      return fail(`${name} ${type} via ${server}: ${e?.code || e?.message || 'lookup failed'}`);
    }
    const rendered = renderAnswers(answers);
    // An empty answer set is not success. A resolver that returns nothing has
    // not resolved anything, and reading "no error" as healthy would report a
    // broken zone as fine — the false green this system cannot afford.
    if (!rendered.length) return fail(`${name} ${type} via ${server}: no records returned`);

    const shown = rendered.join(', ').slice(0, MAX_DETAIL);
    const want = check?.assert?.resolvesTo;
    if (want !== undefined && want !== null && want !== '') {
      if (!rendered.some((a) => a === String(want))) {
        return fail(`${name} ${type} via ${server}: expected ${want}, got ${shown}`);
      }
    }
    return { ok: true, detail: `${name} ${type} via ${server}: ${shown}`, latencyMs: now() - started };
  } catch (e) {
    return fail(e?.message || 'dns check could not run');
  }
}
