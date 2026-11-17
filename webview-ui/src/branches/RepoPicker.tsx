/**
 * The Branches panel's `@` list (POST-P14co): the repositories under the
 * filter, a square checkbox each, as `repoPickerModel.ts` works them out. The filter
 * keeps the keyboard (it is the combobox; this is its listbox): ↑ and ↓ move
 * the highlighted row, Enter ticks it and closes the list, Escape closes it. A
 * click ticks a row and leaves the list open for the next, and never takes the
 * keyboard from the filter.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';
import { TriCheckbox } from '../lib/TriCheckbox';
import type { PickerRow } from './repoPickerModel';
import { headText, Name } from './Rows';

export const REPO_PICKER_ID = 'gtp-repo-picker';

/** The id of a row of the list: what the filter's `aria-activedescendant` names. */
export function pickerRowId(index: number): string {
  return `${REPO_PICKER_ID}-${index}`;
}

export function RepoPicker({
  rows,
  active,
  query,
  colorOf,
  onPick,
  onActive,
}: {
  rows: readonly PickerRow[];
  /** The highlighted row: what Enter ticks. */
  active: number;
  /** What was typed after the `@`. */
  query: string;
  colorOf: (repo: BranchPanelRepoDto) => string;
  onPick: (row: PickerRow) => void;
  onActive: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // The highlighted row stays in sight as the arrows move it.
  useEffect(() => {
    listRef.current?.querySelector(`#${CSS.escape(pickerRowId(active))}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div className="gtp-picker" data-testid="repo-picker">
      <div
        ref={listRef}
        className="gtp-picker-list"
        id={REPO_PICKER_ID}
        role="listbox"
        aria-label="Repositories"
        aria-multiselectable="true"
      >
        {rows.map((row, index) => (
          <div
            key={row.id}
            id={pickerRowId(index)}
            role="option"
            aria-selected={row.ticked}
            data-picker-row={row.kind === 'repo' ? row.repo.label : 'all'}
            className={`gtp-picker-row${index === active ? ' gtp-picker-active' : ''}`}
            // Down, not click: the filter keeps the keyboard, so the list stays open.
            onMouseDown={(e) => {
              e.preventDefault();
              onActive(index);
              onPick(row);
            }}
            onMouseMove={() => {
              if (index !== active) onActive(index);
            }}
          >
            <TriCheckbox state={row.ticked ? 'checked' : 'unchecked'} />
            {row.kind === 'all' ? (
              <span className="gtp-picker-name">All repositories</span>
            ) : (
              <>
                <span
                  className="gtp-dot gtp-dot-on"
                  style={{ '--gtp-repo': colorOf(row.repo) } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="gtp-picker-name">
                  <Name prefix="" label={row.repo.label} highlights={row.highlights} />
                </span>
                <span className="gtp-picker-head">{headText(row.repo)}</span>
              </>
            )}
          </div>
        ))}
      </div>
      {rows.length === 0 ? <div className="gtp-picker-empty">No repository matches “{query.trim()}”.</div> : null}
      <div className="gtp-picker-foot">Enter ticks and closes · Esc closes</div>
    </div>
  );
}
