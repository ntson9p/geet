/**
 * The line above a range tab's commits. IntelliJ gives each of its two logs an
 * explanation (`git.compare.branches.explanation.message`); this tab has one table
 * for both, so the line says what its ◀ and ▶ mean. It is also the way to IntelliJ's
 * Show Files Diff, which a commit's Changed Files pane cannot show.
 */
import type { LogRangeCountsDto } from '../../../src/shared/protocol';
import { shortRef, sideLabel } from './logTabsModel';

export interface CompareStripProps {
  range: { readonly a: string; readonly b: string };
  /** Not known yet, or a side no longer resolves. */
  counts: LogRangeCountsDto | undefined;
  onShowFilesDiff: () => void;
}

export function CompareStrip({ range, counts, onShowFilesDiff }: CompareStripProps) {
  return (
    <div className="gt-compare-strip" data-testid="compare-strip">
      <span>
        <span className="gt-side-badge gt-side-left">◀</span> {sideLabel(counts?.left)} <code>{shortRef(range.a)}</code>
      </span>
      <span>
        <span className="gt-side-badge gt-side-right">▶</span> {sideLabel(counts?.right)} <code>{shortRef(range.b)}</code>
      </span>
      <button
        type="button"
        className="gt-compare-files"
        title={`Every file that differs between ${shortRef(range.a)} and ${shortRef(range.b)}`}
        onClick={onShowFilesDiff}
      >
        Show Files Diff
      </button>
    </div>
  );
}
