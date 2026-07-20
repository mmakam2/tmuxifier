import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerShutdownFlush } from '../src/server/shutdown.js';
import { createFleetStore } from '../src/server/fleetStore.js';

test('SIGTERM flushes a pending debounced store write before exiting 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-shutdown-'));
  const store = createFleetStore({ dataDir: dir });
  store.save([{ id: 'j1', status: 'done', targets: [] }]); // schedules a debounced write

  const proc = new EventEmitter();
  let exitCode = null;
  await new Promise((resolve) => {
    registerShutdownFlush({
      proc,
      flush: [() => store.whenIdle()],
      exit: (code) => { exitCode = code; resolve(); },
    });
    proc.emit('SIGTERM');
  });

  expect(exitCode).toBe(0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'fleet-jobs.json'), 'utf8'));
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0].id).toBe('j1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hanging flusher cannot block shutdown past the timeout, and a rejecting one still exits 0', async () => {
  const proc = new EventEmitter();
  let exitCode = null;
  await new Promise((resolve) => {
    registerShutdownFlush({
      proc,
      flush: [() => new Promise(() => {}), () => Promise.reject(new Error('disk gone'))],
      exit: (code) => { exitCode = code; resolve(); },
      log: () => {},
      timeoutMs: 50,
    });
    proc.emit('SIGINT');
  });
  expect(exitCode).toBe(0);
});

test('SIGTERM stops the voice engine before exiting', async () => {
  const proc = new EventEmitter();
  let exitCode = null;
  let stopped = false;
  await new Promise((resolve) => {
    registerShutdownFlush({
      proc,
      voiceEngine: { stop: async () => { stopped = true; } },
      flush: [],
      exit: (code) => { exitCode = code; resolve(); },
    });
    proc.emit('SIGTERM');
  });
  expect(stopped).toBe(true);
  expect(exitCode).toBe(0);
});

test('a rejecting voiceEngine.stop() does not prevent the job-store flushes from running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-shutdown-voice-'));
  const store = createFleetStore({ dataDir: dir });
  store.save([{ id: 'j2', status: 'done', targets: [] }]); // schedules a debounced write

  const proc = new EventEmitter();
  let exitCode = null;
  await new Promise((resolve) => {
    registerShutdownFlush({
      proc,
      // A broken engine must not strand the flush that saves a
      // just-finished job's final state — that's the regression that
      // actually matters here.
      voiceEngine: { stop: async () => { throw new Error('engine wedged'); } },
      flush: [() => store.whenIdle()],
      exit: (code) => { exitCode = code; resolve(); },
      log: () => {},
    });
    proc.emit('SIGTERM');
  });

  expect(exitCode).toBe(0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'fleet-jobs.json'), 'utf8'));
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0].id).toBe('j2');
  fs.rmSync(dir, { recursive: true, force: true });
});
