// CodeMirror 6 editor for the Fleet Command "edit as a bash script" modal.
// Replaces the plain <textarea> with shell syntax highlighting, line numbers,
// bracket matching and a token/recent-command autocompleter — while keeping the
// modal's contract (a getValue/onChange/onRun surface) so main.ts stays thin.
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
} from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import {
  autocompletion, completionKeymap, completeFromList, closeBrackets, closeBracketsKeymap,
  type Completion,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// Common shell keywords/builtins/snippets offered as keyword completions. These
// rank below recent fleet commands but above nothing — enough to feel IDE-ish
// without pretending to know the box's $PATH.
export const SHELL_BUILTINS: string[] = [
  'set -euo pipefail', 'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'do', 'done',
  'case', 'esac', 'function', 'return', 'break', 'continue', 'local', 'export', 'readonly',
  'echo', 'printf', 'read', 'cd', 'pwd', 'test', 'true', 'false', 'exit', 'trap', 'eval',
  'source', 'command', 'sudo', 'systemctl', 'journalctl', 'docker', 'apt-get', 'grep',
  'sed', 'awk', 'find', 'xargs', 'curl', 'tar', 'kill', 'ps', 'df', 'free', 'uptime',
];

// Pure: merge recent commands (first, deduped, blanks dropped) with the builtins.
// Recent entries are tagged so the UI shows "recent" and they rank ahead of the
// keyword block when CodeMirror's fuzzy matcher scores equally.
export function buildCompletions(recent: string[]): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const raw of recent) {
    const label = (raw || '').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, type: 'text', detail: 'recent', boost: 1 });
  }
  for (const label of SHELL_BUILTINS) {
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, type: 'keyword' });
  }
  return out;
}

// Dark highlight + chrome theme tuned to the app's palette (style.css :root vars).
const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: '#24d3e8' },
  { tag: [t.string, t.special(t.string)], color: '#58e58c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#7f8b9a', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: '#f0a868' },
  { tag: [t.variableName, t.propertyName], color: '#d8e1ea' },
  { tag: [t.definitionKeyword, t.function(t.variableName)], color: '#9fb4ff' },
  { tag: [t.operator, t.punctuation], color: '#9aa7b6' },
  { tag: t.atom, color: '#f0a868' },
]);

const THEME = EditorView.theme({
  '&': {
    color: 'var(--text)', backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: '8px',
    fontSize: '13px', maxHeight: '60vh',
  },
  '&.cm-focused': {
    outline: 'none', borderColor: 'rgba(36, 211, 232, 0.45)',
    boxShadow: '0 0 0 2px rgba(36, 211, 232, 0.12)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.5', minHeight: '220px',
  },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--cyan)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cyan)' },
  '.cm-gutters': {
    backgroundColor: 'transparent', color: '#4a5568', border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(36, 211, 232, 0.05)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(36, 211, 232, 0.18)', color: 'inherit',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(36, 211, 232, 0.22)',
  },
  '.cm-placeholder': { color: '#4a5568' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--panel)', border: '1px solid var(--border)',
    borderRadius: '8px', overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'rgba(36, 211, 232, 0.16)', color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal' },
}, { dark: true });

export interface FleetScriptEditor {
  readonly dom: HTMLElement;
  getValue(): string;
  focus(): void;
  destroy(): void;
}

export interface FleetScriptEditorOptions {
  initial: string;
  recent: string[];
  placeholder?: string;
  onChange?: (value: string) => void;
  onRun?: () => void;     // ⌘/Ctrl+Enter while the editor is focused
  onEscape?: () => void;  // Escape with no completion popup open
}

export function createFleetScriptEditor(opts: FleetScriptEditorOptions): FleetScriptEditor {
  const completions = buildCompletions(opts.recent);

  const runKeymap = keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onRun?.(); return true; } },
    // Only reached when the completion popup is closed — completionKeymap (higher
    // precedence below) consumes Escape first while it is open.
    { key: 'Escape', run: () => { opts.onEscape?.(); return true; } },
  ]);

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    StreamLanguage.define(shell),
    syntaxHighlighting(HIGHLIGHT),
    autocompletion({ override: [completeFromList(completions)], icons: false }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    THEME,
    // completionKeymap before runKeymap so Escape closes an open popup first.
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    runKeymap,
  ];

  if (opts.placeholder) extensions.push(cmPlaceholder(opts.placeholder));
  if (opts.onChange) {
    extensions.push(EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange!(u.state.doc.toString());
    }));
  }

  const view = new EditorView({
    state: EditorState.create({ doc: opts.initial || '', extensions }),
  });

  return {
    dom: view.dom,
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
