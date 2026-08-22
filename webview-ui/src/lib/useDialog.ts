/**
 * useDialog (P11-T1): the webview half of `src/ui/dialogHost.ts`. Fetches the
 * dialog's params over `dialog/init` and returns the accept/cancel/help
 * callbacks the `Dialog` frame is wired to.
 *
 * `init` is idempotent host-side, so a rehydrate after the panel was hidden
 * re-sends it safely (master §8).
 */
import { useEffect, useMemo, useState } from 'react';
import { DIALOG_METHODS } from '../../../src/shared/protocol';
import { RpcClient } from './rpc';

export interface DialogInit<TParams> {
  readonly dialog: string;
  readonly params: TParams;
}

export interface DialogApi<TParams, TResult> {
  /** Undefined until `dialog/init` resolves. */
  readonly init: DialogInit<TParams> | undefined;
  readonly error: string | undefined;
  /** Function properties (not methods) so callers can destructure them. */
  readonly accept: (result: TResult) => void;
  readonly cancel: () => void;
  readonly help: () => void;
  readonly rpc: RpcClient;
}

export function useDialog<TParams, TResult>(client?: RpcClient): DialogApi<TParams, TResult> {
  const rpc = useMemo(() => client ?? new RpcClient(), [client]);
  const [init, setInit] = useState<DialogInit<TParams> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    rpc.request<DialogInit<TParams>>(DIALOG_METHODS.init).then(
      (value) => {
        if (live) setInit(value);
      },
      (e: Error) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  return useMemo(
    () => ({
      init,
      error,
      rpc,
      accept: (result: TResult) => rpc.sendEvent(DIALOG_METHODS.accept, result),
      cancel: () => rpc.sendEvent(DIALOG_METHODS.cancel),
      help: () => rpc.sendEvent(DIALOG_METHODS.help),
    }),
    [error, init, rpc],
  );
}
