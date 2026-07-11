/**
 * Theme observer (master §9): VS Code stamps the body with vscode-light /
 * vscode-dark / vscode-high-contrast(-light) classes and updates them live.
 * Styling itself must use --vscode-* variables; this hook exists for the rare
 * logic fork (e.g. canvas render colors in the log graph).
 */
import { useSyncExternalStore } from 'react';

export type VsCodeTheme = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

function readTheme(): VsCodeTheme {
  const cls = document.body.classList;
  if (cls.contains('vscode-high-contrast-light')) return 'high-contrast-light';
  if (cls.contains('vscode-high-contrast')) return 'high-contrast';
  if (cls.contains('vscode-light')) return 'light';
  return 'dark';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export function useVsCodeTheme(): VsCodeTheme {
  return useSyncExternalStore(subscribe, readTheme);
}
