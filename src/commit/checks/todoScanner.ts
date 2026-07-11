/**
 * Pure TODO scanner (unit-tested; vscode-free): added lines matching a
 * marker pattern.
 */
import { addedLineNumbers } from '../../core/patch/lineDiff';
import type { LineChange } from '../../core/patch/patchBuilder';

export interface TodoHit {
  /** 1-based line number in the modified text. */
  line: number;
  text: string;
}

export function scanAddedTodos(
  changes: readonly LineChange[],
  modifiedText: string,
  pattern: RegExp,
): TodoHit[] {
  const lines = modifiedText.split('\n');
  const hits: TodoHit[] = [];
  for (const lineNo of addedLineNumbers(changes)) {
    const text = lines[lineNo - 1];
    if (text !== undefined && pattern.test(text)) {
      hits.push({ line: lineNo, text: text.trim() });
    }
  }
  return hits;
}
