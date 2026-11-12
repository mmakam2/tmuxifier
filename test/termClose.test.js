import { test, expect } from 'vitest';

// The browser and the server spell the release close code separately (the web
// bundle cannot import server modules), so this pins the two spellings together.
test('client and server agree on the release close code', async () => {
  const { TERM_RELEASE_CODE: server } = await import('../src/server/sessions.js');
  const { TERM_RELEASE_CODE: web } = await import('../src/web/termClose.ts');
  expect(web).toBe(server);
  expect(server).toBe(4000);
});
