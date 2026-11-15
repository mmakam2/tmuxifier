import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookArgsFor } from '../src/server/claudeAgentHooks.js';
import { WAKE_INLINE_CHARS } from '../src/server/agentMailText.js';

// Replays every payload recorded from a real Claude Code session that was woken by agent mail
// (test/fixtures/claude-mail-wake-trace.jsonl) through the real hook script, in order,
// dispatched exactly as the registration table says. Lines are 1-based to match
// test/fixtures/README-claude-mail-wake-trace.md. REPLAY_TRAIL=1 prints the marker per line.
// The wakes were recorded with an older wake wording: nothing here reads the wake's head beyond
// the tag and its first line, so a change of wording or length never breaks the replay.

const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));
const TRACE = fileURLToPath(new URL('./fixtures/claude-mail-wake-trace.jsonl', import.meta.url));

// Fake tmux on PATH: the hook only calls `tmux display-message -p '#S'`.
async function env() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailwakereplay-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tmux'), "#!/bin/sh\nprintf '%s\\n' 'rec'\n", { mode: 0o755 });
  return { dir, e: { HOME: dir, TMUX: '/tmp/tmux-0/default,123,0', TMUX_PANE: '%3', PATH: `${bin}:/usr/bin:/bin` } };
}

function run(arg, e, stdin) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [HOOK, arg], { env: e }, (err) => resolve(err ? 1 : 0));
    // The script exits without reading stdin on its no-op paths; EPIPE is fine.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const readTrace = async () => (await fs.readFile(TRACE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const isWake = (p) => p.hook_event_name === 'UserPromptSubmit' && p.prompt.includes('<task-notification>') && p.prompt.includes('[tmuxifier-mail m-');

test('the recorded mail wakes keep the marker honest', async () => {
  const { dir, e } = await env();
  try {
    const payloads = await readTrace();
    const states = [];
    for (const payload of payloads) {
      for (const arg of hookArgsFor(payload)) {
        // Every dispatch must exit 0: a non-zero hook exit surfaces into the Claude session.
        expect(await run(arg, e, JSON.stringify(payload)), `line ${states.length + 1} ${arg}`).toBe(0);
      }
      const m = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'rec%3'), 'utf8').catch(() => '');
      const parts = m.trim().split(':');
      states.push({ line: states.length + 1, event: payload.hook_event_name, wake: isWake(payload), marker: m.trim() ? `${parts[1]}/${parts[3]}` : '' });
    }
    if (process.env.REPLAY_TRAIL) for (const s of states) console.log(`${s.line}\t${s.event}${s.wake ? ' (wake)' : ''}\t${s.marker}`);
    const at = (n) => states[n - 1];
    const wakeAt = (n) => { expect(at(n).wake, `line ${n} is a wake`).toBe(true); return at(n).marker; };

    expect(at(1).marker).toBe('ready/start');

    // (a) idle session, a message, the agent answers with tmx reply: wake -> working/resume,
    // its Stop -> ready/stop. Lines 2-3 are the first wake (the agent declined to answer);
    // lines 15-18 and 20-23 are the heredoc and pipe replies.
    for (const [wake, stop] of [[2, 3], [10, 13], [15, 18], [20, 23]]) {
      expect(wakeAt(wake)).toBe('working/resume');
      expect(at(stop).event).toBe('Stop');
      expect(at(stop).marker).toBe('ready/stop');
    }

    // (b) `sleep 45` in the background, a wake 10 s after the turn ended, then the shell ends.
    expect(at(26).event).toBe('PreToolUse');
    expect(at(28).event).toBe('Stop');
    expect(at(28).marker).toBe('working/prompt'); // Stop before the wake: the shell token holds it
    expect(wakeAt(30)).toBe('working/resume');
    expect(at(33).event).toBe('Stop');
    expect(at(33).marker).toBe('working/prompt'); // the wake's Stop: the shell is still running
    expect(at(35).event).toBe('UserPromptSubmit');
    expect(payloads[34].prompt).toContain('<task-id>'); // the real completion
    expect(at(35).marker).toBe('working/resume');
    expect(at(36).event).toBe('Stop');
    expect(at(36).marker).toBe('ready/stop');

    // (c) a background subagent's permission dialog is open when a message arrives.
    expect(at(44).event).toBe('PermissionRequest');
    expect(at(44).marker).toBe('blocked/permission');
    expect(at(46).event).toBe('Notification');
    expect(at(46).marker).toBe('blocked/permission');
    expect(wakeAt(47)).toBe('blocked/permission'); // at the wake: still blocked
    // Not pinned: the main agent's Stop after the woken turn (line 50) writes working/prompt
    // while the subagent's dialog is still on screen (see the README). After the approval the
    // subagent finishes, its completion resumes the main agent and the turn ends ready.
    expect(at(54).event).toBe('UserPromptSubmit');
    expect(payloads[53].prompt).toContain('<task-id>');
    expect(at(54).marker).toBe('working/resume');
    expect(at(55).marker).toBe('ready/stop');

    // Wake-size checks (lines 57-75): each wake is working/resume and its Stop ready/stop.
    for (const [wake, stop] of [[57, 60], [62, 65], [67, 70], [71, 75]]) {
      expect(wakeAt(wake)).toBe('working/resume');
      expect(at(stop).event).toBe('Stop');
      expect(at(stop).marker).toBe('ready/stop');
    }

    // /exit deletes the marker.
    expect(states.at(-1).event).toBe('SessionEnd');
    expect(states.at(-1).marker).toBe('');

    // A wake never takes the operator's prompt branch, and no Stop with nothing outstanding
    // stays working: every Stop is ready/stop except the two gated by a live token.
    for (const s of states) if (s.wake) expect(s.marker === 'working/resume' || s.marker === 'blocked/permission', `line ${s.line}`).toBe(true);
    for (const s of states) if (s.event === 'Stop' && ![28, 33, 42, 50].includes(s.line)) expect(s.marker, `line ${s.line}`).toBe('ready/stop');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the recorded wakes carry the body whole up to the inline limit, then the cut note', async () => {
  const payloads = await readTrace();
  // The size checks sent "Size test <n>: reply with only the word ok. " padded with 0-9 to n characters.
  const sent = (n) => {
    let s = `Size test ${n}: reply with only the word ok. `;
    while (s.length < n) s += '0123456789';
    return s.slice(0, n);
  };
  const seen = [];
  for (const p of payloads) {
    if (!isWake(p)) continue;
    const size = p.prompt.match(/\n\nSize test (\d+): /);
    if (!size) continue;
    const n = Number(size[1]);
    const thread = p.prompt.match(/thread (t-[a-z2-9]{8})\./)[1];
    const body = p.prompt.slice(p.prompt.indexOf(`Size test ${n}: `), p.prompt.lastIndexOf('\n\n</system-reminder>'));
    const cut = `\n[cut: run "tmx read ${thread}" for the full message]`;
    expect(body, `size ${n}`).toBe(n <= WAKE_INLINE_CHARS ? sent(n) : sent(n).slice(0, WAKE_INLINE_CHARS) + cut);
    seen.push(n);
  }
  expect(seen).toEqual([2000, 4000, 16000, 60000]);
});
