import { test, expect } from 'vitest';
import { setupStatusText, setupStatusTone, setupActions, setupBadge, formatSeedResults, formatStatuslineResult, blocksTerminal } from '../src/web/setupStatus.ts';

test('status text covers each state', () => {
  expect(setupStatusText({ status: 'running', phase: 'waiting-ssh' })).toMatch(/waiting/i);
  expect(setupStatusText({ status: 'running', phase: 'running' })).toMatch(/running/i);
  expect(setupStatusText({ status: 'done' })).toMatch(/complete|✓/i);
  expect(setupStatusText({ status: 'error', error: 'apt failed' })).toMatch(/apt failed/);
  expect(setupStatusText({ status: 'needs-interactive' })).toMatch(/sudo/i);
  expect(setupStatusText({ status: 'interrupted' })).toMatch(/interrupted/i);
});

// A box whose sshd only offers password auth cannot be set up by the BatchMode
// run, but the interactive finish can log in. Wording it "sudo" would send the
// user looking for the wrong credential.
test('needs-interactive names the credential it is waiting on', () => {
  expect(setupStatusText({ status: 'needs-interactive', needs: 'ssh' })).toMatch(/ssh password/i);
  expect(setupStatusText({ status: 'needs-interactive', needs: 'ssh' })).not.toMatch(/sudo/i);
  expect(setupStatusText({ status: 'needs-interactive', needs: 'sudo' })).toMatch(/sudo/i);
});

// Jobs persisted before `needs` existed could only ever have parked on sudo,
// so that is the right reading for a missing field.
test('needs-interactive without a recorded need reads as sudo', () => {
  expect(setupStatusText({ status: 'needs-interactive' })).toMatch(/sudo/i);
});

test('badge distinguishes the two interactive needs', () => {
  expect(setupBadge('needs-interactive', 'ssh')?.text).toMatch(/password/i);
  expect(setupBadge('needs-interactive', 'sudo')?.text).toMatch(/sudo/i);
  expect(setupBadge('needs-interactive', 'ssh')?.cls).toContain('warn');
});

// The tone is what colours the panel's status line. `needs-interactive` is a
// job waiting on the operator, not a failed one — DESIGN.md gives that state to
// Safety Orange, and painting it LED Red made an onboarding pause read as an
// error the user could only close.
test('needs-interactive is an attention tone, never an error tone', () => {
  expect(setupStatusTone('needs-interactive')).toBe('attention');
});

test('tone per state', () => {
  expect(setupStatusTone('running')).toBe('');
  expect(setupStatusTone('done')).toBe('success');
  expect(setupStatusTone('error')).toBe('error');
  expect(setupStatusTone('interrupted')).toBe('error');
  expect(setupStatusTone('superseded')).toBe('');
});

test('actions per state', () => {
  expect(setupActions('running')).toEqual(['close']);
  expect(setupActions('done')).toEqual(['close']);
  expect(setupActions('error')).toEqual(['retry', 'remove', 'close']);
  expect(setupActions('needs-interactive')).toEqual(['finish-interactive', 'remove', 'close']);
  expect(setupActions('interrupted')).toEqual(['retry', 'remove', 'close']);
});

test('badge is null for terminal-done and present otherwise', () => {
  expect(setupBadge('done')).toBeNull();
  expect(setupBadge('running')).not.toBeNull();
  expect(setupBadge('needs-interactive')?.cls).toContain('warn');
});

test('seed results render one segment per target', () => {
  expect(formatSeedResults([
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ])).toBe('claude ✓ · codex skipped (no codex auth on the Tmuxifier host)');
});

test('seed results render failures, including the whole-step marker', () => {
  expect(formatSeedResults([{ target: 'all', ok: false, error: 'seed failed' }])).toBe('all failed (seed failed)');
  expect(formatSeedResults([{ target: 'claude', ok: false }])).toBe('claude failed (failed)');
});

test('seed results are empty for jobs that never seeded', () => {
  expect(formatSeedResults([])).toBe('');
  expect(formatSeedResults(undefined)).toBe('');
  expect(formatSeedResults(null)).toBe('');
});

test('the seeding phase has its own status text', () => {
  expect(setupStatusText({ status: 'running', phase: 'seeding' })).toMatch(/seeding/i);
});

test('the statusline phase has its own status text', () => {
  expect(setupStatusText({ status: 'running', phase: 'statusline' })).toBe('Configuring statusline…');
});

test('running job in the agent-hooks phase reads as installing agent hooks', () => {
  expect(setupStatusText({ status: 'running', phase: 'agent-hooks', error: null, needs: null }))
    .toBe('Installing agent hooks…');
});

test('the agent-hooks result renders through the shared push formatter', () => {
  expect(formatStatuslineResult({ target: 'agent-hooks', ok: true })).toBe('agent-hooks ✓');
  expect(formatStatuslineResult({ target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' })).toBe('agent-hooks skipped (no Claude on the box)');
});

test('statusline result renders applied / skipped / failed / empty', () => {
  expect(formatStatuslineResult({ target: 'statusline', ok: true })).toBe('statusline ✓');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, skipped: 'no Claude on the box' })).toBe('statusline skipped (no Claude on the box)');
  expect(formatStatuslineResult({ target: 'statusline', ok: false, error: 'statusline push failed' })).toBe('statusline failed (statusline push failed)');
  expect(formatStatuslineResult(null)).toBe('');
  expect(formatStatuslineResult(undefined)).toBe('');
});

test('only a running setup job blocks the terminal', () => {
  expect(blocksTerminal('running')).toBe(true);
});

test('parked and finished jobs never block the terminal', () => {
  // needs-interactive can sit parked for days, and error/interrupted boxes are
  // exactly the ones you need a shell on to diagnose. Blocking any of these
  // would make a box unreachable rather than merely not-ready.
  expect(blocksTerminal('needs-interactive')).toBe(false);
  expect(blocksTerminal('done')).toBe(false);
  expect(blocksTerminal('error')).toBe(false);
  expect(blocksTerminal('interrupted')).toBe(false);
  expect(blocksTerminal('superseded')).toBe(false);
});

test('no job at all does not block', () => {
  expect(blocksTerminal(undefined)).toBe(false);
  expect(blocksTerminal(null)).toBe(false);
});

test('the saved-script phase names itself', () => {
  expect(setupStatusText({ status: 'running', phase: 'script' })).toMatch(/saved script/i);
});

// formatStatuslineResult is documented as target-generic; the saved-script phase
// is the first caller whose target is a free-form name rather than a fixed one.
test('formatStatuslineResult renders a saved-script result under the script own name', () => {
  expect(formatStatuslineResult({ target: 'bootstrap', ok: true })).toBe('bootstrap ✓');
  expect(formatStatuslineResult({ target: 'bootstrap', ok: false, error: 'exited 2' })).toBe('bootstrap failed (exited 2)');
  expect(formatStatuslineResult({ target: 'bootstrap', ok: false, skipped: 'saved script no longer exists' }))
    .toBe('bootstrap skipped (saved script no longer exists)');
  expect(formatStatuslineResult(null)).toBe('');
});
