/**
 * The ref field shared by the P13-T3 dialogs (P13-T3): a `<select>` of the
 * repository's refs grouped local / remote / tag, plus a free-text box so a
 * raw sha or a `HEAD~2` expression is always reachable — IntelliJ's reset
 * dialog accepts both, and a picker that only offers branches would make
 * "reset to a commit" impossible.
 */
import type { DialogRefDto } from '../../../src/shared/protocol';

export interface RefPickerProps {
  id: string;
  label: string;
  refs: readonly DialogRefDto[];
  value: string;
  onChange: (value: string) => void;
  /** Adds the free-text revision box beside the picker. */
  allowExpression?: boolean;
  placeholder?: string;
}

const GROUPS: Array<{ kind: DialogRefDto['kind']; label: string }> = [
  { kind: 'local', label: 'Local branches' },
  { kind: 'remote', label: 'Remote branches' },
  { kind: 'tag', label: 'Tags' },
];

export function RefPicker({
  id,
  label,
  refs,
  value,
  onChange,
  allowExpression,
  placeholder,
}: RefPickerProps) {
  const known = refs.some((r) => r.name === value);
  return (
    <div className="gt-op-row">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="gt-input gt-ref-select"
        data-testid={id}
        value={known ? value : ''}
        onChange={(e) => {
          if (e.currentTarget.value.length > 0) onChange(e.currentTarget.value);
        }}
      >
        {known ? null : <option value="">(custom revision)</option>}
        {GROUPS.map((g) => {
          const inGroup = refs.filter((r) => r.kind === g.kind);
          if (inGroup.length === 0) return null;
          return (
            <optgroup key={g.kind} label={g.label}>
              {inGroup.map((r) => (
                <option key={`${r.kind}:${r.name}`} value={r.name}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {allowExpression === true ? (
        <input
          className="gt-input gt-ref-expression"
          data-testid={`${id}-expression`}
          aria-label="Revision"
          placeholder={placeholder ?? 'or a hash / HEAD~2'}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      ) : null}
    </div>
  );
}
