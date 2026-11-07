/**
 * InlineDiff (P11-T1): a **scoped** read-only side-by-side diff with a per-change
 * include checkbox and the `N differences, M included` counter — IntelliJ's
 * commit gesture (gap analysis S11/S14).
 *
 * This is deliberately NOT a general Differences Viewer. Every ordinary diff
 * still opens VS Code's diff editor; see docs/deviations.md D1, which also
 * records what building the real thing would take. InlineDiff exists only
 * where per-change inclusion is functionally required: the commit window and
 * the Shelve/Rollback dialogs.
 */
import { useMemo } from 'react';
import type { LineChangeDto } from '../../../src/shared/protocol';
import { buildDiffRows, includedLabel, unifiedRows, type DiffRow, type UnifiedRow } from './diffRows';
import { TriCheckbox } from './TriCheckbox';
import { VirtualList } from './VirtualList';

export interface InlineDiffProps {
  originalText: string;
  modifiedText: string;
  changes: readonly LineChangeDto[];
  leftLabel: string;
  rightLabel: string;
  height: number;
  /** Change indices currently included. Omit to render without checkboxes. */
  included?: ReadonlySet<number>;
  onToggleInclude?: (changeIndex: number, next: boolean) => void;
  rowHeight?: number;
  /**
   * `unified`: one column, a change's removed lines above its added ones —
   * for a pane too narrow for two sides (the Commit window in the sidebar).
   */
  layout?: 'split' | 'unified';
}

const DEFAULT_ROW_HEIGHT = 18;

function unifiedClass(row: UnifiedRow): string {
  if (row.kind === 'context') return 'gt-diff-context';
  return row.kind === 'removed' ? 'gt-diff-u-removed' : 'gt-diff-u-added';
}

function sideClass(row: DiffRow): string {
  if (row.changeIndex < 0) return 'gt-diff-context';
  if (row.left === undefined) return 'gt-diff-added';
  if (row.right === undefined) return 'gt-diff-removed';
  return 'gt-diff-modified';
}

export function InlineDiff({
  originalText,
  modifiedText,
  changes,
  leftLabel,
  rightLabel,
  height,
  included,
  onToggleInclude,
  rowHeight = DEFAULT_ROW_HEIGHT,
  layout = 'split',
}: InlineDiffProps) {
  const rows = useMemo(
    () => buildDiffRows(originalText, modifiedText, changes),
    [originalText, modifiedText, changes],
  );
  const unified = useMemo(() => (layout === 'unified' ? unifiedRows(rows) : undefined), [layout, rows]);
  const counter = includedLabel(changes.length, included?.size ?? 0, included !== undefined);
  const headerHeight = 22;
  const listHeight = Math.max(rowHeight, height - headerHeight);

  return (
    <div className="gt-diff" style={{ height }}>
      <div className="gt-diff-header">
        <span className="gt-diff-side-label">
          <span className="codicon codicon-lock-small" aria-hidden="true" /> {leftLabel}
        </span>
        <span className="gt-diff-side-label">{rightLabel}</span>
        <span className="gt-diff-counter" data-testid="diff-counter">
          {counter}
        </span>
      </div>
      {unified !== undefined ? (
        <VirtualList
          rowCount={unified.length}
          rowHeight={rowHeight}
          height={listHeight}
          ariaLabel={`Diff of ${rightLabel}, ${counter}`}
          className="gt-diff-rows"
          rowAriaLabel={(i) => {
            const row = unified[i];
            if (!row) return undefined;
            if (row.changeIndex < 0) return `Unchanged line ${row.newLine ?? ''}`;
            const state = included?.has(row.changeIndex) === true ? 'included' : 'not included';
            const what = row.kind === 'removed' ? 'removed' : 'added';
            return `Change ${row.changeIndex + 1}, ${what}${included !== undefined ? `, ${state}` : ''}`;
          }}
          renderRow={(i) => {
            const row = unified[i];
            if (!row) return null;
            const showCheck = included !== undefined && row.first && row.changeIndex >= 0;
            return (
              <span className={`gt-diff-row gt-diff-unified ${unifiedClass(row)}`}>
                <span
                  className="gt-diff-gutter"
                  onClick={
                    showCheck
                      ? (e) => {
                          e.stopPropagation();
                          onToggleInclude?.(row.changeIndex, included?.has(row.changeIndex) !== true);
                        }
                      : undefined
                  }
                  data-testid={showCheck ? `diff-include-${row.changeIndex}` : undefined}
                >
                  {showCheck ? (
                    <TriCheckbox
                      state={included?.has(row.changeIndex) === true ? 'checked' : 'unchecked'}
                    />
                  ) : null}
                </span>
                <span className="gt-diff-num">{row.oldLine ?? ''}</span>
                <span className="gt-diff-num">{row.newLine ?? ''}</span>
                <span className="gt-diff-text">{row.text}</span>
              </span>
            );
          }}
        />
      ) : (
      <VirtualList
        rowCount={rows.length}
        rowHeight={rowHeight}
        height={listHeight}
        ariaLabel={`Diff of ${rightLabel}, ${counter}`}
        className="gt-diff-rows"
        rowAriaLabel={(i) => {
          const row = rows[i];
          if (!row) return undefined;
          if (row.changeIndex < 0) return `Unchanged line ${row.left?.lineNumber ?? ''}`;
          const state = included?.has(row.changeIndex) === true ? 'included' : 'not included';
          return `Change ${row.changeIndex + 1}${included !== undefined ? `, ${state}` : ''}`;
        }}
        renderRow={(i) => {
          const row = rows[i];
          if (!row) return null;
          const showCheck =
            included !== undefined && row.first && row.changeIndex >= 0;
          return (
            <span className={`gt-diff-row ${sideClass(row)}`}>
              <span className="gt-diff-num">{row.left?.lineNumber ?? ''}</span>
              <span className="gt-diff-text">{row.left?.text ?? ''}</span>
              <span
                className="gt-diff-gutter"
                onClick={
                  showCheck
                    ? (e) => {
                        e.stopPropagation();
                        onToggleInclude?.(row.changeIndex, included?.has(row.changeIndex) !== true);
                      }
                    : undefined
                }
                data-testid={showCheck ? `diff-include-${row.changeIndex}` : undefined}
              >
                {showCheck ? (
                  <TriCheckbox
                    state={included?.has(row.changeIndex) === true ? 'checked' : 'unchecked'}
                  />
                ) : null}
              </span>
              <span className="gt-diff-num">{row.right?.lineNumber ?? ''}</span>
              <span className="gt-diff-text">{row.right?.text ?? ''}</span>
            </span>
          );
        }}
      />
      )}
    </div>
  );
}
