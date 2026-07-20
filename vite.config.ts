import { defineConfig } from 'vite';
// Derive the dev-proxy target from the same config the server uses (.env /
// config.json), so `npm run dev` keeps working under a custom TMUXIFIER_PORT
// or TLS instead of silently proxying to a hardcoded 127.0.0.1:7437.
import { loadConfig } from './src/server/config.js';

const cfg = loadConfig();
const host = cfg.bindAddress === '0.0.0.0' ? '127.0.0.1' : cfg.bindAddress;
const tls = !!(cfg.tlsCert && cfg.tlsKey);
const http = `${tls ? 'https' : 'http'}://${host}:${cfg.port}`;
const ws = `${tls ? 'wss' : 'ws'}://${host}:${cfg.port}`;

export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    // voiceWorklet.js must be emitted as a real, same-origin static asset
    // file, never inlined as a base64 data: URL: Vite's default
    // assetsInlineLimit (4 KiB) would otherwise inline this small file
    // despite the `?url` import in voiceRecorder.ts, and a data: URL is not
    // covered by CSP's `script-src 'self'` any more than blob: is — that
    // would silently reintroduce the exact problem this change removes.
    // Everything else keeps the default size-based inlining.
    assetsInlineLimit: (filePath) => (filePath.endsWith('voiceWorklet.js') ? false : undefined),
  },
  server: {
    port: 5173,
    proxy: {
      // secure:false so a self-signed local TLS cert doesn't break the proxy.
      '/api': { target: http, secure: false },
      '/term': { target: ws, ws: true, secure: false },
    },
  },
});
