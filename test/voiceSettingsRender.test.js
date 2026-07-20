import { test, expect, afterEach } from 'vitest';

// Render-level coverage for Settings -> Voice. The repo convention is that
// DOM-building modules are not unit-tested (settingsNetbox.ts, proxmoxUi.ts have
// no tests), and that convention let a real bug through: after an install
// finished, the model row kept reading "will download" until the modal was
// closed and reopened. The render path is small enough to drive with a stub, and
// the bug is worth a permanent guard, so this file is a deliberate exception.
//
// Only the DOM surface settingsVoice.ts actually touches is stubbed:
// createElement, append/appendChild/replaceChildren, textContent, className,
// style, and the checked/disabled/onchange bits of an input.

function makeNode(tag) {
  return {
    tag, className: '', textContent: '', children: [], attrs: {}, style: {},
    checked: false, disabled: false, value: '', scrollTop: 0, scrollHeight: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...cs) { this.children.push(...cs); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...cs) { this.children = cs; },
    remove() {},
  };
}

function textOf(n) {
  if (typeof n === 'string') return n;
  return (n.textContent || '') + (n.children || []).map(textOf).join('');
}
const lines = (root) => (root.children || []).map((c) => textOf(c).trim()).filter(Boolean);
const modelRow = (root, id) => lines(root).find((l) => l.includes(id) && l.includes('MB'));

const realFetch = globalThis.fetch;
const realDocument = globalThis.document;
const realWindow = globalThis.window;
const realNavigator = globalThis.navigator;
const realWorklet = globalThis.AudioWorkletNode;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.document = realDocument;
  globalThis.window = realWindow;
  globalThis.navigator = realNavigator;
  globalThis.AudioWorkletNode = realWorklet;
});

// A server where the install finishes, but the FIRST status call afterwards
// still reports the model as not installed — the window a single refresh falls
// into. `postDone` makes that deterministic rather than timing-dependent.
function stubEnvironment() {
  globalThis.document = { createElement: (tag) => makeNode(tag) };
  globalThis.window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    isSecureContext: true,
  };
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } };
  globalThis.AudioWorkletNode = function AudioWorkletNode() {};

  const state = { jobStatus: 'idle', mediumInstalled: false, selected: 'small.en', postDone: 0 };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (body) => ({ ok: true, json: async () => body });

    if (u.startsWith('/api/voice/status')) {
      if (state.jobStatus === 'done') {
        if (state.postDone > 0) state.mediumInstalled = true;
        state.postDone += 1;
      }
      return json({
        installed: true,
        enabled: true,
        model: state.selected,
        pinned: { bin: 'vendor', model: 'store' },
        engine: 'stopped',
        models: [
          { id: 'small.en', file: 'ggml-small.en.bin', bytes: 487614201, installed: true },
          { id: 'medium.en-q5_0', file: 'ggml-medium.en-q5_0.bin', bytes: 539225533, installed: state.mediumInstalled },
        ],
        job: state.jobStatus === 'running'
          ? { id: 'j1', model: 'medium.en-q5_0', status: 'running', phase: 'model', log: 'building…', error: null }
          : null,
      });
    }
    if (u.startsWith('/api/voice/install/')) {
      return json({ id: 'j1', model: 'medium.en-q5_0', status: state.jobStatus, phase: null, log: '+ download…', error: null });
    }
    if (u.startsWith('/api/voice/install')) {
      state.jobStatus = 'running';
      return json({ id: 'j1', model: 'medium.en-q5_0', status: 'running', phase: 'preflight', log: '', error: null });
    }
    if (u.startsWith('/api/voice/settings')) {
      const patch = JSON.parse(opts.body);
      if (patch.model) state.selected = patch.model;
      return json({ enabled: true, model: state.selected });
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  return state;
}

test('a completed install updates the model row even when the first status call is too early', async () => {
  const state = stubEnvironment();
  const { renderVoiceSection } = await import('../src/web/settingsVoice');

  const content = makeNode('div');
  await renderVoiceSection(content);
  expect(modelRow(content, 'medium.en-q5_0')).toMatch(/will download/);

  // Selecting a model that is not on disk starts the install.
  const row = content.children.find((c) => textOf(c).includes('medium.en-q5_0'));
  const radio = row.children.find((c) => c.tag === 'input');
  radio.checked = true;
  await radio.onchange();

  // The install finishes on the server.
  state.jobStatus = 'done';
  state.selected = 'medium.en-q5_0';

  // The poller stops the moment it sees a non-running job, so exactly ONE
  // status fetch follows. Before the settle loop, that single fetch consumed
  // the too-early window and the row stayed "will download" until the modal was
  // reopened.
  await new Promise((r) => { setTimeout(r, 4000); });

  expect(modelRow(content, 'medium.en-q5_0')).toMatch(/installed/);
  expect(modelRow(content, 'medium.en-q5_0')).not.toMatch(/will download/);
}, 15000);
