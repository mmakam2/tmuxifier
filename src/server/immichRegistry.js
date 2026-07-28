import { createImmichClient } from './immichApi.js';
import { createServiceClientRegistry } from './serviceClientRegistry.js';

// One Immich client per service id. See serviceClientRegistry.js for the caching
// and lifetime rules. An Immich client is defined by its API base, the API key,
// and the TLS mode — change any of those and the cached client (with its
// snapshot) is replaced.
export function createImmichRegistry({ store, makeClient = createImmichClient, timeoutMs = 10000 }) {
  return createServiceClientRegistry({
    store,
    makeClient,
    buildOptions: (service, secret) => ({
      baseUrl: String(service.check?.target || service.url || ''),
      apiKey: secret,
      insecure: service.check?.insecure === true,
      timeoutMs,
    }),
  });
}
