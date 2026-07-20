# Voice Dictation — Stage 1 (Dictation Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold a key in the browser, speak, and have the transcript typed into the box's tmux session — transcribed by a local whisper.cpp on the Tmuxifier host, with no audio leaving the host.

**Architecture:** The browser captures raw PCM via Web Audio and encodes a 16 kHz mono WAV client-side (no ffmpeg dependency). It POSTs the WAV to `/api/voice`, which hands it to a lazily-spawned, idle-timeout whisper-server child process over loopback HTTP. The resulting text is normalized and typed into the pane with `tmux send-keys -l` through the existing pane-aware `injectVia` guard, which is generalized from paths to arbitrary text in this stage.

**Tech Stack:** Node 20+ ESM, Fastify, vitest, whisper.cpp (`whisper-server`), TypeScript + xterm.js + Vite on the client, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-07-20-voice-dictation-design.md`

**Scope:** This plan covers stage 1 only — voice works, installed from the command line. Stage 2 (the `voiceInstall` job manager, `voiceStore`, the four management routes, and `settingsVoice.ts`) gets its own plan once this lands.

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+.
- Server code is plain `.js`; web client code is `.ts`.
- TDD: the failing test is written and *run* before the implementation, every task.
- Tests use real code, not mocks. Dependencies are injected via factory-function parameters. The only thing faked anywhere in this plan is the `spawn` process boundary.
- `loadConfig` stays pure and injectable — never read `process.env` or `process.cwd()` inside it or its tests.
- Conventional-commit messages (`feat(voice): …`, `refactor(tmux): …`).
- The repo is public: no real domains, IPs, hostnames, or emails in any committed file. Use `example.com` and RFC1918 addresses.
- Any new gitignored path ships with a placeholder counterpart in the same commit (`.env.example` for new knobs).
- New persisted files are written `0o600` via `jsonFile.js`.
- `npm test` runs `tsc --noEmit` before vitest — TypeScript must typecheck clean at every commit.

---

### Task 1: Transcript normalization (`voiceText.js`)

Pure module. All the fiddly text handling lives here so it needs no process, no network, and no mocks.

**Files:**
- Create: `src/server/voiceText.js`
- Test: `test/voiceText.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeTranscript(raw: string) => string`, and the exported constant `MAX_TRANSCRIPT_CHARS = 4000`.

- [ ] **Step 1: Write the failing test**

Create `test/voiceText.test.js`:

```js
import { test, expect } from 'vitest';
import { normalizeTranscript, MAX_TRANSCRIPT_CHARS } from '../src/server/voiceText.js';

test('collapses newlines to spaces so send-keys never submits early', () => {
  // whisper emits one line per segment; a newline through send-keys is Enter.
  expect(normalizeTranscript('refactor the auth middleware\nto use the new helper'))
    .toBe('refactor the auth middleware to use the new helper');
});

test('strips whisper blank-audio and timestamp markers', () => {
  expect(normalizeTranscript('[BLANK_AUDIO]')).toBe('');
  expect(normalizeTranscript('[00:00:00.000 --> 00:00:05.000]  hello there')).toBe('hello there');
});

test('strips control characters so no escape sequence reaches the pane', () => {
  expect(normalizeTranscript('run \x1b[31mmake\x1b[0m now')).toBe('run [31mmake[0m now');
  expect(normalizeTranscript('a\x00b\x07c\x7f')).toBe('abc');
});

test('keeps non-ASCII text intact', () => {
  // Unlike upload.ts termSafe (ASCII-only filenames), transcripts may be
  // legitimately non-English when a multilingual model is selected.
  expect(normalizeTranscript('café naïve 日本語')).toBe('café naïve 日本語');
});

test('collapses whitespace runs and trims', () => {
  expect(normalizeTranscript('  hello   \t  world  ')).toBe('hello world');
});

test('returns empty string for empty, whitespace, and non-string input', () => {
  expect(normalizeTranscript('')).toBe('');
  expect(normalizeTranscript('   \n  ')).toBe('');
  expect(normalizeTranscript(null)).toBe('');
  expect(normalizeTranscript(undefined)).toBe('');
});

