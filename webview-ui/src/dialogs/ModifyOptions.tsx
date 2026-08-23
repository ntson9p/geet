/**
 * IntelliJ's "Modify options" pattern (P13-T3): a compact primary form plus a
 * dropdown of the real git flags. Ticking one reveals its control in the form
 * rather than burying it in a wall of checkboxes — which is the point: the
 * dialog stays small for the common case and complete for the rare one.
 *
 * Options that git itself refuses together are reported, not silently ignored:
 * `conflicts` renders the reasons under the list, and the caller disables its
 * action button. A greyed-out control with no explanation is its own bug.
 */
import { type ReactNode } from 'react';
import { ToolbarDropdown } from '../lib/ToolbarStrip';
import type { MenuItem } from '../lib/Menu';

export interface ModifyOption {
  readonly id: string;
  readonly label: string;
  /** The flag this option turns on, shown dim beside the label. */
  readonly flag?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
}

export interface ModifyOptionsProps {
  options: readonly ModifyOption[];
  onToggle: (id: string) => void;
  /** Rendered under the dropdown — the controls the ticked options revealed. */
  children?: ReactNode;
  conflicts?: readonly string[];
}

export function ModifyOptions({ options, onToggle, children, conflicts }: ModifyOptionsProps) {
  const items: MenuItem[] = options.map((o) => ({
    kind: 'item',
    id: o.id,
    label: o.flag !== undefined ? `${o.label}  (${o.flag})` : o.label,
    checked: o.checked,
    ...(o.disabled === true ? { disabled: true } : {}),
  }));
  const activeCount = options.filter((o) => o.checked).length;

  return (
    <div className="gt-modify-options">
      <div className="gt-modify-options-row">
        <ToolbarDropdown
          label={activeCount === 0 ? 'Modify options' : `Modify options (${activeCount})`}
          ariaLabel="Modify options"
          icon="settings-gear"
          items={items}
          onSelect={onToggle}
        />
      </div>
      {children !== undefined ? <div className="gt-modify-options-body">{children}</div> : null}
      {conflicts !== undefined && conflicts.length > 0 ? (
        <ul className="gt-modify-options-errors" data-testid="option-conflicts">
          {conflicts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The `[x] label (--flag)` row a revealed option renders as. */
export function OptionCheckbox({
  id,
  label,
  flag,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  flag?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={`gt-checkbox${disabled === true ? ' gt-disabled' : ''}`}>
      <input
        type="checkbox"
        data-testid={id}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="gt-checkbox-body">
        {label}
        {flag !== undefined ? <span className="gt-muted"> {flag}</span> : null}
      </span>
    </label>
  );
}

/** The dim "will run" line shared by every T3 dialog. */
export function WillRun({ show, text }: { show: boolean; text: string }) {
  if (!show) return null;
  return (
    <div className="gt-op-cmd" data-testid="will-run">
      <span className="gt-muted">will run:&nbsp;</span>
      <code>{text}</code>
    </div>
  );
}
