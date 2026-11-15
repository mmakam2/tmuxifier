import { test, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAIL_HOOKS, MAIL_PERMISSION_RULE, SKILL_SEPARATOR,
  buildAgentMailInstallScript, createAgentMailPusher,
} from '../src/server/claudeAgentMail.js';
import { buildAgentHooksInstallScript } from '../src/server/claudeAgentHooks.js';

const TMX_ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-mail.sh', import.meta.url));
const SKILL_ASSET = fileURLToPath(new URL('../src/server/assets/tmuxifier-mail-skill.md', import.meta.url));
const readAssets = async () => ({ script: await fs.readFile(TMX_ASSET), skill: await fs.readFile(SKILL_ASSET) });

function runShell(script, env, stdin, shell = '/bin/sh') {
  return new Promise((resolve) => {
    const child = execFile(shell, ['-c', script], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}

// What the pusher sends: the asset, a newline, the separator line, the skill.
const stdinOf = (script, skill) => Buffer.concat([Buffer.from(script), Buffer.from(`\n${SKILL_SEPARATOR}\n`), Buffer.from(skill)]);
const SMALL = () => stdinOf('#!/bin/sh\n# tmuxifier-mail\necho tmx\n', '---\nname: tmuxifier-mail\ndescription: test\n---\n\nbody\n');

// The commands every branch of the installer needs, without any JSON tool.
const BASE_TOOLS = ['sh', 'cat', 'mkdir', 'chmod', 'mv', 'rm', 'ln', 'sed', 'head', 'wc', 'cp', 'readlink', 'grep', 'printf'];
const which = (t) => execFileSync('/bin/sh', ['-c', `command -v ${t}`]).toString().trim();

// A box with a fake claude on PATH. `tools`: when given, PATH holds ONLY symlinks to these
// commands (plus the fake claude), so a test can take away curl or force one merge tool.
async function claudeBox({ tools = null, claude = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'am-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(bin);
  if (claude) await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  if (tools) for (const t of tools) await fs.symlink(which(t), path.join(bin, t));
  const cfg = path.join(home, '.claude');
  return {
    home, cfg,
    settings: path.join(cfg, 'settings.json'),
    tmx: path.join(home, '.tmuxifier-mail', 'tmx'),
    link: path.join(home, '.local', 'bin', 'tmx'),
    skill: path.join(cfg, 'skills', 'tmuxifier-mail', 'SKILL.md'),
    env: { HOME: home, CLAUDE_CONFIG_DIR: cfg, PATH: tools ? bin : `${bin}:/usr/bin:/bin` },
  };
}

const install = (b, stdin = SMALL(), shell) => runShell(buildAgentMailInstallScript(), b.env, stdin, shell);
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const mode = async (p) => (await fs.stat(p)).mode & 0o777;
const exists = (p) => fs.lstat(p).then(() => true, () => false);
const isMail = (e) => JSON.stringify(e).includes('tmuxifier-mail');
const isAgentHook = (e) => JSON.stringify(e).includes('tmuxifier-agent-hook');

test('no claude: drains stdin, writes nothing, prints skipped-no-claude', async () => {
  const b = await claudeBox({ claude: false });
  const res = await install(b);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe('AGENTMAIL: skipped-no-claude\n');
  expect(await fs.readdir(b.home)).toEqual([]);
});

test('no curl: skipped-no-curl', async () => {
  const b = await claudeBox({ tools: [...BASE_TOOLS, 'jq'] });
  const res = await install(b);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe('AGENTMAIL: skipped-no-curl\n');
  expect(await fs.readdir(b.home)).toEqual([]);
});

test('a foreign ~/.local/bin/tmx is left alone: skipped-foreign-tmx and no settings change', async () => {
  const kinds = {
    'regular file': async (b) => fs.writeFile(b.link, '#!/bin/sh\necho other tmx\n', { mode: 0o755 }),
    'symlink elsewhere': async (b) => { await fs.writeFile(path.join(b.home, 'real-tmx'), 'x'); await fs.symlink(path.join(b.home, 'real-tmx'), b.link); },
    'dangling symlink elsewhere': async (b) => fs.symlink(path.join(b.home, 'nowhere', 'tmx'), b.link),
    'relative symlink to ours': async (b) => fs.symlink('../../.tmuxifier-mail/tmx', b.link),
  };
  for (const [kind, plant] of Object.entries(kinds)) {
    const b = await claudeBox();
    await fs.mkdir(path.dirname(b.link), { recursive: true });
    await plant(b);
    await fs.mkdir(b.cfg, { recursive: true });
    const before = '{"theme":"dark","hooks":{"Stop":[]}}';
    await fs.writeFile(b.settings, before);
    const linkBefore = await fs.lstat(b.link);
    const res = await install(b);
    expect(res.code, kind).toBe(0);
    expect(res.stdout, kind).toBe('AGENTMAIL: skipped-foreign-tmx\n');
    expect(await fs.readFile(b.settings, 'utf8'), kind).toBe(before);
    expect(await exists(path.join(b.home, '.tmuxifier-mail')), kind).toBe(false);
    expect(await exists(path.join(b.cfg, 'skills')), kind).toBe(false);
    const linkAfter = await fs.lstat(b.link);
    expect(linkAfter.ino, kind).toBe(linkBefore.ino);
    expect(linkAfter.mtimeMs, kind).toBe(linkBefore.mtimeMs);
    expect((await fs.readdir(b.cfg)).sort(), kind).toEqual(['settings.json']);
  }
});

test('fresh box: tmx is 0755 with "# tmuxifier-mail" on line 2, the skill has front matter, the symlink points at it, the directory is 0700', async () => {
  for (const shell of ['/bin/sh', '/usr/bin/bash', '/usr/bin/zsh']) {
    const b = await claudeBox();
    const res = await install(b, stdinOf((await readAssets()).script, (await readAssets()).skill), shell);
    expect(res.code, `${shell} ${res.stderr}`).toBe(0);
    expect(res.stdout, shell).toBe('AGENTMAIL: applied\n');
    expect(await mode(b.tmx), shell).toBe(0o755);
    expect((await fs.readFile(b.tmx, 'utf8')).split('\n')[1], shell).toBe('# tmuxifier-mail');
    const skill = await fs.readFile(b.skill, 'utf8');
    expect(skill, shell).toMatch(/^---\nname: tmuxifier-mail\ndescription: [^\n]+\n---\n/);
    expect(await fs.readlink(b.link), shell).toBe(path.join(b.home, '.tmuxifier-mail', 'tmx'));
    expect(await mode(path.join(b.home, '.tmuxifier-mail')), shell).toBe(0o700);
    // A settings.json that did not exist is created 0600 with exactly our entries.
    expect(await mode(b.settings), shell).toBe(0o600);
    expect(await readJson(b.settings), shell).toEqual({ hooks: MAIL_HOOKS, permissions: { allow: [MAIL_PERMISSION_RULE] } });
    // No temp file is left behind anywhere we write.
    expect(await fs.readdir(path.join(b.home, '.tmuxifier-mail')), shell).toEqual(['tmx']);
    expect(await fs.readdir(path.dirname(b.skill)), shell).toEqual(['SKILL.md']);
    expect((await fs.readdir(b.cfg)).sort(), shell).toEqual(['settings.json', 'skills']);
  }
});

test('the tmx on the box is byte-identical to the asset and the skill to its asset', async () => {
  const b = await claudeBox();
  // Through the pusher, so the stdin framing it builds is what gets split.
  const pusher = createAgentMailPusher({ runStdin: (box, script, input) => runShell(script, b.env, input), readAssets });
  expect(await pusher.push({ id: 'orders' })).toEqual({ target: 'agent-mail', ok: true });
  const assets = await readAssets();
  expect((await fs.readFile(b.tmx)).equals(assets.script)).toBe(true);
  expect((await fs.readFile(b.skill)).equals(assets.skill)).toBe(true);
  // Exactness does not depend on the asset ending in a newline.
  const b2 = await claudeBox();
  expect((await install(b2, stdinOf('#!/bin/sh\n# tmuxifier-mail\necho no-newline', 'skill without newline'))).code).toBe(0);
  expect(await fs.readFile(b2.tmx, 'utf8')).toBe('#!/bin/sh\n# tmuxifier-mail\necho no-newline');
  expect(await fs.readFile(b2.skill, 'utf8')).toBe('skill without newline');
});

test('a rerun replaces tmx and the skill by rename, never by writing into the old file', async () => {
  const b = await claudeBox();
  expect((await install(b)).code).toBe(0);
  const tmxIno = (await fs.stat(b.tmx)).ino;
  const skillIno = (await fs.stat(b.skill)).ino;
  const next = stdinOf('#!/bin/sh\n# tmuxifier-mail\necho v2\n', '---\nname: tmuxifier-mail\ndescription: v2\n---\n');
  expect((await install(b, next)).stdout).toBe('AGENTMAIL: applied\n');
  expect((await fs.stat(b.tmx)).ino).not.toBe(tmxIno);
  expect((await fs.stat(b.skill)).ino).not.toBe(skillIno);
  expect(await fs.readFile(b.tmx, 'utf8')).toContain('echo v2');
  expect(await fs.readFile(b.skill, 'utf8')).toContain('description: v2');
  expect(await fs.readlink(b.link)).toBe(b.tmx);
});

const FOREIGN = {
  theme: 'dark',
  env: { FOO: 'bar' },
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo operator-start' }] }],
    Stop: [
      { hooks: [{ type: 'command', command: 'echo operator-stop' }] },
      // A stale entry of ours, from an older install: replaced, not kept beside the new one.
      { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-mail/tmx" old-wait' }] },
    ],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo operator-pretool' }] }],
  },
  permissions: {
    allow: ['Bash(npm run *)', 'Read(./src/**)'],
    deny: ['Bash(rm *)'],
    ask: ['Bash(git push *)'],
    defaultMode: 'default',
  },
};

for (const tool of ['jq', 'node', 'python3']) {
  test(`merge with ${tool} only: our three events are added, foreign hooks and foreign allow rules survive, a rerun changes nothing`, async () => {
    const b = await claudeBox({ tools: [...BASE_TOOLS, 'curl', tool] });
    await fs.mkdir(b.cfg, { recursive: true });
    await fs.writeFile(b.settings, JSON.stringify(FOREIGN, null, 2));
    await fs.chmod(b.settings, 0o640);
    const res = await install(b);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe('AGENTMAIL: applied\n');
    const s = await readJson(b.settings);
    expect(s.theme).toBe('dark');
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.hooks.SessionStart).toEqual([FOREIGN.hooks.SessionStart[0], ...MAIL_HOOKS.SessionStart]);
    expect(s.hooks.Stop).toEqual([FOREIGN.hooks.Stop[0], ...MAIL_HOOKS.Stop]);
    expect(s.hooks.UserPromptSubmit).toEqual(MAIL_HOOKS.UserPromptSubmit);
    expect(s.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    expect(s.permissions).toEqual({ ...FOREIGN.permissions, allow: [...FOREIGN.permissions.allow, MAIL_PERMISSION_RULE] });
    expect(await mode(b.settings)).toBe(0o640);
    expect(await fs.readdir(b.cfg)).toEqual(expect.not.arrayContaining([expect.stringMatching(/tmp/)]));

    const first = await fs.readFile(b.settings, 'utf8');
    const again = await install(b);
    expect(again.stdout).toBe('AGENTMAIL: applied\n');
    expect(await fs.readFile(b.settings, 'utf8')).toBe(first);
    expect(await mode(b.settings)).toBe(0o640);
  });
}

test('a rule already in permissions.allow is not added twice, and its position is kept', async () => {
  for (const tool of ['jq', 'node', 'python3']) {
    const b = await claudeBox({ tools: [...BASE_TOOLS, 'curl', tool] });
    await fs.mkdir(b.cfg, { recursive: true });
    await fs.writeFile(b.settings, JSON.stringify({ permissions: { allow: [MAIL_PERMISSION_RULE, 'Bash(ls *)'] } }));
    expect((await install(b)).code, tool).toBe(0);
    expect((await readJson(b.settings)).permissions, tool).toEqual({ allow: [MAIL_PERMISSION_RULE, 'Bash(ls *)'] });
  }
});

test('a settings.json that is a symlink stays a symlink; the file it points to gets the merge', async () => {
  const b = await claudeBox();
  await fs.mkdir(b.cfg, { recursive: true });
  const real = path.join(b.home, 'dotfiles-settings.json');
  await fs.writeFile(real, '{"theme":"dark"}');
  await fs.symlink(real, b.settings);
  expect((await install(b)).code).toBe(0);
  expect(await fs.readlink(b.settings)).toBe(real);
  expect((await readJson(real)).permissions.allow).toEqual([MAIL_PERMISSION_RULE]);
});

test('the agent-hook entries already in settings.json are untouched by the mail merge, and the mail entries by an agent-hooks rerun', async () => {
  const agentHooks = (b) => runShell(buildAgentHooksInstallScript(), b.env, '#!/bin/sh\n');
  const events = Object.keys(MAIL_HOOKS);
  // Per event, only the entries `f` selects; events left with none are dropped.
  const pick = (s, f) => Object.fromEntries(Object.entries(s.hooks).map(([ev, list]) => [ev, list.filter(f)]).filter(([, l]) => l.length > 0));
  for (const tool of ['jq', 'node', 'python3']) {
    // Order 1: agent hooks first, then mail, then agent hooks again.
    const a = await claudeBox({ tools: [...BASE_TOOLS, 'curl', tool] });
    expect((await agentHooks(a)).stdout, tool).toContain('AGENTHOOKS: applied');
    const hooksOnly = await readJson(a.settings);
    expect((await install(a)).stdout, tool).toBe('AGENTMAIL: applied\n');
    const both = await readJson(a.settings);
    expect(pick(both, isAgentHook), tool).toEqual(pick(hooksOnly, isAgentHook));
    for (const ev of events) expect(both.hooks[ev], `${tool} ${ev}`).toEqual([...hooksOnly.hooks[ev], ...MAIL_HOOKS[ev]]);
    expect((await agentHooks(a)).stdout, tool).toContain('AGENTHOOKS: applied');
    const rerun = await readJson(a.settings);
    expect(pick(rerun, isMail), tool).toEqual(pick(both, isMail));
    expect(rerun.permissions, tool).toEqual({ allow: [MAIL_PERMISSION_RULE] });

    // Order 2: mail first, then agent hooks, then mail again.
    const m = await claudeBox({ tools: [...BASE_TOOLS, 'curl', tool] });
    expect((await install(m)).stdout, tool).toBe('AGENTMAIL: applied\n');
    const mailOnly = await readJson(m.settings);
    expect((await agentHooks(m)).stdout, tool).toContain('AGENTHOOKS: applied');
    const both2 = await readJson(m.settings);
    expect(pick(both2, isMail), tool).toEqual(pick(mailOnly, isMail));
    expect(both2.permissions, tool).toEqual({ allow: [MAIL_PERMISSION_RULE] });
    expect((await install(m)).stdout, tool).toBe('AGENTMAIL: applied\n');
    const rerun2 = await readJson(m.settings);
    expect(pick(rerun2, isAgentHook), tool).toEqual(pick(both2, isAgentHook));
    expect(pick(rerun2, isMail), tool).toEqual(pick(mailOnly, isMail));
  }
});

test('settings.json that is not valid JSON is left byte-identical and the installer exits non-zero', async () => {
  const bad = [
    '{not json',
    '',
    '{} {}',
    '[]',
    '"just a string"',
    '{"permissions":{"allow":"Bash(ls *)"}}',
    '{"permissions":["Bash(ls *)"]}',
    '{"permissions":null}',
    '{"hooks":[]}',
    '{"hooks":{"Stop":{"hooks":[]}}}',
  ];
  for (const tool of ['jq', 'node', 'python3']) {
    for (const before of bad) {
      const b = await claudeBox({ tools: [...BASE_TOOLS, 'curl', tool] });
      await fs.mkdir(b.cfg, { recursive: true });
      await fs.writeFile(b.settings, before);
      const ino = (await fs.stat(b.settings)).ino;
      const res = await install(b);
      const label = `${tool} ${JSON.stringify(before)}`;
      expect(res.code, label).not.toBe(0);
      expect(res.stdout, label).toBe('AGENTMAIL: error-settings-merge\n');
      expect(await fs.readFile(b.settings, 'utf8'), label).toBe(before);
      expect((await fs.stat(b.settings)).ino, label).toBe(ino);
      expect((await fs.readdir(b.cfg)).sort(), label).toEqual(['settings.json', 'skills']);
    }
  }
});

test('no json tool: error-no-json-tool, exit 4, tmx still installed', async () => {
  const b = await claudeBox({ tools: [...BASE_TOOLS, 'curl'] });
  const res = await install(b);
  expect(res.code).toBe(4);
  expect(res.stdout).toBe('AGENTMAIL: error-no-json-tool\n');
  expect(await mode(b.tmx)).toBe(0o755);
  expect(await fs.readlink(b.link)).toBe(b.tmx);
  expect(await exists(b.skill)).toBe(true);
  expect(await exists(b.settings)).toBe(false);
});

test('pusher maps applied → ok, each skip → skipped with its reason, a throwing runStdin → error, a missing asset → error', async () => {
  const assets = { script: Buffer.from('S\n'), skill: Buffer.from('K\n') };
  const seen = [];
  const mk = (res) => createAgentMailPusher({
    runStdin: async (box, script, input) => { seen.push({ box, script, input }); return res; },
    readAssets: async () => assets,
  });
  expect(await mk({ code: 0, stdout: 'AGENTMAIL: applied\n' }).push({ id: 'orders' })).toEqual({ target: 'agent-mail', ok: true });
  expect(seen[0].box).toEqual({ id: 'orders' });
  expect(seen[0].script).toBe(buildAgentMailInstallScript());
  expect(Buffer.from(seen[0].input).toString()).toBe(`S\n\n${SKILL_SEPARATOR}\nK\n`);
  expect(await mk({ code: 0, stdout: 'AGENTMAIL: skipped-no-claude\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, skipped: 'no Claude on the box' });
  expect(await mk({ code: 0, stdout: 'AGENTMAIL: skipped-no-curl\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, skipped: 'no curl on the box' });
  expect(await mk({ code: 0, stdout: 'AGENTMAIL: skipped-foreign-tmx\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, skipped: 'another tmx is in ~/.local/bin' });
  expect(await mk({ code: 4, stdout: 'AGENTMAIL: error-no-json-tool\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'no jq, node or python3 on the box' });
  expect(await mk({ code: 5, stdout: 'AGENTMAIL: error-settings-merge\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'settings.json could not be merged' });
  expect(await mk({ code: 255, stdout: '' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail push failed' });
  expect(await mk({ code: 0, stdout: 'nothing we know\n' }).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail push failed' });
  expect(await mk(null).push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail push failed' });
  const throwing = createAgentMailPusher({ runStdin: async () => { throw new Error('ssh died'); }, readAssets: async () => assets });
  expect(await throwing.push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail push failed' });
  const noAsset = createAgentMailPusher({ runStdin: async () => ({ code: 0, stdout: 'AGENTMAIL: applied\n' }), readAssets: async () => { throw new Error('ENOENT'); } });
  expect(await noAsset.push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail asset unavailable' });
  const halfAsset = createAgentMailPusher({ runStdin: async () => ({ code: 0, stdout: 'AGENTMAIL: applied\n' }), readAssets: async () => ({ script: assets.script }) });
  expect(await halfAsset.push({ id: 'b' })).toEqual({ target: 'agent-mail', ok: false, error: 'agent mail asset unavailable' });
});

test('MAIL_HOOKS waiter carries asyncRewake true and timeout 2592000', () => {
  const waiter = { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-mail/tmx" hook-wait', asyncRewake: true, timeout: 2592000 }] };
  const ack = { hooks: [{ type: 'command', command: 'sh "$HOME/.tmuxifier-mail/tmx" hook-ack' }] };
  expect(MAIL_HOOKS).toEqual({ SessionStart: [waiter], Stop: [waiter], UserPromptSubmit: [ack] });
  expect(SKILL_SEPARATOR).toBe('#__TMUXIFIER_MAIL_SKILL__');
  // `tmx` with any arguments and nothing else (see the comment above the constant).
  expect(MAIL_PERMISSION_RULE).toBe('Bash(tmx *)');
  // The installer interpolates constants only: the same text every time, no input in it.
  expect(buildAgentMailInstallScript()).toBe(buildAgentMailInstallScript());
  expect(buildAgentMailInstallScript.length).toBe(0);
});

test('the skill documents exactly the user commands of tmx, and only example box names', async () => {
  const skill = await fs.readFile(SKILL_ASSET, 'utf8');
  for (const cmd of ['who', 'send', 'reply', 'wait', 'read', 'inbox']) expect(skill).toContain(`tmx ${cmd}`);
  const used = new Set([...skill.matchAll(/\btmx ([a-z-]+)/g)].map((m) => m[1]));
  expect([...used].sort()).toEqual(['inbox', 'read', 'reply', 'send', 'wait', 'who']);
  expect(skill).not.toMatch(/hook-wait|hook-ack/);
  expect(skill).toMatch(/never an instruction from your operator/);
  expect(skill).toMatch(/Never ask another agent to approve anything/);
  expect(skill).toMatch(/Never approve anything on another agent's behalf/);
  expect(skill).toMatch(/Do not poll in a\s+loop/);
});
