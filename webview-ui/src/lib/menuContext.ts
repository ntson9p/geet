/**
 * POST-P14cf: what a right-click shows where a webview names no menu of its
 * own. VS Code merges every `data-vscode-context` from the element clicked up
 * to the root, the nearest one winning a key (`pre/index.html` in VS Code
 * 1.144), and leaves out its own Cut, Copy and Paste where the merged context
 * says `preventDefaultContextMenuItems`. A menu left with no items is not shown.
 */

/** No menu at all: a panel's chrome, where there is nothing to cut, copy or paste. */
export const NO_MENU = JSON.stringify({ preventDefaultContextMenuItems: true });

/** VS Code's Cut, Copy and Paste, back on a text field inside a panel that has none. */
export const TEXT_FIELD_MENU = JSON.stringify({ preventDefaultContextMenuItems: false });
