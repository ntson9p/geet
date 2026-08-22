/**
 * TriCheckbox (P11-T1): the affordance `TreeItemCheckboxState` cannot render —
 * checked / unchecked / **partial** (gap analysis S11).
 *
 * Two exports on purpose:
 *   - `TriCheckbox` is presentational and `aria-hidden`. Inside a tree the row
 *     itself is the `treeitem` and carries `aria-checked`, so a second
 *     focusable control would give screen readers two things to announce and
 *     break the one-tab-stop tree pattern.
 *   - `Checkbox` is a real labelled control for forms (dialogs, the commit
 *     options gear).
 *
 * High-contrast note: the state must never be carried by fill alone — each
 * state also draws a distinct glyph, so `forced-colors` users can tell them
 * apart (P10-T2).
 */
import type { CheckState } from './treeModel';

export interface TriCheckboxProps {
  state: CheckState;
  /** Dims the box; the owning row still handles focus. */
  disabled?: boolean;
}

export function TriCheckbox({ state, disabled }: TriCheckboxProps) {
  return (
    <span
      className={`gt-tricheck gt-tricheck-${state}${disabled === true ? ' gt-disabled' : ''}`}
      aria-hidden="true"
      data-state={state}
    >
      {state === 'checked' ? <span className="codicon codicon-check" /> : null}
      {state === 'partial' ? <span className="gt-tricheck-dash" /> : null}
    </span>
  );
}

export interface CheckboxProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  /** Dim helper line under the label, e.g. "Failed checks will not prevent a commit". */
  caption?: string;
  onChange: (next: boolean) => void;
}

/** A real, focusable, labelled checkbox — for dialogs and option popups. */
export function Checkbox({ checked, label, disabled, caption, onChange }: CheckboxProps) {
  return (
    <label className={`gt-checkbox${disabled === true ? ' gt-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="gt-checkbox-body">
        <span className="gt-checkbox-label">{label}</span>
        {caption !== undefined && caption !== '' ? (
          <span className="gt-checkbox-caption">{caption}</span>
        ) : null}
      </span>
    </label>
  );
}
