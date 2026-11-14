/**
 * Commit options gear popup (P11-T5) — the §2A layout: Git (Author, Sign-off),
 * Commit Checks (Reformat / Optimize imports / Cleanup + profile), Advanced
 * Commit Checks (Analyze + severity, TODO + pattern, "run after commit").
 *
 * Renders inside the commit webview (planned deviation: VS Code has no
 * anchored floating windows). Every change is applied immediately through
 * `commit/setOption`; a rejected write reverts and shows the host's reason —
 * which is how an invalid author surfaces.
 *
 * Deliberately omitted rows are *omitted*, not disabled (plan step 5):
 * `Update copyright`, `Check malicious dependencies`, `Run Configuration`,
 * `After Commit`, and `Rearrange code` (no cross-language rearrange
 * code-action kind exists to probe) — see docs/deviations.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMMIT_METHODS,
  isValidAuthor,
  type CommitOptionChangeDto,
  type CommitOptionsDto,
} from '../../../src/shared/protocol';
import { TEXT_FIELD_MENU } from '../lib/menuContext';
import type { RpcClient } from '../lib/rpc';
import { useDismiss } from '../lib/useDismiss';
import type { Placement } from './commitLayout';

/** The tallest it grows, as the stylesheet's own `max-height` caps it. */
const POPUP_MAX_PX = 480;

export interface OptionsPopupProps {
  rpc: RpcClient;
  repoRoot: string;
  /** POST-P14ca: where it opens, clear of the gear; the stylesheet's place without one. */
  placement?: Placement;
  onClose: () => void;
}

