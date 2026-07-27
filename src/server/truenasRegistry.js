import { createTruenasClient } from './truenasApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One TrueNAS client per service id. See serviceClientRegistry.js for the
// caching and lifetime rules. A TrueNAS client is defined by its API base, the
// username the key belongs to, the key itself, and the TLS mode — change any of
// those and the live socket is closed and replaced.
export function createTruenasRegistry({ store, makeClient = createTruenasClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      username: String(service.check?.username || ''),
      apiKey: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
