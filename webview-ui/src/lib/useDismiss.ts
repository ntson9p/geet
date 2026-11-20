/**
 * When a Geet popup closes because the user went elsewhere: a menu
 * (`Menu.tsx`), the Commit window's options popup, a Log filter panel. They
 * close as VS Code's own context menus do, on a mousedown outside them or on
 * their window's `blur` (VS Code's `contextMenuHandler.ts`).
 *
 * A popup is drawn inside its webview's iframe. A click anywhere else in VS
 * Code (the editor, a tab, the status bar, a toolbar, another view or webview)
 * goes to VS Code's own document or to another iframe, never to this one, so a
 * mousedown listener here never hears it. Popups stayed open after such a click.
 *
 * What this webview does see is its window losing focus. In VS Code 1.144 every
 * such click took it, including on a toolbar button, whose mousedown VS Code
 * keeps from moving focus within its own document. Switching to another
 * application takes it too. The webview's own native pickers keep its focus:
 * a `<select>`'s list and a date picker were seen to, so they do not close the
 * popup that holds them.
 */
import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes a popup on a mousedown outside every element in `inside` (the popup,
 * and anything drawn beside it that belongs to it, such as a submenu), or when
 * its webview loses focus. Also closes it at once if it opened after the webview
 * had already lost focus: a click elsewhere while its items were on their way.
 */
export function useDismiss(
  inside: readonly RefObject<Element | null>[],
  onDismiss: () => void,
  enabled = true,
): void {
  // Read through refs: callers pass a fresh arrow each render, and resubscribing
  // on every render would re-run the check for focus at open as well.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const within = useRef(inside);
  within.current = inside;

  useEffect(() => {
    if (!enabled) return undefined;
    const close = (): void => dismiss.current();
    const onDown = (e: MouseEvent): void => {
      const target = e.target;
      if (target instanceof Node && within.current.some((ref) => ref.current?.contains(target) === true)) return;
      close();
    };
    // `capture`, so a click on a row underneath cannot act before the popup goes.
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    if (!document.hasFocus()) close();
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
    };
  }, [enabled]);
}