test('caps length so one dictation cannot produce an unbounded argv', () => {
  const out = normalizeTranscript('word '.repeat(2000));
  expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
  expect(out.endsWith(' ')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceText.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voiceText.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/voiceText.js`:

```js
// Pure normalization of a whisper transcript before it is typed into a tmux
// pane. Three of these rules are load-bearing rather than cosmetic:
//
//  - Newline collapse: whisper emits one line per segment, and a newline
//    delivered through `tmux send-keys` is Enter — it would submit a
//    half-finished prompt.
//  - Control-character stripping: a transcription artefact must never be able
//    to emit an escape sequence into the pane. This is the same class of
//    control as upload.js's filename allowlist, but deliberately wider: we
//    keep non-ASCII, because a multilingual model produces legitimate
//    non-English text. Only C0/C1 controls and DEL are removed.
//  - Length cap: bounds the argv a single dictation can produce.

export const MAX_TRANSCRIPT_CHARS = 4000;

// [00:00:00.000 --> 00:00:05.000] segment headers, emitted when whisper is
// asked for timestamped output.
const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g;

// whisper's own silence sentinels.
const SENTINEL_RE = /\[(?:BLANK_AUDIO|SOUND|MUSIC|NOISE)\]/gi;

// C0 controls, DEL, and C1 controls, written as explicit escapes so this
// source stays pure ASCII. Deliberately NOT a general "non-printable"
// filter: accented and astral-plane characters must survive, because a
// multilingual model produces legitimate non-English text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export function normalizeTranscript(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw
    .replace(TIMESTAMP_RE, ' ')
    .replace(SENTINEL_RE, ' ')
    // Control removal runs after the marker passes but before whitespace
    // collapse, so a stripped \n still becomes a word separator rather than
    // gluing two segments together.
    .replace(/[\r\n\t]/g, ' ')
    .replace(CONTROL_RE, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TRANSCRIPT_CHARS
    ? collapsed.slice(0, MAX_TRANSCRIPT_CHARS).trimEnd()
    : collapsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/voiceText.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/voiceText.js test/voiceText.test.js
git commit -m "feat(voice): pure transcript normalization for pane injection"
```

---

### Task 2: Model catalog (`voiceCatalog.js`)

The security chokepoint. Every value that will reach the stage-2 install script originates here or is a hardcoded constant, so no user-supplied URL is ever fetched. Stage 1 needs it because `setup-voice.mjs` (Task 9) resolves model ids through it.

**Files:**
- Create: `src/server/voiceCatalog.js`
- Test: `test/voiceCatalog.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveModel(id) => {id, file, bytes, sha256, url} | null`, `MODEL_IDS: string[]`, `DEFAULT_MODEL_ID = 'small.en'`, `WHISPER_REPO`, `WHISPER_REF`.

- [ ] **Step 1: Record the real checksums and pinned refs**

These values cannot be invented — a wrong SHA-256 makes every download fail the integrity check, and a fabricated one is worse than none. Derive them now and paste the real output into the module in Step 4.

Run:

```bash
# Model checksums. Each is ~150-540 MB; this downloads them once to /tmp.
for m in base.en small.en; do
  curl -sL -o "/tmp/ggml-$m.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$m.bin"
  echo "$m  $(sha256sum "/tmp/ggml-$m.bin" | cut -d' ' -f1)  $(stat -c%s "/tmp/ggml-$m.bin")"
done

# medium.en-q5_0 lives under the same repo with a different filename.
curl -sL -o /tmp/ggml-medium.en-q5_0.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin"
echo "medium.en-q5_0  $(sha256sum /tmp/ggml-medium.en-q5_0.bin | cut -d' ' -f1)  $(stat -c%s /tmp/ggml-medium.en-q5_0.bin)"

# Pin the whisper.cpp release tag and record its commit sha.
git ls-remote --tags https://github.com/ggerganov/whisper.cpp | tail -5
```

Expected: three `<id>  <64-hex>  <bytes>` lines, and a tag list whose newest stable tag (e.g. `v1.7.4`) becomes `WHISPER_REF`.

Keep the downloaded files — Task 9 reuses `/tmp/ggml-small.en.bin` to avoid a second download.

- [ ] **Step 2: Write the failing test**

Create `test/voiceCatalog.test.js`. It asserts *shape and safety*, never the specific hashes, so the test does not need updating when a model is added:

```js
import { test, expect } from 'vitest';
import {
  resolveModel, MODEL_IDS, DEFAULT_MODEL_ID, WHISPER_REPO, WHISPER_REF,
} from '../src/server/voiceCatalog.js';

test('every catalog entry carries a verifiable download', () => {
  expect(MODEL_IDS.length).toBeGreaterThan(0);
  for (const id of MODEL_IDS) {
    const m = resolveModel(id);
    expect(m.id).toBe(id);
    expect(m.file).toMatch(/^ggml-[A-Za-z0-9.\-_]+\.bin$/);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.bytes).toBeGreaterThan(1_000_000);
    expect(m.url.startsWith('https://huggingface.co/')).toBe(true);
  }
});

test('the default model is in the catalog', () => {
  expect(MODEL_IDS).toContain(DEFAULT_MODEL_ID);
});

test('unknown and traversal ids resolve to null, never a path', () => {
  for (const bad of ['', '  ', 'nope', '../../etc/passwd', 'small.en/../x',
                     '/abs/path', 'small.en ', 'HTTP://evil.example.com/x.bin']) {
    expect(resolveModel(bad)).toBeNull();
  }
});

test('resolveModel rejects non-string input', () => {
  expect(resolveModel(null)).toBeNull();
  expect(resolveModel(undefined)).toBeNull();
  expect(resolveModel({ id: 'small.en' })).toBeNull();
  expect(resolveModel(['small.en'])).toBeNull();
});

test('the upstream repo and ref are pinned constants, not floating', () => {
  expect(WHISPER_REPO).toBe('https://github.com/ggerganov/whisper.cpp.git');
  expect(WHISPER_REF).toMatch(/^v\d+\.\d+\.\d+$/);
});

test('returned entries are copies — a caller cannot mutate the catalog', () => {
  const first = resolveModel(DEFAULT_MODEL_ID);
  first.url = 'https://evil.example.com/payload.bin';
  expect(resolveModel(DEFAULT_MODEL_ID).url.startsWith('https://huggingface.co/')).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/voiceCatalog.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voiceCatalog.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `src/server/voiceCatalog.js`. **Replace each `sha256` and `bytes` with the real values recorded in Step 1**, and `WHISPER_REF` with the tag chosen there:

```js
// The allowlist that keeps the (stage 2) installer safe. A model is chosen by
// id; the id resolves here to a fixed URL and a pinned SHA-256. No caller ever
// supplies a URL or a path — without this indirection the install route would
// be an SSRF and arbitrary-file-write primitive, since the downloaded file is
// later mmap'd into the server process.
//
// Same discipline as boxActions.js's TOOL_IDS: ids validated server-side,
// nothing user-typed reaching the script.

export const WHISPER_REPO = 'https://github.com/ggerganov/whisper.cpp.git';
// Pinned release tag — never a branch. A moving ref would silently change what
// gets compiled and run as root on the Tmuxifier host.
export const WHISPER_REF = 'v1.7.4'; // ← replace with the tag recorded in Step 1

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// Values below are recorded by Task 2 Step 1. Do not invent them: a wrong
// digest fails every download at the integrity check.
const CATALOG = {
  'base.en': {
    file: 'ggml-base.en.bin',
    bytes: 0,             // ← replace
    sha256: '',           // ← replace with the 64-hex digest
  },
  'small.en': {
    file: 'ggml-small.en.bin',
    bytes: 0,             // ← replace
    sha256: '',           // ← replace
  },
  'medium.en-q5_0': {
    file: 'ggml-medium.en-q5_0.bin',
    bytes: 0,             // ← replace
    sha256: '',           // ← replace
  },
};

export const MODEL_IDS = Object.keys(CATALOG);
export const DEFAULT_MODEL_ID = 'small.en';

// Own-property lookup only: a bare object index would resolve 'constructor'
// and 'toString' to Object.prototype members.
export function resolveModel(id) {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) return null;
  const entry = CATALOG[id];
  // A fresh object each call so a caller cannot mutate the catalog in place.
  return { id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256, url: HF_BASE + entry.file };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/voiceCatalog.test.js`
Expected: PASS, 6 tests. A failure on the `sha256` or `bytes` assertions means Step 1's values were not pasted in.

- [ ] **Step 6: Commit**

```bash
git add src/server/voiceCatalog.js test/voiceCatalog.test.js
git commit -m "feat(voice): pinned model catalog with verified checksums"
```

---

### Task 3: Generalize pane injection from paths to text

`injectVia` currently hardcodes `injectionText(path)` and `"image pasted:"` status messages. Voice needs the same pane-aware guard for arbitrary text. This is a refactor, so the existing upload tests passing unchanged is the deliverable.

**Files:**
- Modify: `src/server/tmuxInject.js:113-140` (`injectionText`, `injectVia`, `injectLocalUploadPath`)
- Modify: `src/server/boxActions.js:472-474` (`injectUploadPath`)
- Test: `test/tmuxInject.test.js` (extend)

**Interfaces:**
- Consumes: `classifyPaneState`, `buildSendKeysRemote`, `buildDisplayMessageRemote` from Task 0 (existing code).
- Produces: `injectTextVia(runScript, session, text, { label, okMsg, busyMsg }) => {injected, mode}` — `label` drives the default messages for the common case; `okMsg`/`busyMsg` are optional builders that override them, which is how `injectVia` keeps the upload wording. Also `boxActions.injectText(box, session, text, {timeoutMs}) => {injected, mode}`; `boxActions.injectText(box, session, text, {timeoutMs}) => {injected, mode}`. `injectVia(runScript, session, remotePath)` keeps its exact current signature and observable behaviour, but becomes a thin wrapper.

**There must be exactly one copy of the capture → classify → send-keys body.** `injectVia` delegates to `injectTextVia`, supplying its own message builders so the upload wording is preserved byte-for-byte. Do not duplicate the orchestration.

- [ ] **Step 1: Write the failing test**

Append to `test/tmuxInject.test.js`. Add `injectTextVia` to the existing import block at the top of the file first:

```js
test('injectTextVia types arbitrary text into a shell pane', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\nuser@host:~$ ' };
    return { code: 0, stdout: '' };
  };
  const res = await injectTextVia(run, 'web', 'refactor the auth middleware', { label: 'dictation' });
  expect(res).toEqual({ injected: true, mode: 'shell' });
  const sendKeys = calls.find((c) => c.includes('send-keys'));
  expect(sendKeys).toContain("'refactor the auth middleware'");
  // No trailing space and no Enter: the upload convention applies to voice too.
  expect(sendKeys).not.toContain('Enter');
});

test('injectTextVia uses the label in its status messages', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'make\n' };
    return { code: 0, stdout: '' };
  };
  const res = await injectTextVia(run, 'web', 'hello', { label: 'dictation' });
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(calls.find((c) => c.includes('display-message'))).toContain('dictation');
});

test('injectTextVia never types empty text', async () => {
  const calls = [];
  const run = async (script) => { calls.push(script); return { code: 0, stdout: 'bash\n$ ' }; };
  const res = await injectTextVia(run, 'web', '   ', { label: 'dictation' });
  expect(res).toEqual({ injected: false, mode: 'empty' });
  expect(calls.some((c) => c.includes('send-keys'))).toBe(false);
});

test('injectVia keeps its original upload wording after delegation', async () => {
  // Locks the refactor: injectVia now delegates to injectTextVia, so the
  // upload-specific message text must be asserted explicitly rather than
  // assumed to have survived.
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\n$ ' };
    return { code: 0, stdout: '' };
  };
  await injectVia(run, 'web', '/root/.tmuxifier-uploads/1-aa-shot.png');
  expect(calls.find((c) => c.includes('display-message'))).toContain('image pasted: 1-aa-shot.png');

  const busy = [];
  const runBusy = async (script) => {
    busy.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'make\n' };
    return { code: 0, stdout: '' };
  };
  await injectVia(runBusy, 'web', '/x/y.png');
  expect(busy.find((c) => c.includes('display-message')))
    .toContain('image uploaded: /x/y.png (pane busy — not typed)');
});

test('injectTextVia sh-quotes text containing quotes and semicolons', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (script.includes('capture-pane')) return { code: 0, stdout: 'bash\n$ ' };
    return { code: 0, stdout: '' };
  };
  await injectTextVia(run, 'web', "it's fine; rm -rf /", { label: 'dictation' });
  const sendKeys = calls.find((c) => c.includes('send-keys'));
  // shSingleQuote renders an embedded apostrophe as '\'' — the shell never
  // sees an unquoted ; or an unbalanced quote.
  expect(sendKeys).toContain(`'it'\\''s fine; rm -rf /'`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tmuxInject.test.js`
Expected: FAIL — `injectTextVia is not defined` (4 new tests fail; the existing ones still pass).

- [ ] **Step 3: Write minimal implementation**

In `src/server/tmuxInject.js`, replace the existing `injectVia` (lines 122-140) with the generalized pair below. `injectionText` at line 113 is unchanged:

```js
// Orchestration: capture → classify → type or message. runScript executes one
// sh command on the target (over ssh for a box, /bin/sh for __local__) and
// resolves {code, stdout, stderr}. Never throws — the caller's work (an upload,
// a transcription) already succeeded, so injection failures degrade to a status
// message and a mode the client can surface.
//
// `text` is typed literally via send-keys -l and is never followed by Enter:
// the operator reviews before submitting. `label` only names the thing in tmux
// status messages ('image', 'dictation').
// `text` is typed literally via send-keys -l and is never followed by Enter:
// the operator reviews before submitting. `label` names the thing in the
// default tmux status messages ('image', 'dictation'); okMsg/busyMsg override
// those entirely, which is how the upload wrapper below keeps its original
// wording without a second copy of this body.
export async function injectTextVia(runScript, session, text, { label = 'text', okMsg, busyMsg } = {}) {
  const body = String(text ?? '');
  // Nothing to type is not a failure — and must not produce a bare send-keys.
  if (!body.trim()) return { injected: false, mode: 'empty' };
  const onOk = okMsg || (() => `[tmuxifier] ${label} inserted`);
  const onBusy = busyMsg || (() => `[tmuxifier] ${label} ready (pane busy — not typed)`);
  const say = async (msg) => { try { await runScript(buildDisplayMessageRemote(session, msg)); } catch {} };
  let mode = 'busy';
  try {
    const cap = await runScript(buildPaneStateRemote(session));
    mode = cap && cap.code === 0 ? classifyPaneState(parsePaneState(cap.stdout)) : 'busy';
    if (mode === 'claude' || mode === 'shell') {
      const sent = await runScript(buildSendKeysRemote(session, body));
      if (!sent || sent.code !== 0) throw new Error('send-keys failed');
      await say(onOk());
      return { injected: true, mode };
    }
    await say(onBusy());
    return { injected: false, mode: 'busy' };
  } catch {
    await say(onBusy());
    return { injected: false, mode: 'error' };
  }
}

// Upload-specific wrapper. It quotes the path and supplies the original tmux
// status wording, so the upload flow's observable behaviour is unchanged —
// while the capture/classify/send-keys body exists exactly once, above.
export function injectVia(runScript, session, remotePath) {
  const name = String(remotePath).split('/').pop() || String(remotePath);
  return injectTextVia(runScript, session, injectionText(remotePath), {
    okMsg: () => `[tmuxifier] image pasted: ${name}`,
    busyMsg: () => `[tmuxifier] image uploaded: ${remotePath} (pane busy — not typed)`,
  });
}
```

**One behavioural difference to verify, not assume:** `injectTextVia` returns `{injected:false, mode:'empty'}` for blank input, whereas the old `injectVia` would have proceeded. `injectionText(path)` appends a trailing space and always contains the quoted path, so it is never blank for any real path — but confirm the existing upload tests still pass rather than reasoning it through. If any upload test now fails, the wrapper is wrong; fix the wrapper, never the test.

Then add the text-injection sibling to `src/server/boxActions.js`, immediately after `injectUploadPath` (line 474). Add `injectTextVia` to the existing `tmuxInject.js` import at the top of the file:

```js
    // Pane-aware injection of dictated text. Same guard as injectUploadPath;
    // never throws — the transcription already succeeded and is returned to
    // the client regardless of whether it could be typed.
    async injectText(box, session, text, { timeoutMs = 8000 } = {}) {
      return injectTextVia((script) => runRemote(box, script, timeoutMs), session, text, { label: 'dictation' });
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tmuxInject.test.js test/tmuxInject.integration.test.js`
Expected: PASS. The pre-existing upload tests must pass **unchanged** — that is the regression guard on this refactor. If any needed editing, the generalization changed upload behaviour and must be corrected instead.

- [ ] **Step 5: Commit**

```bash
git add src/server/tmuxInject.js src/server/boxActions.js test/tmuxInject.test.js
git commit -m "refactor(tmux): generalize pane injection from paths to arbitrary text"
```

---

### Task 4: The whisper engine (`voiceEngine.js`)

Lazy spawn, readiness gate, idle-timeout shutdown, crash restart, bounded queue. The only faked thing is `spawn`; the test's fake child is a *real* HTTP server, so the engine's real fetch, real multipart encoding, and real readiness parsing are all exercised.

**Files:**
- Create: `src/server/voiceEngine.js`
- Test: `test/voiceEngine.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createVoiceEngine({bin, model, threads, idleMs, queueLimit, readyTimeoutMs, spawn, pickPort, log}) => {transcribe(wavBuffer) => Promise<string>, stop() => Promise<void>, state() => 'stopped'|'starting'|'ready'}`. `transcribe` rejects with an `Error` carrying a `.status` property (`503` not ready, `502` crashed, `429` queue full).

- [ ] **Step 1: Write the failing test**

Create `test/voiceEngine.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createVoiceEngine } from '../src/server/voiceEngine.js';

const started = [];
afterEach(async () => { while (started.length) await started.pop()(); });

// A fake `spawn` whose child is a real HTTP server speaking whisper-server's
// /inference contract. Only the process boundary is faked: the engine's fetch,
// multipart encoding, readiness parsing and lifecycle all run for real.
function fakeSpawn({ reply = { text: 'hello world' }, readyLine = true, crashAfter = null } = {}) {
  const calls = [];
  const fn = (bin, argv) => {
    const port = Number(argv[argv.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let served = 0;
    const server = http.createServer((req, res) => {
      served += 1;
      if (crashAfter !== null && served > crashAfter) {
        server.close();
        child.emit('exit', 1, null);
        req.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    const close = () => new Promise((r) => server.close(() => r()));
    started.push(close);
    server.listen(port, '127.0.0.1', () => {
      if (readyLine) child.stdout.emit('data', Buffer.from(`whisper server listening at http://127.0.0.1:${port}\n`));
    });
    child.kill = () => { child.killed = true; void close(); child.emit('exit', 0, 'SIGTERM'); };
    calls.push({ bin, argv, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Ephemeral ports, allocated per engine so parallel tests never collide.
let nextPort = 39000;
const pickPort = async () => nextPort++;

const WAV = Buffer.from('RIFF....WAVEfmt ');

function makeEngine(spawn, over = {}) {
  return createVoiceEngine({
    bin: '/fake/whisper-server', model: '/fake/model.bin',
    idleMs: 60000, readyTimeoutMs: 2000, spawn, pickPort, log: () => {}, ...over,
  });
}

test('spawns lazily on the first transcribe and reuses the warm child', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn);
  expect(engine.state()).toBe('stopped');

  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(spawn.calls.length).toBe(1);
  expect(engine.state()).toBe('ready');

  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(spawn.calls.length).toBe(1); // reused, not respawned

  await engine.stop();
});

test('passes the model and a loopback bind to the child', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn);
  await engine.transcribe(WAV);
  const { bin, argv } = spawn.calls[0];
  expect(bin).toBe('/fake/whisper-server');
  expect(argv).toContain('/fake/model.bin');
  expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
  await engine.stop();
});

test('shuts the child down after the idle timeout', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn, { idleMs: 60 });
  await engine.transcribe(WAV);
  expect(engine.state()).toBe('ready');
  await new Promise((r) => setTimeout(r, 140));
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

test('the idle timer is cancelled during a request, not merely reset', async () => {
  // The race this guards: a request arriving at the very end of an idle window
  // must not have its engine killed underneath it mid-transcription.
  let release;
  const gate = new Promise((r) => { release = r; });
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn, { idleMs: 50 });
  await engine.transcribe(WAV);            // engine warm, idle timer armed

  await new Promise((r) => setTimeout(r, 40)); // 40ms into a 50ms window
  const slow = engine.transcribe(WAV).then((t) => { release(); return t; });
  await new Promise((r) => setTimeout(r, 40)); // would have fired by now
  expect(engine.state()).toBe('ready');         // still alive because a request is in flight
  expect(await slow).toBe('hello world');
  await gate;
  await engine.stop();
});

