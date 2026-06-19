import { test, expect } from 'vitest';
import { parseSshConfig } from '../src/server/sshConfig.js';

const SAMPLE = `
# comment
Host *
  ForwardAgent yes

Host prod web1
  HostName 10.0.0.5
  User deploy
  Port 2222

Host jumpbox
  ProxyJump bastion
`;

test('parses concrete hosts, skips wildcard-only blocks', () => {
  const boxes = parseSshConfig(SAMPLE);
  const names = boxes.map((b) => b.host);
  expect(names).toEqual(['prod', 'jumpbox']);
});

test('captures host fields', () => {
  const [prod] = parseSshConfig(SAMPLE);
  expect(prod).toMatchObject({
    host: 'prod', label: 'prod', hostName: '10.0.0.5', user: 'deploy', port: 2222, source: 'ssh-config',
  });
});

test('captures proxyJump', () => {
  const jb = parseSshConfig(SAMPLE).find((b) => b.host === 'jumpbox');
  expect(jb.proxyJump).toBe('bastion');
});
