import { test, expect } from 'vitest';
import { stripAnsi, previewText } from '../src/web/ansiStrip.ts';

test('SGR, cursor moves, OSC titles and OSC 8 links are removed', () => {
  expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b[2K\x1b]0;title\x07ok \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('red ok link');
});

test('stray controls are dropped but newlines and tabs survive', () => {
  expect(stripAnsi('a\x00b\x07c\rd\te\nf\x7f\x9b')).toBe('abcd\te\nf');
});

test('an unterminated escape at the end leaves no ESC byte', () => {
  expect(stripAnsi('x\x1b[')).not.toContain('\x1b');
  expect(stripAnsi('x\x1b]0;title')).not.toContain('\x1b');
});

test('matches the MCP stripper on a captured pane', async () => {
  const { stripSgr } = await import('../src/mcp/shape.js');
  const sample = '\x1b[38;5;208m● \x1b[0mWorking\x1b[K\n\x1b[2m  esc to interrupt\x1b[0m   \n\n\n';
  expect(previewText(sample, 40)).toBe(stripSgr(sample));
});

test('trailing blank rows are trimmed so an inline agent does not preview as empty space', () => {
  expect(previewText('a\nb\n\n   \n\n')).toBe('a\nb');
});

test('only the last maxLines rows are kept, counted after the trim', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `r${i + 1}`);
  const out = previewText(rows.join('\n') + '\n'.repeat(10), 40).split('\n');
  expect(out).toHaveLength(40);
  expect(out[0]).toBe('r11');
  expect(out[39]).toBe('r50');
});

test('empty and all-blank content is the empty string', () => {
  expect(previewText('')).toBe('');
  expect(previewText('  \n\t\n\n')).toBe('');
});

test('markup survives as text', () => {
  expect(previewText('<b>x</b>')).toBe('<b>x</b>');
});
