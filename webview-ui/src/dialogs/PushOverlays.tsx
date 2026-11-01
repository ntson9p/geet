/**
 * The two small dialogs the Push dialog opens over itself, as IntelliJ opens
 * them over its own: the Force Push warning, with `Don't warn about this
 * target`, and Define Remote. Drawn inside the Push dialog's panel, so the
 * checkbox a native message box could not hold stays, and cancelling leaves
 * the Push dialog as it was.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

interface OverlayProps {
  title: string;
  testId: string;
  children: ReactNode;
  onCancel: () => void;
  onAccept: () => void;
  acceptLabel: string;
  acceptDisabled?: boolean;
}

function Overlay({ title, testId, children, onCancel, onAccept, acceptLabel, acceptDisabled }: OverlayProps) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Neither key may reach the Push dialog, which would close or push.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (acceptDisabled !== true) onAccept();
    }
  };
  return (
    <div className="gt-push-overlay" onKeyDown={onKeyDown}>
      <div className="gt-push-overlay-box" role="alertdialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="gt-push-overlay-title">{title}</div>
        <div className="gt-push-overlay-body">{children}</div>
        <div className="gt-push-overlay-actions">
          <button
            type="button"
            className="gt-button gt-primary"
            data-testid={`${testId}-accept`}
            disabled={acceptDisabled}
            onClick={onAccept}
          >
            {acceptLabel}
          </button>
          <button type="button" className="gt-button" data-testid={`${testId}-cancel`} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ForcePushConfirmProps {
  message: string;
  /** Offer `Don't warn about this target` — when the warning names one target. */
  offerDontWarn: boolean;
  onConfirm: (dontWarn: boolean) => void;
  onCancel: () => void;
}

/** `ForcePushAction.confirmForcePush`. */
export function ForcePushConfirm({ message, offerDontWarn, onConfirm, onCancel }: ForcePushConfirmProps) {
  const [dontWarn, setDontWarn] = useState(false);
  const acceptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    acceptRef.current?.querySelector<HTMLButtonElement>('.gt-primary')?.focus();
  }, []);
  return (
    <div ref={acceptRef}>
      <Overlay
        title="Force Push"
        testId="push-force-confirm"
        acceptLabel="Force Push"
        onAccept={() => onConfirm(dontWarn)}
        onCancel={onCancel}
      >
        <div className="gt-push-overlay-message">
          <span className="codicon codicon-warning gt-push-overlay-icon" aria-hidden="true" />
          <span>{message}</span>
        </div>
        {offerDontWarn ? (
          <label className="gt-checkbox">
            <input
              type="checkbox"
              data-testid="push-force-dont-warn"
              checked={dontWarn}
              onChange={(e) => setDontWarn(e.currentTarget.checked)}
            />
            <span className="gt-checkbox-body">Don&apos;t warn about this target</span>
          </label>
        ) : null}
      </Overlay>
    </div>
  );
}

export interface DefineRemoteProps {
  /** ` for <repository>` when the dialog lists several. */
  repoLabel?: string | undefined;
  busy: boolean;
  /** The host's answer to the last OK: which field is wrong, and why. */
  problem?: { field: 'name' | 'url'; message: string } | undefined;
  onSubmit: (value: { name: string; url: string; fetch: boolean }) => void;
  onCancel: () => void;
}

/** IntelliJ's `GitDefineRemoteDialog`: Name (`origin`), URL, `Fetch remote`. */
export function DefineRemote({ repoLabel, busy, problem, onSubmit, onCancel }: DefineRemoteProps) {
  const [name, setName] = useState('origin');
  const [url, setUrl] = useState('');
  const [fetch, setFetch] = useState(true);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // The name is filled in already, so the URL is where typing starts.
  useEffect(() => {
    urlRef.current?.focus();
  }, []);
  useEffect(() => {
    if (problem?.field === 'name') nameRef.current?.focus();
    if (problem?.field === 'url') urlRef.current?.focus();
  }, [problem]);

  return (
    <Overlay
      title={`Define Remote${repoLabel !== undefined ? ` for ${repoLabel}` : ''}`}
      testId="push-define-remote"
      acceptLabel="OK"
      acceptDisabled={busy}
      onAccept={() => onSubmit({ name, url, fetch })}
      onCancel={onCancel}
    >
      <div className="gt-push-define-grid">
        <label htmlFor="gt-push-remote-name">Name:</label>
        <div>
          <input
            id="gt-push-remote-name"
            ref={nameRef}
            className="gt-input"
            data-testid="push-remote-name"
            disabled={busy}
            aria-invalid={problem?.field === 'name'}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          {problem?.field === 'name' ? (
            <div className="gt-push-field-problem" role="alert">
              {problem.message}
            </div>
          ) : null}
        </div>
        <label htmlFor="gt-push-remote-url">URL:</label>
        <div>
          <input
            id="gt-push-remote-url"
            ref={urlRef}
            className="gt-input"
            data-testid="push-remote-url"
            disabled={busy}
            aria-invalid={problem?.field === 'url'}
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
          {problem?.field === 'url' ? (
            <div className="gt-push-field-problem" role="alert" data-testid="push-remote-url-problem">
              {problem.message}
            </div>
          ) : null}
        </div>
      </div>
      <label className="gt-checkbox">
        <input
          type="checkbox"
          data-testid="push-remote-fetch"
          disabled={busy}
          checked={fetch}
          onChange={(e) => setFetch(e.currentTarget.checked)}
        />
        <span className="gt-checkbox-body">Fetch remote</span>
      </label>
      {busy ? <div className="gt-muted">Checking the URL…</div> : null}
    </Overlay>
  );
}