test('rejects with 503 when the child never signals readiness', async () => {
  const spawn = fakeSpawn({ readyLine: false });
  const engine = makeEngine(spawn, { readyTimeoutMs: 120 });
  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 503 });
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

test('respawns after the child crashes', async () => {
  const spawn = fakeSpawn({ crashAfter: 1 });
  const engine = makeEngine(spawn);
  expect(await engine.transcribe(WAV)).toBe('hello world');
  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 502 });
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

test('rejects with 429 once the queue is full', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn, { queueLimit: 2 });
  const inflight = [engine.transcribe(WAV), engine.transcribe(WAV), engine.transcribe(WAV)];
  const results = await Promise.allSettled(inflight);
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(rejected.length).toBe(1);
  expect(rejected[0].reason.status).toBe(429);
  await engine.stop();
});

test('stop() is idempotent and safe before any spawn', async () => {
  const engine = makeEngine(fakeSpawn());
  await engine.stop();
  await engine.stop();
  expect(engine.state()).toBe('stopped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceEngine.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/voiceEngine.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/voiceEngine.js`:

```js
import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';

// Lazily-spawned whisper.cpp server with an idle timeout.
//
// Chosen over spawn-per-request (which pays model load on every clip) and over
// an always-resident child (which holds ~0.85 GB permanently for small.en).
// The child is started on the first transcription, kept warm across a burst of
// dictation, and shut down once idle — so steady-state RAM cost is zero.
//
// Everything crossing a process or network boundary is injectable, which is
// what lets the tests run the real fetch/multipart/readiness code against a
// stub HTTP child rather than mocking the engine itself.

function err(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Ask the OS for a free port by binding :0 and reading it back. Racy in
// principle (the port could be taken between close and the child's bind), but
// this is a single-user local dashboard and the failure mode is a readiness
// timeout that respawns cleanly.
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function createVoiceEngine({
  bin,
  model,
  threads = 4,
  idleMs = 600000,
  queueLimit = 2,
  readyTimeoutMs = 30000,
  spawn = nodeSpawn,
  pickPort = ephemeralPort,
  log = (msg) => console.error(msg),
} = {}) {
  let child = null;
  let port = 0;
  let starting = null;     // Promise while the child is coming up
  let idleTimer = null;
  let inFlight = 0;
  let queued = 0;

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  // Re-armed only when nothing is in flight. Cancelling for the duration of a
  // request (rather than merely resetting on use) is what closes the race
  // where a request starting at the end of an idle window has its engine
  // killed underneath it.
  function armIdle() {
    clearIdle();
    if (!child || inFlight > 0) return;
    idleTimer = setTimeout(() => { void teardown(); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function teardown() {
    clearIdle();
    const c = child;
    child = null;
    port = 0;
    starting = null;
    if (c && !c.killed) {
      try { c.kill('SIGTERM'); } catch {}
    }
  }

  async function start() {
    if (child) return;
    if (starting) return starting;
    starting = (async () => {
      const p = await pickPort();
      const argv = [
        '-m', model,
        '--host', '127.0.0.1',
        '--port', String(p),
        '-t', String(threads),
      ];
      const c = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
        const timer = setTimeout(
          () => { try { c.kill('SIGTERM'); } catch {} done(reject, err('whisper did not become ready', 503)); },
          readyTimeoutMs,
        );
        // whisper-server announces itself on stdout once bound.
        const onData = (buf) => { if (/listening at/i.test(String(buf))) done(resolve); };
        c.stdout.on('data', onData);
        c.stderr.on('data', (b) => { if (/listening at/i.test(String(b))) done(resolve); });
        c.on('error', (e) => done(reject, err(`whisper failed to start: ${e.message}`, 503)));
        c.on('exit', (code) => done(reject, err(`whisper exited during startup (code ${code})`, 503)));
      });

      // A crash *after* startup invalidates the warm child; the next request
      // spawns a fresh one rather than fetching into a closed port.
      c.on('exit', (code, signal) => {
        if (child === c) {
          log(`[voice] whisper exited (code ${code}, signal ${signal})`);
          teardown();
        }
      });

      child = c;
      port = p;
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function runInference(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
    } catch (e) {
      throw err(`whisper request failed: ${e.message}`, 502);
    }
    if (!res.ok) throw err(`whisper returned ${res.status}`, 502);
    const body = await res.json().catch(() => null);
    if (!body || typeof body.text !== 'string') throw err('whisper returned no text', 502);
    return body.text;
  }

  return {
    state() {
      if (child) return 'ready';
      return starting ? 'starting' : 'stopped';
    },

    // Serialized behind a bounded queue: whisper-server processes one clip at
    // a time, so letting requests pile up would only convert latency into
    // memory pressure. Overflow is a fast 429 rather than an unbounded wait.
    async transcribe(wav) {
      if (queued >= queueLimit) throw err('voice engine busy', 429);
      queued += 1;
      clearIdle();
      inFlight += 1;
      try {
        await start();
        return await runInference(wav);
      } finally {
        queued -= 1;
        inFlight -= 1;
        armIdle();
      }
    },

    async stop() {
      teardown();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/voiceEngine.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/voiceEngine.js test/voiceEngine.test.js
git commit -m "feat(voice): lazily-spawned whisper engine with idle shutdown"
```

---

### Task 5: Configuration knobs and the UI readiness flag

**Files:**
- Modify: `src/server/config.js` (DEFAULTS near line 60, env mapping near line 162, clamping near line 188)
- Modify: `src/server/server.js:934-936` (`/api/ui-config`)
- Modify: `.env.example`
- Modify: `.gitignore`
- Test: `test/config.test.js` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.whisperBin`, `config.whisperModel`, `config.voiceEnabled` (boolean), `config.voiceIdleMs`, `config.voiceMaxBytes`, `config.voiceMaxSeconds`. `/api/ui-config` gains `voice: boolean` and `voiceMaxSeconds: number`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.js`. Follow the file's existing pure-injection style — `loadConfig` must never read `process.env` or `process.cwd()`:

```js
test('voice is off by default', () => {
  const c = loadConfig({}, { env: {}, cwd: '/repo' });
  expect(c.voiceEnabled).toBe(false);
  expect(c.voiceIdleMs).toBe(600000);
  expect(c.voiceMaxSeconds).toBe(120);
  expect(c.voiceMaxBytes).toBe(8 * 1024 * 1024);
});

test('voice turns on when a binary and model are configured', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(true);
  expect(c.whisperBin).toBe('/repo/vendor/whisper/build/bin/whisper-server');
});

test('TMUXIFIER_VOICE=off is a hard kill switch', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE: 'off',
           TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(false);
});

test('voice stays off when only one of binary and model is set', () => {
  const only = (env) => loadConfig({}, { env, cwd: '/repo' }).voiceEnabled;
  expect(only({ TMUXIFIER_WHISPER_BIN: '/x/whisper-server' })).toBe(false);
  expect(only({ TMUXIFIER_WHISPER_MODEL: '/x/model.bin' })).toBe(false);
});

test('voice limits are clamped to sane ranges', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE_MAX_MB: '9999', TMUXIFIER_VOICE_MAX_SECONDS: '0',
           TMUXIFIER_VOICE_IDLE_MS: '10' },
    cwd: '/repo',
  });
  expect(c.voiceMaxBytes).toBe(64 * 1024 * 1024); // clamped to the 64 MB ceiling
  expect(c.voiceMaxSeconds).toBe(120);            // rejected, falls back to default
  expect(c.voiceIdleMs).toBe(30000);              // clamped to the 30s floor
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `expected undefined to be false` on `voiceEnabled`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/config.js`, add to `DEFAULTS` (beside `uploadMaxMb` around line 60):

```js
  // Voice dictation. Off unless both a whisper binary and a model are
  // configured — stage 1 sets these from `npm run setup-voice`.
  whisperBin: undefined,
  whisperModel: undefined,
  voiceIdleMs: 600000,
  voiceMaxMb: 8,
  voiceMaxSeconds: 120,
  voiceOff: false,
```

Add to the env mapping (beside `uploadMaxMb` around line 162):

```js
    whisperBin: e.TMUXIFIER_WHISPER_BIN,
    whisperModel: e.TMUXIFIER_WHISPER_MODEL,
    voiceIdleMs: e.TMUXIFIER_VOICE_IDLE_MS ? Number(e.TMUXIFIER_VOICE_IDLE_MS) : undefined,
    voiceMaxMb: e.TMUXIFIER_VOICE_MAX_MB ? Number(e.TMUXIFIER_VOICE_MAX_MB) : undefined,
    voiceMaxSeconds: e.TMUXIFIER_VOICE_MAX_SECONDS ? Number(e.TMUXIFIER_VOICE_MAX_SECONDS) : undefined,
    // Break-glass: an operator can make voice impossible regardless of what is
    // installed, mirroring TMUXIFIER_PASSKEY_ONLY=off.
    voiceOff: e.TMUXIFIER_VOICE !== undefined ? /^(off|0|false|no)$/i.test(String(e.TMUXIFIER_VOICE)) : undefined,
```

Add beside the `uploadMaxBytes` derivation (around line 189):

```js
  merged.voiceMaxMb = clampInt(merged.voiceMaxMb, 1, 64, DEFAULTS.voiceMaxMb);
  merged.voiceMaxBytes = merged.voiceMaxMb * 1024 * 1024;
  merged.voiceMaxSeconds = clampInt(merged.voiceMaxSeconds, 5, 600, DEFAULTS.voiceMaxSeconds);
  merged.voiceIdleMs = clampInt(merged.voiceIdleMs, 30000, 3600000, DEFAULTS.voiceIdleMs);
  // Requires both halves: a binary with no model (or the reverse) cannot
  // transcribe, and advertising voice to the client would only produce 503s.
  merged.voiceEnabled = Boolean(merged.whisperBin && merged.whisperModel) && merged.voiceOff !== true;
```

In `src/server/server.js`, extend `/api/ui-config` (line 934-936):

```js
  app.get('/api/ui-config', { preHandler: requireAuth }, async () => {
    return {
      termFont: config.termFont ?? null,
      termFontSize: config.termFontSize ?? 12,
      uploadMaxBytes,
      // The client renders no microphone at all unless voice is usable, so a
      // half-installed host never shows a button that only 503s.
      voice: Boolean(config.voiceEnabled) && Boolean(voiceEngine),
      voiceMaxSeconds: config.voiceMaxSeconds ?? 120,
    };
  });
```

Add `voiceEngine = null` to the `buildServer` destructured parameter list at `src/server/server.js:71`.

Add to `.gitignore`:

```
# whisper.cpp source, build output and models (npm run setup-voice)
vendor/
```

Add to `.env.example`:

```bash
# --- Voice dictation (optional; off unless both paths below are set) ---
# Populated by `npm run setup-voice`. Set TMUXIFIER_VOICE=off to hard-disable
# voice regardless of what is installed.
#TMUXIFIER_WHISPER_BIN=./vendor/whisper/build/bin/whisper-server
#TMUXIFIER_WHISPER_MODEL=./vendor/whisper/models/ggml-small.en.bin
#TMUXIFIER_VOICE=off
#TMUXIFIER_VOICE_IDLE_MS=600000
#TMUXIFIER_VOICE_MAX_MB=8
#TMUXIFIER_VOICE_MAX_SECONDS=120
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.js test/server.test.js`
Expected: PASS. `server.test.js` must still pass — `/api/ui-config` gained fields but lost none.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.js src/server/server.js .env.example .gitignore test/config.test.js
git commit -m "feat(voice): configuration knobs and UI readiness flag"
```

---

### Task 6: The transcription route (`POST /api/voice`)

**Files:**
- Modify: `src/server/server.js` (new route beside `/api/upload` at line 946)
- Modify: `src/server/index.js` (wire the engine)
- Modify: `src/server/shutdown.js` (stop the engine on SIGTERM)
- Test: `test/voiceRoutes.test.js`

**Interfaces:**
- Consumes: `createVoiceEngine` (Task 4), `normalizeTranscript` (Task 1), `boxActions.injectText` (Task 3), `config.voiceEnabled`/`voiceMaxBytes` (Task 5).
- Produces: `POST /api/voice?box=<id>` returning `{ text, injected, mode }` where `mode` is `'claude' | 'shell' | 'busy' | 'error' | 'empty'`.

- [ ] **Step 1: Write the failing test**

Create `test/voiceRoutes.test.js`, following `test/server.test.js`'s harness shape:

```js
import { test, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let injected;

function makeApp(over = {}) {
  const config = {
    authMode: 'password',
    passwordHash: hashPassword('pw'),
    cookieSecret: 'c'.repeat(32),
    voiceEnabled: true,
    voiceMaxBytes: 1024,
    voiceMaxSeconds: 120,
    ...over.config,
  };
  const store = {
    listBoxes: async () => [{ id: 'b1', name: 'web', host: 'h', user: 'u', sessionName: 'web' }],
    getBox: async (id) => (id === 'b1'
      ? { id: 'b1', name: 'web', host: 'h', user: 'u', sessionName: 'web' } : null),
  };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const boxActions = {
    injectText: async (_box, _session, text) => { injected.push(text); return { injected: true, mode: 'claude' }; },
  };
  const voiceEngine = { transcribe: async () => 'hello\nworld', stop: async () => {}, state: () => 'ready' };
  return buildServer({ config, store, sessions, statusChecker, boxActions, voiceEngine, ...over.server });
}

beforeEach(() => { injected = []; app = makeApp(); });

async function login(a = app) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}

const wav = () => Buffer.from('RIFF0000WAVEfmt ');

async function post(a, cookie, body = wav(), url = '/api/voice?box=b1') {
  return a.inject({
    method: 'POST', url, payload: body,
    headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}) },
  });
}

