/**
 * The dim "will run:" line every P13 dialog shows
 * (`gittree.dialogs.showCommandLine`). vscode-free so the webview imports it
 * directly and previews exactly the argv the host will execute.
 */

/** One `git …` line, quoting only what a copy-paste would otherwise break. */
export function formatGitCommand(args: readonly string[]): string {
  return `git ${args.map((a) => (/[\s"']/u.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
}

/** Several commands run in order, as the dialog would run them. */
export function formatGitCommands(commands: readonly (readonly string[])[]): string {
  return commands.map((c) => formatGitCommand(c)).join(' && ');
}
