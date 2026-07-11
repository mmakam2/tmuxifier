import { test, expect } from 'vitest';
import { actionsForState } from '../src/web/proxmoxContainers.ts';

test('container actions are state-gated', () => {
  expect(actionsForState('running')).toEqual(['shutdown', 'stop', 'reboot', 'deprovision']);
  expect(actionsForState('stopped')).toEqual(['start', 'deprovision']);
  expect(actionsForState('missing')).toEqual(['deprovision']);
  expect(actionsForState('unknown')).toEqual([]);
});
