import { createUnifiClient } from './unifiApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One UniFi client per service id. See serviceClientRegistry.js for the caching
// and lifetime rules. A UniFi client is defined by its API base, the API key,
// the selected site, and the TLS mode with its pin — change any of those and the
// cached client (with its resolved site id and its snapshot) is replaced.
export function createUnifiRegistry({ store, makeClient = createUnifiClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || '').replace(/\/+$/, ''),
      apiKey: secret,
      site: String(service.check?.site || ''),
      tls: service.check?.tls || 'verify',
      fingerprint: String(service.check?.fingerprint || ''),
      timeoutMs,
    }),
  });
}
