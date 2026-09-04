import { test, expect } from 'vitest';
import { createBoxActions } from '../src/server/boxActions.js';
import { buildVoiceWriterRemote } from '../src/server/voiceWriter.js';

const BOX = { id: 'b1', host: '192.168.1.10', user: 'root', sessionName: 'web' };

test('openAudioSink builds the probe argv around the writer remote and returns the pipe handle', () => {
  const calls = [];
  const handle = { stdin: {}, done: Promise.resolve({ code: 0 }), kill() {} };
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), pipe: (argv) => { calls.push(argv); return handle; }, controlDir: '/tmp/cm' });
  expect(actions.openAudioSink(BOX)).toBe(handle);
  expect(calls).toHaveLength(1);
  const argv = calls[0];
  expect(argv[argv.length - 1]).toBe(buildVoiceWriterRemote());
  expect(argv.join(' ')).toContain('root@192.168.1.10');
  expect(argv.join(' ')).toContain('BatchMode=yes');
});

test('openAudioSink refuses an unsafe box before touching the transport', () => {
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), pipe: () => { throw new Error('must not be called'); }, controlDir: '/tmp/cm' });
  expect(() => actions.openAudioSink({ ...BOX, host: 'bad host; rm -rf /' })).toThrow();
});

test('openAudioSink throws when no pipe transport is wired', () => {
  const actions = createBoxActions({ run: async () => ({ code: 0 }), runStdin: async () => ({ code: 0 }), controlDir: '/tmp/cm' });
  expect(() => actions.openAudioSink(BOX)).toThrow(/not supported/);
});
