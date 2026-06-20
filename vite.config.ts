import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7437',
      '/term': { target: 'ws://127.0.0.1:7437', ws: true },
    },
  },
});