export function OptionsPopup({ rpc, repoRoot, placement, onClose }: OptionsPopupProps) {
  const [opts, setOpts] = useState<CommitOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorDraft, setAuthorDraft] = useState('');
  const [authorInvalid, setAuthorInvalid] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.request<CommitOptionsDto | undefined>(COMMIT_METHODS.options, { repoRoot }).then(
      (next) => {
        if (cancelled || !next) return;
        setOpts(next);
        setAuthorDraft(next.author);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoRoot, rpc]);

  // Once, when it opens, and only while the webview has focus. (Re-run whenever
  // `onClose` changed, which is every render of the window, it took the
  // keyboard from the Author field each time the window was redrawn.)
  useEffect(() => {
    if (document.hasFocus()) hostRef.current?.focus();
  }, []);

  // A click elsewhere in this webview or anywhere in VS Code, or the webview
  // losing focus, closes it as VS Code's own popups close (`useDismiss`).
  useDismiss([hostRef], onClose);

  /** Optimistic apply; a host rejection reverts and shows why. */
  const apply = useCallback(
    (option: CommitOptionChangeDto, next: CommitOptionsDto) => {
      const previous = opts;
      setOpts(next);
      setError(null);
      rpc.request(COMMIT_METHODS.setOption, { repoRoot, option }).then(
        () => {},
        (err: unknown) => {
          setOpts(previous);
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [opts, repoRoot, rpc],
  );

  const commitAuthor = useCallback(() => {
    if (!opts) return;
    const value = authorDraft.trim();
    if (value === opts.author) return;
    if (value.length > 0 && !isValidAuthor(value)) {
      setAuthorInvalid(true);
      return;
    }
    setAuthorInvalid(false);
    apply({ kind: 'author', value }, { ...opts, author: value });
  }, [apply, authorDraft, opts]);

  const check = (id: 'reformat' | 'optimizeImports' | 'cleanup' | 'analyze' | 'todo', label: string) => {
    if (!opts) return null;
    return (
      <label className="gt-checkbox gt-options-row">
        <input
          type="checkbox"
          data-testid={`opt-${id}`}
          checked={opts.checks[id]}
          onChange={(e) =>
            apply(
              { kind: 'check', id, value: e.currentTarget.checked },
              { ...opts, checks: { ...opts.checks, [id]: e.currentTarget.checked } },
            )
          }
        />
        <span className="gt-checkbox-body">{label}</span>
      </label>
    );
  };

  return (
    <div
      ref={hostRef}
      role="dialog"
      aria-label="Commit Options"
      tabIndex={-1}
      className="gt-options-popup"
      data-testid="commit-options-popup"
      style={
        placement === undefined
          ? undefined
          : placement.top !== undefined
            ? { top: placement.top, bottom: 'auto', maxHeight: Math.min(placement.maxHeight, POPUP_MAX_PX) }
            : { bottom: placement.bottom, maxHeight: Math.min(placement.maxHeight, POPUP_MAX_PX) }
      }
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {!opts ? (
        <div className="gt-commit-empty">Loading options…</div>
      ) : (
        <>
          <div className="gt-options-section">Git</div>
          <div className="gt-options-row gt-options-author">
            <label htmlFor="gt-author-input">Author:</label>
            <input
              id="gt-author-input"
              className={`gt-input${authorInvalid ? ' gt-invalid' : ''}`}
              data-testid="opt-author"
              // POST-P14cf: a text field keeps VS Code's Cut, Copy and Paste.
              data-vscode-context={TEXT_FIELD_MENU}
              list="gt-author-suggestions"
              placeholder="Name <email@example.com>"
              value={authorDraft}
              onChange={(e) => {
                setAuthorDraft(e.currentTarget.value);
                setAuthorInvalid(false);
              }}
              onBlur={commitAuthor}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitAuthor();
              }}
            />
            <datalist id="gt-author-suggestions">
              {opts.authorSuggestions.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            {opts.author.length > 0 || authorDraft.length > 0 ? (
              <button
                type="button"
                className="gt-toolbar-button"
                aria-label="Clear author override"
                data-testid="opt-author-clear"
                title="Clear author override"
                onClick={() => {
                  setAuthorDraft('');
                  setAuthorInvalid(false);
                  if (opts.author.length > 0) apply({ kind: 'author', value: '' }, { ...opts, author: '' });
                }}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {authorInvalid ? (
            <div className="gt-options-hint gt-options-error" data-testid="opt-author-error">
              Author must look like: Name &lt;email@example.com&gt;
            </div>
          ) : null}
          <label className="gt-checkbox gt-options-row">
            <input
              type="checkbox"
              data-testid="opt-signoff"
              checked={opts.signoff}
              onChange={(e) =>
                apply({ kind: 'signoff', value: e.currentTarget.checked }, { ...opts, signoff: e.currentTarget.checked })
              }
            />
            <span className="gt-checkbox-body">Sign-off commit</span>
          </label>

          <div className="gt-options-section">Commit Checks</div>
          {check('reformat', 'Reformat code')}
          {check('optimizeImports', 'Optimize imports')}
          {check('cleanup', 'Cleanup')}
          <div className="gt-options-row gt-options-indent">
            <label htmlFor="gt-cleanup-kind">Choose profile:</label>
            <input
              id="gt-cleanup-kind"
              className="gt-input"
              data-testid="opt-cleanup-kind"
              data-vscode-context={TEXT_FIELD_MENU}
              disabled={!opts.checks.cleanup}
              defaultValue={opts.cleanupKind}
              onBlur={(e) => {
                const value = e.currentTarget.value.trim() || 'source.fixAll';
                if (value !== opts.cleanupKind) {
                  apply({ kind: 'cleanupKind', value }, { ...opts, cleanupKind: value });
                }
              }}
            />
          </div>

          <div className="gt-options-section">Advanced Commit Checks</div>
          <div className="gt-options-row gt-options-split">
            {check('analyze', 'Analyze code')}
            <select
              className="gt-input gt-options-select"
              aria-label="Analyze severity"
              data-testid="opt-analyze-severity"
              disabled={!opts.checks.analyze}
              value={opts.analyzeSeverity}
              onChange={(e) => {
                const value = e.currentTarget.value === 'warning' ? 'warning' : 'error';
                apply({ kind: 'analyzeSeverity', value }, { ...opts, analyzeSeverity: value });
              }}
            >
              <option value="error">Error</option>
              <option value="warning">Warning</option>
            </select>
          </div>
          <div className="gt-options-row gt-options-split">
            {check('todo', 'Check TODO')}
            <input
              className="gt-input gt-options-select"
              aria-label="TODO pattern"
              data-testid="opt-todo-pattern"
              data-vscode-context={TEXT_FIELD_MENU}
              disabled={!opts.checks.todo}
              defaultValue={opts.todoPattern}
              onBlur={(e) => {
                const value = e.currentTarget.value.trim() || '\\b(TODO|FIXME)\\b';
                if (value !== opts.todoPattern) {
                  apply({ kind: 'todoPattern', value }, { ...opts, todoPattern: value });
                }
              }}
            />
          </div>
          <label className="gt-checkbox gt-options-row">
            <input
              type="checkbox"
              data-testid="opt-defer"
              checked={opts.deferAdvanced}
              onChange={(e) =>
                apply(
                  { kind: 'deferAdvanced', value: e.currentTarget.checked },
                  { ...opts, deferAdvanced: e.currentTarget.checked },
                )
              }
            />
            <span className="gt-checkbox-body">Run advanced checks after a commit is done</span>
          </label>
          <div className="gt-options-hint">Failed checks will not prevent a commit</div>

          {error !== null ? (
            <div className="gt-options-error" role="alert" data-testid="opt-error">
              {error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
