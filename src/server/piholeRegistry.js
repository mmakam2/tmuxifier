import { createHash } from 'node:crypto';
import { createPiholeClient } from './piholeApi.js';

// Sessions have to outlive a single check, so clients cannot be constructed per
// sweep — this registry owns one per service id. A client is rebuilt only when
// the inputs that define it change (API base, app password, TLS mode), which is
// what the fingerprint is for: the password is hashed rather than stored, so the
// plaintext lives only inside the client that needs it.
export function createPiholeRegistry({ store, makeClient = createPiholeClient, timeoutMs = 8000 }) {
  const clients = new Map(); // serviceId -> { fingerprint, client }

  function closeQuietly(client) {
    // Best-effort: a Pi-hole that is down at shutdown must not stall the exit.
    return Promise.resolve()
      .then(() => client?.close?.())
      .catch(() => {});
  }

  async function clientFor(service) {
    const password = (await store.getServiceSecret(service.id)) || '';
    const baseUrl = String(service.check?.target || service.url || '').replace(/\/+$/, '');
    const insecure = service.check?.insecure === true;
    const fingerprint = createHash('sha256').update(JSON.stringify([baseUrl, password, insecure])).digest('hex');

    const cached = clients.get(service.id);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    if (cached) void closeQuietly(cached.client);

    const client = makeClient({ baseUrl, password, insecure, timeoutMs });
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
