/**
 * The Push dialog's target editor — IntelliJ's `GitPushTargetPanel` in edit
 * mode: `remote : [branch]`, the branch typed into a field that suggests the
 * recent targets (`recently pushed`) and then every remote branch, and on the
 * right `Set upstream` while the typed target is not the upstream already.
 *
 * Enter applies, Escape cancels; both stay inside the field rather than
 * reaching the dialog, which would push or close. Clicking the remote opens
 * the remote list without leaving the edit.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { cleanUpBranchNameOnTyping } from '../../../src/core/git/refName';
import type { TargetVariant } from '../../../src/scm/dialogs/pushModel';
import { matchVariants } from './pushTree';

export interface PushTargetEditorProps {
  remote: string;
  text: string;
  variants: readonly TargetVariant[];
  showUpstream: boolean;
  upstream: boolean;
  /** Why Enter did not apply: the name is not a valid branch name. */
  problem?: string | undefined;
  onTextChange: (text: string) => void;
  onUpstreamChange: (on: boolean) => void;
  onRemoteClick: (e: ReactMouseEvent<HTMLElement>) => void;
  onApply: () => void;
  onCancel: () => void;
  /** Focus left the editor for somewhere else in the dialog. */
  onLeave: () => void;
}

export function PushTargetEditor({
  remote,
  text,
  variants,
  showUpstream,
  upstream,
  problem,
  onTextChange,
  onUpstreamChange,
  onRemoteClick,
  onApply,
  onCancel,
  onLeave,
}: PushTargetEditorProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => matchVariants(variants, text), [text, variants]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => setActive(0), [text]);

  const pick = (variant: TargetVariant | undefined): void => {
    if (variant) onTextChange(variant.name);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <span
      className="gt-push-editor"
      ref={hostRef}
      data-testid="push-target-editor"
      // A click in here is part of the edit, not a click on the tree row,
      // which would move the focus away and so apply the edit under it.
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="gt-push-link"
        data-testid="push-editor-remote"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemoteClick}
      >
        {remote}
      </button>
      <span className="gt-push-sep">{' : '}</span>
      <span className="gt-push-editor-field">
        <input
          ref={inputRef}
          className="gt-input"
          aria-label="Target branch"
          aria-autocomplete="list"
          aria-expanded={open && matches.length > 0}
          aria-invalid={problem !== undefined}
          data-testid="push-edit-branch"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            onTextChange(cleanUpBranchNameOnTyping(e.currentTarget.value));
            setOpen(true);
          }}
          onKeyDown={(e) => {
            const listed = open && matches.length > 0;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              if (!listed) {
                setOpen(true);
                return;
              }
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) => (i + step + matches.length) % matches.length);
              return;
            }
            if (e.key === ' ' && e.ctrlKey) {
              e.preventDefault();
              setOpen(true);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (listed) pick(matches[active]);
              else onApply();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (listed) setOpen(false);
              else onCancel();
              return;
            }
            if (e.key === 'Tab' && listed) setOpen(false);
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            // The window losing focus is not the user moving on.
            if (to === null || hostRef.current?.contains(to) === true) return;
            setOpen(false);
            onLeave();
          }}
        />
        {open && matches.length > 0 ? (
          <ul className="gt-push-completion" role="listbox" aria-label="Branches" data-testid="push-completion">
            {matches.map((v, i) => (
              <li
                key={v.name}
                role="option"
                aria-selected={i === active}
                className={`gt-push-completion-item${i === active ? ' gt-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(v)}
              >
                {v.recent ? (
                  <span className="codicon codicon-history" aria-hidden="true" />
                ) : (
                  <span className="gt-push-completion-icon" aria-hidden="true" />
                )}
                <span className="gt-push-completion-name">{v.name}</span>
                {v.recent ? <span className="gt-muted gt-push-completion-type">recently pushed</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {problem !== undefined ? (
          <span className="gt-push-editor-problem" role="alert" data-testid="push-edit-problem">
            {problem}
          </span>
        ) : null}
      </span>
      {showUpstream ? (
        <label className="gt-checkbox gt-push-upstream" onMouseDown={(e) => e.preventDefault()}>
          <input
            type="checkbox"
            data-testid="push-set-upstream"
            tabIndex={-1}
            checked={upstream}
            onChange={(e) => onUpstreamChange(e.currentTarget.checked)}
          />
          <span className="gt-checkbox-body">Set upstream</span>
        </label>
      ) : null}
    </span>
  );
}
