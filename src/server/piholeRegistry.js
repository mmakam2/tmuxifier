import { createPiholeClient } from './piholeApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One Pi-hole v6 client per service id. See serviceClientRegistry.js for the
// caching and lifetime rules; this file only says what a Pi-hole client is
// built from.
export function createPiholeRegistry({ store, makeClient = createPiholeClient, timeoutMs = 8000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      password: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
