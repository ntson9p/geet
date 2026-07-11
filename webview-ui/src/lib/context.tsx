/**
 * Native context-menu bridge (master §9): elements carry a
 * data-vscode-context JSON attribute; menu items come from package.json
 * `menus.webview/context` contributions. Custom HTML menus are forbidden.
 */
import type { HTMLAttributes, ReactNode } from 'react';

export interface VsCodeContextProps extends HTMLAttributes<HTMLDivElement> {
  /** Serialized into data-vscode-context. */
  context: Record<string, unknown>;
  /** Suppress VS Code's default webview items (Copy, Reload, …). */
  preventDefaults?: boolean;
  children?: ReactNode;
}

export function VsCodeContext({ context, preventDefaults, children, ...rest }: VsCodeContextProps) {
  const value = preventDefaults ? { ...context, preventDefaultContextMenuItems: true } : context;
  return (
    <div data-vscode-context={JSON.stringify(value)} {...rest}>
      {children}
    </div>
  );
}
