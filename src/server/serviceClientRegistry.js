import { createHash } from 'node:crypto';

// Sessions have to outlive a single check, so API clients cannot be constructed
// per sweep — this registry owns one per service id. A client is rebuilt only
// when the inputs that define it change, which is what the fingerprint is for:
// the credential is hashed rather than stored, so the plaintext lives only
// inside the client that needs it.
//
// The Pi-hole and TrueNAS registries differ solely in which inputs form that
// fingerprint and how the client is constructed; everything else — the cache,
// retain, closeAll, and the best-effort close that keeps a dead service from
// stalling shutdown — lives here.
export function createServiceClientRegistry({ store, makeClient, buildOptions }) {
  const clients = new Map(); // serviceId -> { fingerprint, client }

  function closeQuietly(client) {
    // Best-effort: a service that is down at shutdown must not stall the exit.
    return Promise.resolve()
      .then(() => client?.close?.())
      .catch(() => {});
  }

  async function clientFor(service) {
    const secret = (await store.getServiceSecret(service.id)) || '';
    const options = buildOptions(service, secret);
    // Fingerprinting the whole options object rather than a hand-listed tuple is
    // the same guarantee with less to forget: a new client option participates
    // automatically.
    const fingerprint = createHash('sha256').update(JSON.stringify(options)).digest('hex');

    const cached = clients.get(service.id);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    if (cached) void closeQuietly(cached.client);

    const client = makeClient(options);
    clients.set(service.id, { fingerprint, client });
    return client;
  }

  async function retain(ids) {
    const keep = new Set(ids);
    const closing = [];
    for (const [id, entry] of clients) {
      if (keep.has(id)) continue;
      clients.delete(id);
      closing.push(closeQuietly(entry.client));
    }
    await Promise.all(closing);
  }

  async function closeAll() {
    const entries = [...clients.values()];
    clients.clear();
    await Promise.all(entries.map((e) => closeQuietly(e.client)));
  }

  return { clientFor, retain, closeAll };
}