test('rejects unauthenticated transcription', async () => {
  const res = await post(app, null);
  expect(res.statusCode).toBe(401);
  expect(injected).toEqual([]);
});

test('transcribes, normalizes, and injects into the box session', async () => {
  const res = await post(app, await login());
  expect(res.statusCode).toBe(200);
  // The newline from the engine is collapsed before it reaches send-keys.
  expect(res.json()).toEqual({ text: 'hello world', injected: true, mode: 'claude' });
  expect(injected).toEqual(['hello world']);
});

test('returns 503 when voice is disabled', async () => {
  const a = makeApp({ config: { voiceEnabled: false } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});

test('returns 503 when no engine is wired', async () => {
  const a = makeApp({ server: { voiceEngine: null } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(503);
});

test('rejects an unknown box', async () => {
  const res = await post(app, await login(), wav(), '/api/voice?box=nope');
  expect(res.statusCode).toBe(400);
});

test('rejects an empty body', async () => {
  const res = await post(app, await login(), Buffer.alloc(0));
  expect(res.statusCode).toBe(400);
});

test('enforces voiceMaxBytes with a 413', async () => {
  const res = await post(app, await login(), Buffer.alloc(4096));
  expect(res.statusCode).toBe(413);
  expect(injected).toEqual([]);
});

test('returns the transcript even when injection fails', async () => {
  const a = makeApp({ server: {
    boxActions: { injectText: async () => ({ injected: false, mode: 'busy' }) },
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(200);
  // The text must survive a refused injection — the client puts it on the
  // clipboard so nothing spoken is ever lost.
  expect(res.json()).toEqual({ text: 'hello world', injected: false, mode: 'busy' });
});

test('maps engine overload to 429 and engine failure to 502', async () => {
  const boom = (status) => ({
    transcribe: async () => { const e = new Error('x'); e.status = status; throw e; },
    stop: async () => {}, state: () => 'stopped',
  });
  for (const [status, expected] of [[429, 429], [502, 502], [503, 503]]) {
    const a = makeApp({ server: { voiceEngine: boom(status) } });
    const res = await post(a, await login(a));
    expect(res.statusCode).toBe(expected);
  }
});

test('an empty transcript is reported, not typed', async () => {
  const a = makeApp({ server: {
    voiceEngine: { transcribe: async () => '[BLANK_AUDIO]', stop: async () => {}, state: () => 'ready' },
  } });
  const res = await post(a, await login(a));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ text: '', injected: false, mode: 'empty' });
  expect(injected).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceRoutes.test.js`
Expected: FAIL — the route 404s, so the first content assertion fails with `expected 404 to be 200`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/server.js`, add the import beside the other server-module imports:

```js
import { normalizeTranscript } from './voiceText.js';
```

Add `const voiceMaxBytes = Number(config.voiceMaxBytes) || 8 * 1024 * 1024;` beside the existing `uploadMaxBytes` line (92), then add the route immediately after the `/api/upload` handler (after line 975):

```js
  // Transcribe a browser-recorded WAV with the local whisper engine and type
  // the result into the box's tmux pane, using the same pane-aware guard as
  // uploads (tmuxInject.js). Audio never leaves this host.
  //
  // The transcript is returned even when injection is refused — the client
  // puts it on the clipboard, so a busy pane never costs the user what they
  // just said. Fastify enforces voiceMaxBytes via bodyLimit (413).
  app.post('/api/voice', { onRequest: requireAuth, bodyLimit: voiceMaxBytes }, async (req, reply) => {
    if (!config.voiceEnabled || !voiceEngine) {
      return reply.code(503).send({ error: 'voice dictation is not enabled' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return reply.code(400).send({ error: 'missing audio body' });

    const boxId = String(req.query?.box || '');
    const box = boxId === '__local__' ? null : await store.getBox(boxId);
    if (boxId !== '__local__' && !box) return reply.code(400).send({ error: 'unknown box' });

    let raw;
    try {
      raw = await voiceEngine.transcribe(body);
    } catch (e) {
      const status = Number(e?.status) || 502;
      return reply.code(status).send({ error: `transcription failed: ${e?.message || 'error'}` });
    }

    const text = normalizeTranscript(raw);
    if (!text) return { text: '', injected: false, mode: 'empty' };

    const session = box ? box.sessionName : localSession;
    let inj = { injected: false, mode: 'error' };
    if (boxId === '__local__') {
      inj = await injectLocalText(session, text).catch(() => ({ injected: false, mode: 'error' }));
    } else if (typeof boxActions?.injectText === 'function') {
      inj = await boxActions.injectText(box, session, text).catch(() => ({ injected: false, mode: 'error' }));
    }
    return { text, ...inj };
  });
```

Add `injectLocalText` to the `buildServer` parameter list at line 71, defaulting to a local-shell wrapper. First export the local variant from `src/server/tmuxInject.js`:

```js
// The __local__ terminal runs inside a real local tmux session
// (sessions.openLocal), so the same flow works with a /bin/sh runner.
export function injectLocalText(session, text, { run = runLocalScript } = {}) {
  return injectTextVia(run, session, text, { label: 'dictation' });
}
```

then in `server.js`'s import and parameter list:

```js
import { injectLocalUploadPath, injectLocalText as injectLocalTextDefault } from './tmuxInject.js';
// …in the buildServer parameter list:
//   injectLocalText = injectLocalTextDefault,
```

In `src/server/index.js`, construct the engine after `boxActions` (near line 50) and pass it to `buildServer`:

```js
import { createVoiceEngine } from './voiceEngine.js';

// Only constructed when configured: with voice off this is null and the route
// answers 503, so nothing is spawned and no RAM is held.
const voiceEngine = config.voiceEnabled
  ? createVoiceEngine({
      bin: config.whisperBin,
      model: config.whisperModel,
      idleMs: config.voiceIdleMs,
      threads: Math.min(4, os.cpus().length || 1),
    })
  : null;
```

Add `voiceEngine` to the `buildServer({ … })` call, and add `import os from 'node:os';` if not already present.

In `src/server/shutdown.js`, extend `registerShutdownFlush` so a deploy restart does not leave an orphaned whisper child. Add a `voiceEngine` field to its options object and, in the handler body, before the existing store flushes:

```js
    // Kill the whisper child before flushing stores: it holds no state, and
    // leaving it alive across a restart would strand ~0.85 GB.
    if (voiceEngine?.stop) { try { await voiceEngine.stop(); } catch {} }
```

Pass `voiceEngine` through from `index.js` at the `registerShutdownFlush(...)` call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/voiceRoutes.test.js test/server.test.js`
Expected: PASS, 10 new tests plus the existing server suite unchanged.

- [ ] **Step 5: Run the whole server-side suite**

Run: `npx vitest run`
Expected: PASS. Nothing outside voice should have moved.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js src/server/index.js src/server/shutdown.js src/server/tmuxInject.js test/voiceRoutes.test.js
git commit -m "feat(voice): POST /api/voice transcribe-and-inject route"
```

---

### Task 7: Client-side WAV encoding (`wavEncode.ts`)

Pure, DOM-free, and the reason no ffmpeg dependency is needed: the browser hands whisper exactly the 16 kHz mono PCM it wants.

**Files:**
- Create: `src/web/wavEncode.ts`
- Test: `test/wavEncode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeWav(chunks: Float32Array[], inputRate: number) => ArrayBuffer`, `TARGET_RATE = 16000`, `resampleTo16k(samples: Float32Array, inputRate: number) => Float32Array`.

- [ ] **Step 1: Write the failing test**

Create `test/wavEncode.test.ts`:

```ts
import { test, expect } from 'vitest';
import { encodeWav, resampleTo16k, TARGET_RATE } from '../src/web/wavEncode';

function sine(seconds: number, rate: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

const view = (buf: ArrayBuffer) => new DataView(buf);
const ascii = (buf: ArrayBuffer, off: number, len: number) =>
  String.fromCharCode(...new Uint8Array(buf, off, len));

test('writes a RIFF/WAVE header describing 16 kHz mono 16-bit PCM', () => {
  const buf = encodeWav([sine(1, 48000)], 48000);
  const dv = view(buf);
  expect(ascii(buf, 0, 4)).toBe('RIFF');
  expect(ascii(buf, 8, 4)).toBe('WAVE');
  expect(ascii(buf, 12, 4)).toBe('fmt ');
  expect(dv.getUint32(16, true)).toBe(16);      // PCM fmt chunk size
  expect(dv.getUint16(20, true)).toBe(1);       // format = PCM
  expect(dv.getUint16(22, true)).toBe(1);       // mono
  expect(dv.getUint32(24, true)).toBe(TARGET_RATE);
  expect(dv.getUint32(28, true)).toBe(TARGET_RATE * 2); // byte rate
  expect(dv.getUint16(32, true)).toBe(2);       // block align
  expect(dv.getUint16(34, true)).toBe(16);      // bits per sample
  expect(ascii(buf, 36, 4)).toBe('data');
});

test('declared sizes match the actual buffer length', () => {
  const buf = encodeWav([sine(0.5, 48000)], 48000);
  const dv = view(buf);
  expect(dv.getUint32(4, true)).toBe(buf.byteLength - 8);   // RIFF size
  expect(dv.getUint32(40, true)).toBe(buf.byteLength - 44); // data size
});

test('resamples from both common device rates', () => {
  // AudioContext.sampleRate is device-dependent — 44100 is as common as 48000.
  for (const rate of [48000, 44100]) {
    const buf = encodeWav([sine(1, rate)], rate);
    const samples = (buf.byteLength - 44) / 2;
    expect(samples).toBeGreaterThan(TARGET_RATE * 0.98);
    expect(samples).toBeLessThan(TARGET_RATE * 1.02);
  }
});

test('passes 16 kHz input through without resampling', () => {
  const src = sine(1, 16000);
  expect(resampleTo16k(src, 16000)).toBe(src);
});

test('joins multiple captured chunks in order', () => {
  const a = new Float32Array([1, 1, 1, 1]);
  const b = new Float32Array([-1, -1, -1, -1]);
  const buf = encodeWav([a, b], 16000);
  const dv = view(buf);
  expect(dv.getInt16(44, true)).toBe(32767);      // clamped +1.0
  expect(dv.getInt16(44 + 4 * 2, true)).toBe(-32768); // clamped -1.0
});

test('clamps out-of-range samples instead of wrapping', () => {
  const buf = encodeWav([new Float32Array([2.5, -2.5, 0])], 16000);
  const dv = view(buf);
  expect(dv.getInt16(44, true)).toBe(32767);
  expect(dv.getInt16(46, true)).toBe(-32768);
  expect(dv.getInt16(48, true)).toBe(0);
});

test('produces a header-only file for no input', () => {
  expect(encodeWav([], 48000).byteLength).toBe(44);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wavEncode.test.ts`
Expected: FAIL — `Failed to resolve import "../src/web/wavEncode"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/wavEncode.ts`:

```ts
// Pure PCM → WAV encoding for voice dictation. Like upload.ts and clipboard.ts,
// no DOM or global access — the caller hands in the captured sample chunks — so
// this is unit-testable in Node.
//
// This module is why Tmuxifier needs no ffmpeg: whisper.cpp wants 16 kHz mono
// 16-bit PCM, and the browser can produce exactly that from raw Web Audio
// samples. Encoding server-side would have meant decoding MediaRecorder's
// webm/opus, i.e. an ffmpeg system dependency.

export const TARGET_RATE = 16000;

// Linear interpolation. Good enough for speech at these rates, and far cheaper
// than a windowed-sinc filter; whisper's own frontend is tolerant of the
// aliasing this leaves behind.
export function resampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('invalid input sample rate');
  if (inputRate === TARGET_RATE) return samples;
  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function writeAscii(dv: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(chunks: Float32Array[], inputRate: number): ArrayBuffer {
  const resampled = resampleTo16k(concat(chunks), inputRate);
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const dv = new DataView(buffer);

  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);            // PCM chunk size
  dv.setUint16(20, 1, true);             // format: PCM
  dv.setUint16(22, 1, true);             // channels: mono
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true); // byte rate = rate * blockAlign
  dv.setUint16(32, 2, true);             // block align = channels * bytesPerSample
  dv.setUint16(34, 16, true);            // bits per sample
  writeAscii(dv, 36, 'data');
  dv.setUint32(40, resampled.length * 2, true);

  // Clamp before scaling: a sample outside [-1, 1] would otherwise wrap and
  // turn a loud syllable into a burst of noise.
  for (let i = 0; i < resampled.length; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
```

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run test/wavEncode.test.ts && npx tsc --noEmit`
Expected: PASS, 7 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/wavEncode.ts test/wavEncode.test.ts
git commit -m "feat(voice): pure 16 kHz mono WAV encoder for browser capture"
```

---

### Task 8: Browser capture, readiness gate, and terminal wiring

**Files:**
- Create: `src/web/voiceRecorder.ts`
- Create: `src/web/voiceUi.ts`
- Test: `test/voiceUi.test.ts`
- Modify: `src/web/api.ts:119-124` (`uiConfig` type, new `postVoice`)
- Modify: `src/web/terminal.ts:73-95` (extend the existing key handler), `:236+` (`openTerminal`)

**Interfaces:**
- Consumes: `encodeWav`, `TARGET_RATE` (Task 7); `api.postVoice`, `api.uiConfig` (this task).
- Produces: `createVoiceRecorder(maxSeconds, onAutoStop) => {start(), stop(): Promise<ArrayBuffer>, cancel(), recording()}`; `evaluateVoice(env) => {ok, reason, hint}`; `isVoiceHotkey(ev) => boolean`; `detectVoiceEnv(enabled) => VoiceEnv`; `wireVoice(parent, boxId, host) => {begin(), finish(), dispose()}`.

**Verified facts about `terminal.ts` this task must respect** (checked against the current file — do not assume otherwise):
- `openTerminal(parent, boxId, label)` at line 236 is **synchronous**. It cannot `await api.uiConfig()`; the config must be fetched and the button mounted asynchronously, the way `refitWhenFontReady` already defers work.
- There is **no toolbar element**. `wireUploads(parent, term, boxId)` at line 249 attaches to `parent` and returns a disposer that `dispose()` calls at line 302. `wireVoice` follows exactly that shape.
- `ClipboardDeps` is built inline inside `wireClipboard` (line 45). There is no exported `clipboardDeps` helper, so the copy fallback builds its own from `navigator.clipboard` plus the module-local `execCommandCopy`.

**Critical constraint:** xterm's `attachCustomKeyEventHandler` holds **one** handler. `wireClipboard` (`terminal.ts:73`) already owns it — attaching a second silently disables clipboard copy/paste. Voice must extend that handler, not add its own. `Ctrl+Shift+V` is taken by paste; `Ctrl+Shift+Space` is free.

- [ ] **Step 1: Write the failing test**

Create `test/voiceUi.test.ts`. Only the pure readiness logic and the key predicate are tested here; the microphone itself is covered by the e2e in Task 10:

```ts
import { test, expect } from 'vitest';
import { evaluateVoice, isVoiceHotkey } from '../src/web/voiceUi';

const ready = { supported: true, secureContext: true, enabled: true };

test('reports ready when support, secure context, and server enablement all hold', () => {
  expect(evaluateVoice(ready)).toEqual({ ok: true, reason: '', hint: '' });
});

test('browser support is checked before anything else', () => {
  // Ordered like passkeys.ts evaluateOrigin: the most fundamental blocker wins,
  // so the user is never told to fix TLS on a browser that could not work anyway.
  const v = evaluateVoice({ supported: false, secureContext: false, enabled: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/browser/i);
});

test('an insecure context explains the HTTPS requirement', () => {
  const v = evaluateVoice({ ...ready, secureContext: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/https|secure/i);
  expect(v.hint).toMatch(/DEPLOY/);
});

test('a server with voice off says so rather than blaming the browser', () => {
  const v = evaluateVoice({ ...ready, enabled: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/not enabled|setup-voice/i);
});

test('Ctrl+Shift+Space is the hotkey and Ctrl+Shift+V is left to paste', () => {
  const ev = (over: Record<string, unknown>) =>
    ({ type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
       metaKey: false, altKey: false, repeat: false, ...over }) as unknown as KeyboardEvent;
  expect(isVoiceHotkey(ev({}))).toBe(true);
  expect(isVoiceHotkey(ev({ key: 'v', code: 'KeyV' }))).toBe(false); // clipboard paste
  expect(isVoiceHotkey(ev({ shiftKey: false }))).toBe(false);
  expect(isVoiceHotkey(ev({ ctrlKey: false }))).toBe(false);
  expect(isVoiceHotkey(ev({ metaKey: true }))).toBe(false);
});

test('auto-repeat while the key is held is not a second press', () => {
  const ev = { type: 'keydown', key: ' ', code: 'Space', ctrlKey: true, shiftKey: true,
               metaKey: false, altKey: false, repeat: true } as unknown as KeyboardEvent;
  expect(isVoiceHotkey(ev)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/voiceUi.test.ts`
Expected: FAIL — `Failed to resolve import "../src/web/voiceUi"`.

- [ ] **Step 3: Write the recorder**

Create `src/web/voiceRecorder.ts`:

```ts
// Microphone capture for voice dictation. Raw Float32 frames are collected via
// an AudioWorklet and encoded to 16 kHz mono WAV by the pure wavEncode module,
// so whisper receives its native format and no ffmpeg is needed server-side.

import { encodeWav } from './wavEncode';

// Inlined as a Blob URL rather than a separate asset: Vite would otherwise need
// a worklet entry point, and the module is four lines.
const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tmuxifier-capture', Cap);
`;

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer>;
  cancel(): void;
  recording(): boolean;
}

export function createVoiceRecorder(maxSeconds: number, onAutoStop: () => void): VoiceRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let chunks: Float32Array[] = [];
  let rate = 0;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  function teardown(): void {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    try { node?.disconnect(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { void ctx?.close(); } catch {}
    node = null; stream = null; ctx = null;
  }

  return {
    recording: () => ctx !== null,

    async start(): Promise<void> {
      if (ctx) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext();
      rate = ctx.sampleRate;   // device-dependent: commonly 48000, often 44100
      chunks = [];
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      node = new AudioWorkletNode(ctx, 'tmuxifier-capture');
      node.port.onmessage = (e: MessageEvent) => { chunks.push(e.data as Float32Array); };
      ctx.createMediaStreamSource(stream).connect(node);
      // Transcribe what was captured rather than discarding it: never lose
      // speech to a forgotten key.
      capTimer = setTimeout(onAutoStop, maxSeconds * 1000);
    },

    async stop(): Promise<ArrayBuffer> {
      const captured = chunks;
      const captureRate = rate;
      chunks = [];
      teardown();
      return encodeWav(captured, captureRate || 48000);
    },

    cancel(): void {
      chunks = [];
      teardown();
    },
  };
}
```

- [ ] **Step 4: Write the UI module**

Create `src/web/voiceUi.ts`:

```ts
// Voice dictation UI: the readiness verdict, the hotkey predicate, and the
// button/indicator wiring. The first two are pure so they are unit-testable and
// so the login-style "why is this unavailable" text has exactly one source.

import { api } from './api';
import { createVoiceRecorder, type VoiceRecorder } from './voiceRecorder';
import { termSafe } from './upload';

export interface VoiceEnv {
  supported: boolean;
  secureContext: boolean;
  enabled: boolean;
}

export interface VoiceVerdict {
  ok: boolean;
  reason: string;
  hint: string;
}

// Ordered readiness check, mirroring passkeys.ts evaluateOrigin: the most
// fundamental blocker is reported first, so a user on an unsupported browser is
// never told to go configure TLS.
export function evaluateVoice(env: VoiceEnv): VoiceVerdict {
  if (!env.supported) {
    return { ok: false, reason: 'This browser has no microphone capture support.', hint: 'Try a current Chrome, Edge, or Firefox.' };
  }
  if (!env.secureContext) {
    return {
      ok: false,
      reason: 'Microphone access needs a secure context (HTTPS or localhost).',
      hint: 'Configure TLS — see docs/DEPLOY.md — or reach Tmuxifier on localhost.',
    };
  }
  if (!env.enabled) {
    return { ok: false, reason: 'Voice dictation is not enabled on this server.', hint: 'Run `npm run setup-voice` on the Tmuxifier host.' };
  }
  return { ok: true, reason: '', hint: '' };
}

// Ctrl+Shift+Space. Deliberately not Ctrl+Shift+V — clipboard.ts already claims
// that for paste. `repeat` is excluded because a held key auto-repeats keydown,
// which would otherwise read as a stream of fresh presses.
export function isVoiceHotkey(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown' && ev.type !== 'keyup') return false;
  if (ev.repeat) return false;
  if (!ev.ctrlKey || !ev.shiftKey || ev.metaKey || ev.altKey) return false;
  return ev.code === 'Space';
}

export function detectVoiceEnv(enabled: boolean): VoiceEnv {
  return {
    supported: typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof AudioWorkletNode !== 'undefined',
    secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    enabled,
  };
}

export interface VoiceHost {
  write(text: string): void;      // echo status into the terminal
  copy(text: string): void;       // clipboard fallback when a pane is busy
}

// Owns one recorder and the button element. Returned dispose() detaches it.
export function createVoiceController(boxId: string, maxSeconds: number, host: VoiceHost) {
  let recorder: VoiceRecorder | null = null;
  let busy = false;
  let button: HTMLButtonElement | null = null;

  function setState(s: 'idle' | 'recording' | 'working'): void {
    if (!button) return;
    button.dataset.state = s;
    button.textContent = s === 'recording' ? '● rec' : s === 'working' ? '… ' : '🎤';
    button.title = s === 'recording' ? 'Release to transcribe' : 'Hold to dictate (Ctrl+Shift+Space)';
  }

  async function begin(): Promise<void> {
    if (busy || recorder) return;
    recorder = createVoiceRecorder(maxSeconds, () => { void finish(); });
    try {
      await recorder.start();
      setState('recording');
    } catch (e) {
      recorder = null;
      setState('idle');
      host.write(`\r\n\x1b[33m[voice: ${termSafe((e as Error).message || 'microphone unavailable')}]\x1b[0m\r\n`);
    }
  }

  async function finish(): Promise<void> {
    const r = recorder;
    if (!r || busy) return;
    recorder = null;
    busy = true;
    setState('working');
    try {
      const wav = await r.stop();
      const res = await api.postVoice(boxId, new Blob([wav], { type: 'audio/wav' }));
      if (!res.text) {
        host.write('\r\n\x1b[2m[voice: nothing heard]\x1b[0m\r\n');
      } else if (!res.injected) {
        // A refused injection must never cost the user what they said.
        host.copy(res.text);
        host.write(`\r\n\x1b[33m[voice: pane busy — transcript copied to clipboard]\x1b[0m\r\n`);
      }
    } catch (e) {
      host.write(`\r\n\x1b[33m[voice failed: ${termSafe((e as Error).message || 'error')}]\x1b[0m\r\n`);
    } finally {
      busy = false;
      setState('idle');
    }
  }

  return {
    begin,
    finish,
    cancel(): void { recorder?.cancel(); recorder = null; setState('idle'); },
    mount(parent: HTMLElement, verdict: VoiceVerdict): void {
      button = document.createElement('button');
      button.className = 'voice-btn';
      button.type = 'button';
      if (!verdict.ok) {
        button.disabled = true;
        button.title = `${verdict.reason} ${verdict.hint}`.trim();
      } else {
        button.addEventListener('mousedown', () => { void begin(); });
        button.addEventListener('mouseup', () => { void finish(); });
        button.addEventListener('mouseleave', () => { void finish(); });
      }
      setState('idle');
      parent.appendChild(button);
    },
    dispose(): void { recorder?.cancel(); recorder = null; button?.remove(); button = null; },
  };
}

// Mirrors wireUploads(parent, term, boxId): attaches to the terminal's parent
// element and returns something whose dispose() the caller folds into its own.
// openTerminal is synchronous, so the readiness fetch happens in the
// background and the button appears once the server has answered.
export function wireVoice(parent: HTMLElement, boxId: string, host: VoiceHost) {
  let controller: ReturnType<typeof createVoiceController> | null = null;
  let disposed = false;

  void api.uiConfig().then((cfg) => {
    // No microphone at all when the server has voice off: a button that only
    // ever 503s is worse than no button.
    if (disposed || !cfg?.voice) return;
    const verdict = evaluateVoice(detectVoiceEnv(true));
    controller = createVoiceController(boxId, cfg.voiceMaxSeconds ?? 120, host);
    controller.mount(parent, verdict);
  }).catch(() => {});

  return {
    begin(): void { void controller?.begin(); },
    finish(): void { void controller?.finish(); },
    dispose(): void { disposed = true; controller?.dispose(); controller = null; },
  };
}
```

- [ ] **Step 5: Wire the API client**

In `src/web/api.ts`, extend the `uiConfig` return type at line 119 and add `postVoice` after `uploadFile` (line 124):

```ts
  async uiConfig() { return j<{ termFont: string | null; termFontSize: number; uploadMaxBytes: number; voice: boolean; voiceMaxSeconds: number }>(await fetch('/api/ui-config')); },
  async postVoice(boxId: string, blob: Blob) {
    return j<{ text: string; injected: boolean; mode: 'claude' | 'shell' | 'busy' | 'error' | 'empty' }>(
      await fetch(`/api/voice?box=${encodeURIComponent(boxId)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
      }));
  },
```

- [ ] **Step 6: Extend the existing key handler**

In `src/web/terminal.ts`, `wireClipboard` currently owns the single `attachCustomKeyEventHandler` slot at line 73. Change its signature to accept an optional voice controller and handle the hotkey **inside the same callback** — do not call `attachCustomKeyEventHandler` a second time anywhere:

```ts
function wireClipboard(term: Terminal, voice?: { begin(): void; finish(): void }): void {
  // …existing deps setup unchanged…
  term.attachCustomKeyEventHandler((ev) => {
    // Voice is checked first and returns false so the combo never reaches the
    // PTY. xterm keeps only ONE custom key handler, so this must live in the
    // same callback as the clipboard bindings — a second attach call would
    // silently replace them.
    if (voice && isVoiceHotkey(ev)) {
      if (ev.type === 'keydown') voice.begin();
      else voice.finish();
      return false;
    }
    // …existing clipboard handling unchanged…
  });
}
```

In `openTerminal`, replace the existing lines 248-249:

```ts
  wireClipboard(term);
  const offUploads = wireUploads(parent, term, boxId);
```

with:

```ts
  // Built here rather than reaching into wireClipboard: ClipboardDeps is
  // assembled inline there and never exported. execCommandCopy is the
  // module-local synchronous fallback for insecure contexts.
  const voice = wireVoice(parent, boxId, {
    write: (t) => term.write(t),
    copy: (t) => {
      void writeClipboard(t, {
        clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
        fallbackCopy: execCommandCopy,
      });
    },
  });
  wireClipboard(term, voice);
  const offUploads = wireUploads(parent, term, boxId);
```

Then extend the existing `dispose` at line 302 so the recorder is torn down and the microphone track released when the tab closes — add `voice.dispose();` alongside `offUploads();`:

```ts
    dispose: () => { offUploads(); voice.dispose(); closedByUser = true; clearTimeout(stableTimer); clearTimeout(retryTimer); window.removeEventListener('resize', onResize); ws?.close(); term.dispose(); },
```

Add the import at the top of `terminal.ts`:

```ts
import { wireVoice, isVoiceHotkey } from './voiceUi';
```

Add to `src/web/style.css`:

```css
/* The button is appended to the terminal's own parent (there is no toolbar
   element), so it floats over the top-right corner of the xterm canvas. */
.voice-btn {
  position: absolute;
  top: 6px;
  right: 12px;
  z-index: 5;
  font: inherit;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid #2a3040;
  border-radius: 4px;
  background: #131822;
  color: #c9d1d9;
  cursor: pointer;
  opacity: 0.55;
}
.voice-btn:hover { opacity: 1; }
.voice-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.voice-btn[data-state='recording'] { color: #e5534b; border-color: #e5534b; font-weight: 600; opacity: 1; }
.voice-btn[data-state='working'] { opacity: 0.7; }
```

The button is absolutely positioned, so its containing block must be positioned. Confirm the element `openTerminal` receives as `parent` resolves to `position: relative` in `style.css`; if it does not, add `position: relative` to that rule in the same commit.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/voiceUi.test.ts && npx tsc --noEmit`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 7b: Verify the clipboard bindings still work**

The single-handler constraint is easy to break silently, so check it by hand rather than trusting the diff:

Run `npm run dev`, open a box, select some text (copy-on-select), then press `Ctrl+Shift+V`.
Expected: paste still works. If it does not, a second `attachCustomKeyEventHandler` call was introduced and replaced the clipboard handler — fold the voice branch into `wireClipboard`'s callback instead.

- [ ] **Step 8: Commit**

```bash
git add src/web/voiceRecorder.ts src/web/voiceUi.ts src/web/api.ts src/web/terminal.ts src/web/style.css test/voiceUi.test.ts
git commit -m "feat(voice): browser capture, readiness gate, and hold-to-talk hotkey"
```

---

### Task 9: Install script and documentation

**Files:**
- Create: `scripts/setup-voice.mjs`
- Modify: `package.json` (scripts)
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Consumes: `resolveModel`, `MODEL_IDS`, `DEFAULT_MODEL_ID`, `WHISPER_REPO`, `WHISPER_REF` (Task 2).
- Produces: `npm run setup-voice [-- <model-id>]`, writing `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` into `.env`.

- [ ] **Step 1: Write the script**

Create `scripts/setup-voice.mjs`:

```js
#!/usr/bin/env node
// Build whisper.cpp into the repo-local vendor/ directory and download a model,
// then record both paths in .env. This is the stage-1, command-line half of
// voice setup; stage 2 adds the same flow behind a Settings tab.
//
// Self-contained per the repo principle: everything lands under the repo
// folder, nothing in $HOME.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveModel, MODEL_IDS, DEFAULT_MODEL_ID, WHISPER_REPO, WHISPER_REF } from '../src/server/voiceCatalog.js';
import { upsertEnvFile } from '../src/server/envFile.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(repoRoot, 'vendor', 'whisper');
const modelsDir = path.join(vendorDir, 'models');
const binPath = path.join(vendorDir, 'build', 'bin', 'whisper-server');

const modelId = process.argv[2] || DEFAULT_MODEL_ID;
const model = resolveModel(modelId);
if (!model) {
  console.error(`Unknown model '${modelId}'. Available: ${MODEL_IDS.join(', ')}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.error(`+ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`\nFailed: ${cmd} exited ${res.status}`);
    process.exit(res.status || 1);
  }
}

// Preflight: fail early with a real number rather than dying mid-build.
const REQUIRED_BYTES = model.bytes + 700 * 1024 * 1024; // model + source + build output
const stat = fs.statfsSync(repoRoot);
const freeBytes = stat.bavail * stat.bsize;
if (freeBytes < REQUIRED_BYTES) {
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  console.error(`Not enough disk: need ~${gb(REQUIRED_BYTES)} GB, have ${gb(freeBytes)} GB free.`);
  process.exit(1);
}

// `.status` is null when the binary is absent entirely, so !== 0 covers both
// "not installed" and "installed but broken". Note `!x === 0` would be a bug:
// it parses as `(!x) === 0`, which is never true.
if (spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('cmake not found — installing it (requires root).');
  run('apt-get', ['install', '-y', 'cmake'], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
}

if (!fs.existsSync(path.join(vendorDir, '.git'))) {
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_REF, WHISPER_REPO, vendorDir]);
} else {
  run('git', ['-C', vendorDir, 'fetch', '--depth', '1', 'origin', 'tag', WHISPER_REF]);
  run('git', ['-C', vendorDir, 'checkout', WHISPER_REF]);
}

// whisper.cpp translation units peak around 1 GB each; -j4 in a 4 GB container
// OOMs mid-build, so parallelism is capped by available RAM as well as cores.
const ramGb = os.totalmem() / 1024 ** 3;
const jobs = Math.max(1, Math.min(os.cpus().length || 1, 4, ramGb < 6 ? 2 : 4));
run('cmake', ['-B', path.join(vendorDir, 'build'), '-S', vendorDir, '-DCMAKE_BUILD_TYPE=Release']);
run('cmake', ['--build', path.join(vendorDir, 'build'), '--config', 'Release', '-j', String(jobs), '--target', 'whisper-server']);

if (!fs.existsSync(binPath)) {
  console.error(`Build finished but ${binPath} is missing.`);
  process.exit(1);
}

// Download to a temp path, verify, and only then rename into place: a killed
// download must never leave a truncated file that the server would later mmap.
fs.mkdirSync(modelsDir, { recursive: true });
const finalModel = path.join(modelsDir, model.file);
if (!fs.existsSync(finalModel)) {
  const tmp = `${finalModel}.part`;
  console.error(`+ downloading ${model.file} (${(model.bytes / 1024 ** 2).toFixed(0)} MB)`);
  const res = await fetch(model.url);
  if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== model.sha256) {
    console.error(`Integrity check failed for ${model.file}.`);
    console.error(`  expected ${model.sha256}`);
    console.error(`  got      ${digest}`);
    process.exit(1);
  }
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, finalModel);
}

upsertEnvFile(path.join(repoRoot, '.env'), {
  TMUXIFIER_WHISPER_BIN: binPath,
  TMUXIFIER_WHISPER_MODEL: finalModel,
});

console.error('\nVoice dictation installed.');
console.error(`  binary ${binPath}`);
console.error(`  model  ${finalModel}`);
console.error('\nRestart Tmuxifier, then hold Ctrl+Shift+Space in a terminal to dictate.');
```

- [ ] **Step 2: Wire the npm script**

In `package.json`, add beside `gen-secret`:

```json
    "setup-voice": "node scripts/setup-voice.mjs",
```

- [ ] **Step 3: Verify `upsertEnvFile`'s real signature**

The script above assumes `upsertEnvFile(path, kvObject)`. Confirm before running:

Run: `grep -n "export function upsertEnvFile" -A 6 src/server/envFile.js`
Expected: a signature taking a file path and key/value pairs. **If it differs, adapt the call in Step 1 to match — do not change `envFile.js`**, which the password and secret scripts already depend on.

- [ ] **Step 4: Run the installer for real**

Run: `npm run setup-voice`
Expected: cmake install (if absent), clone at the pinned tag, a build taking roughly 90 seconds, a model download that passes its integrity check, and two new lines in `.env`. Total footprint ~1.2 GB under `vendor/`.

- [ ] **Step 5: Verify the binary actually runs**

Run:
```bash
./vendor/whisper/build/bin/whisper-server --help | head -5
```
Expected: whisper-server usage text including `--port` and `--host`. A dynamic-linker error here means the build picked up libraries the runtime lacks, and must be resolved before the engine can spawn it.

- [ ] **Step 6: Document it**

Add a "Voice dictation" section to `README.md` covering: what it is, that Claude Code's own `/voice` cannot work on a headless box, `npm run setup-voice [-- <model>]`, the HTTPS requirement for microphone access, the `Ctrl+Shift+Space` hotkey, that audio never leaves the host, and that `rm -rf vendor/whisper` reclaims the disk.

Add to the `CLAUDE.md` architecture list (and the matching section of `AGENTS.md`, which is kept in sync):

```
- `voiceText.js` / `voiceCatalog.js` / `voiceEngine.js` — voice dictation: pure transcript
  normalization (newline collapse is load-bearing — a newline through `send-keys` is Enter),
  the pinned model allowlist with SHA-256 digests (the chokepoint that keeps no user-supplied
  URL or path from reaching a download), and the lazily-spawned whisper.cpp server with an
  idle timeout. `POST /api/voice` transcribes a browser-recorded WAV and types the result into
  the pane via the same `injectVia` guard uploads use. Audio never leaves the host.
```

Add to the Security notes in both files:

```
- Voice dictation is off unless both `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` are
  set, and `TMUXIFIER_VOICE=off` hard-disables it regardless. Transcripts are stripped of
  control characters before reaching `send-keys`, so a transcription artefact cannot emit an
  escape sequence into a pane. Audio is transcribed by a local whisper.cpp process and is never
  sent to Anthropic or any third party — unlike Claude Code's built-in `/voice`.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-voice.mjs package.json README.md CLAUDE.md AGENTS.md
git commit -m "feat(voice): setup-voice installer and documentation"
```

---

### Task 10: End-to-end verification

Proves the whole chain — browser capture through to text in a real tmux pane — without a model, a compiler, or a GPU, by pointing the engine at a fixture binary.

**Files:**
- Create: `test/e2e/fixtures/fake-whisper-server.mjs`
- Create: `test/e2e/voice.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the fixture binary**

Create `test/e2e/fixtures/fake-whisper-server.mjs`. It speaks whisper-server's contract — the readiness line on stdout and `/inference` returning `{text}` — so the engine's real code runs unmodified:

```js
#!/usr/bin/env node
// Stands in for whisper-server in e2e runs: same startup announcement, same
// /inference response shape, no model and no compiler required.
import http from 'node:http';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const host = argv[argv.indexOf('--host') + 1] || '127.0.0.1';
const text = process.env.FAKE_WHISPER_TEXT || 'hello from the fixture';

http.createServer((req, res) => {
  if (!req.url.startsWith('/inference')) { res.writeHead(404).end(); return; }
  // Drain the multipart body so the client's write always completes.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
  });
}).listen(port, host, () => {
  console.log(`whisper server listening at http://${host}:${port}`);
});
```

Run: `chmod +x test/e2e/fixtures/fake-whisper-server.mjs`

- [ ] **Step 2: Write the e2e spec**

Create `test/e2e/voice.spec.ts`, following the existing local-sshd box helper in `test/helpers`:

```ts
import { test, expect, type Page } from '@playwright/test';

// Chromium grants microphone access without a prompt under this permission,
// and --use-fake-device-for-media-capture feeds it a synthetic tone. The
// transcript itself comes from the fixture server, so these assertions are
// about plumbing, not speech recognition accuracy.
//
// Note the suite's baseURL is http://127.0.0.1:7438 — plain HTTP, but a
// loopback address IS a secure context per the W3C definition, so
// getUserMedia and window.isSecureContext both work here without TLS.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-capture', '--use-fake-ui-for-media-stream'] },
});

// Same login and open-box flow as tmuxifier.spec.ts.
async function openLocalhostBox(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  // Wait for the remote shell to actually draw: the pane must be at a prompt
  // for classifyPaneState to permit injection at all.
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
}

test('dictation types the transcript into the tmux pane', async ({ page }) => {
  await openLocalhostBox(page);

  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await expect(mic).toBeEnabled();

  await mic.dispatchEvent('mousedown');
  await page.waitForTimeout(500);          // capture a little synthetic audio
  await mic.dispatchEvent('mouseup');

  // The fixture always returns this text; seeing it in the pane proves the
  // whole chain: capture, WAV encode, POST, engine, normalize, send-keys.
  await expect(page.locator('.xterm-rows').first())
    .toContainText('hello from the fixture', { timeout: 15000 });
});

test('the transcript is typed but never submitted', async ({ page }) => {
  await openLocalhostBox(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });

  await mic.dispatchEvent('mousedown');
  await page.waitForTimeout(300);
  await mic.dispatchEvent('mouseup');
  await expect(page.locator('.xterm-rows').first())
    .toContainText('hello from the fixture', { timeout: 15000 });

  // Never auto-Enter: the shell must not have run it. If Enter had been sent,
  // the shell would report a command-not-found for 'hello'.
  await page.waitForTimeout(1000);
  await expect(page.locator('.xterm-rows').first()).not.toContainText('command not found');
});
```

The "microphone hidden when voice is disabled" case needs a server started *without* `TMUXIFIER_WHISPER_BIN`, which the shared `global-setup.js` server cannot provide. Rather than add a second Playwright project for one assertion, that path is already covered by `voiceRoutes.test.js`'s 503 cases and by `config.test.js`'s `voiceEnabled` defaults — so it is deliberately not duplicated here.

- [ ] **Step 3: Point the e2e server at the fixture**

In the Playwright web-server configuration (`playwright.config.ts`), set for the voice project:

```
TMUXIFIER_WHISPER_BIN=./test/e2e/fixtures/fake-whisper-server.mjs
TMUXIFIER_WHISPER_MODEL=./test/e2e/fixtures/fake-model.bin
```

Create the placeholder model so the config's existence check passes:

```bash
printf 'not a real model' > test/e2e/fixtures/fake-model.bin
```

- [ ] **Step 4: Run the e2e suite**

Run: `npm run test:e2e -- voice.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: typecheck clean, all vitest suites pass.

- [ ] **Step 6: Manual verification against real whisper**

Automated tests deliberately never exercise real transcription. Verify once by hand on the Tmuxifier host:

1. Open a box terminal over HTTPS (microphone capture requires a secure context).
2. Hold `Ctrl+Shift+Space`, say "refactor the auth middleware", release.
3. Confirm the text appears in the pane, that no Enter was sent, and that the phrase is accurate.
4. Run `free -m` during a dictation and confirm the whisper child appears; wait past `TMUXIFIER_VOICE_IDLE_MS` and confirm it exits.
5. Start a `sleep 60` in the pane, dictate again, and confirm the busy-pane path reports "pane busy" and puts the transcript on the clipboard instead of typing into the running command.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/fixtures/ test/e2e/voice.spec.ts playwright.config.ts
git commit -m "test(voice): end-to-end dictation coverage with a fixture engine"
```

---

## Stage 1 complete

At this point voice dictation works end to end, installed from the command line. Stage 2 — the `voiceInstall` job manager, `voiceInstallStore`, `voiceStore`, the four management routes, and `settingsVoice.ts` — gets its own plan, written after this lands so it can absorb anything learned here.
