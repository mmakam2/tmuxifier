/// <reference types="vite/client" />

// vite/client's ImportMetaEnv covers plain `*.css`/asset extensions but not an
// explicit `?url` suffix on a `.js` import (used by voiceRecorder.ts to load
// voiceWorklet.js as a same-origin AudioWorklet asset URL rather than a blob:
// URL, so CSP stays `script-src 'self'`); declare it so tsc knows the shape.
declare module '*?url' {
  const url: string;
  export default url;
}
