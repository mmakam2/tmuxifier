// The WebSocket close code a terminal pane sends when it is leaving for good (the
// pane is being replaced), so the server drops that viewer's PTY at once instead
// of holding it for the reconnect grace window. Mirrors TERM_RELEASE_CODE in
// src/server/sessions.js; test/termClose.test.js pins the two together.
export const TERM_RELEASE_CODE = 4000;
