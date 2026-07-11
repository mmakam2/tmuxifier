import { test, expect } from 'vitest';
import { mergeActivity } from '../src/web/proxmoxActivity.ts';

test('mergeActivity tags, sorts, and labels both job sources', () => {
  const result = mergeActivity(
    [{ id: 'P1', hostname: 'dev-01', presetName: 'base', vmid: 131, status: 'done', createdAt: '2026-07-11T00:00:00Z' }],
    [{ id: 'L1', action: 'reboot', boxLabel: 'db-01', vmid: 140, status: 'error', createdAt: '2026-07-11T01:00:00Z' }],
  );
  expect(result.map((item) => [item.kind, item.id, item.title])).toEqual([
    ['lifecycle', 'L1', 'Reboot | db-01'],
    ['provision', 'P1', 'Provision | dev-01'],
  ]);
});
