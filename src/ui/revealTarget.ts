/**
 * POST-P14bq — *Reveal in File Explorer* (Windows), *Reveal in Finder* (macOS),
 * *Open Containing Folder* (Linux) on the Commit window's rows: which file or
 * folder a row stands for, and whether this window's files can be shown in the
 * OS file manager at all. Free of `vscode`, so it is unit-tested.
 *
 * The showing itself is VS Code's own `revealFileInOS`, the command behind the
 * same item in its Explorer and its Git view. It runs in VS Code's window
 * process, through Electron's `shell.showItemInFolder`: Windows' shell selects
 * the item in an Explorer window; macOS' NSWorkspace selects it in Finder; on
 * Linux the file-manager portal or `org.freedesktop.FileManager1` selects it,
 * and if neither answers, `xdg-open` opens its folder.
 */
import * as path from 'node:path';

/** The first VS Code whose `revealFileInOS` reaches a WSL window's files (microsoft/vscode#299492). */
export const WSL_REVEAL_SINCE = '1.113.0';

/** The window Geet runs in, as `vscode.env` and `vscode.version` describe it. */
export interface RevealHost {
  /** VS Code desktop rather than VS Code for the Web, which has no OS file manager to open. */
  readonly desktop: boolean;
  /** `vscode.env.remoteName`: undefined in a local window, `wsl`, `ssh-remote`, `dev-container`, … */
  readonly remoteName: string | undefined;
  /** `vscode.version`, `1.113.0` or `1.114.0-insider`. */
  readonly version: string;
}

/**
 * Whether the files of this window are on the computer whose file manager would
 * open. A remote window's are on another machine; `revealFileInOS` leaves a
 * remote file alone, as VS Code's Git view does by hiding the item in one. WSL's
 * are the exception since VS Code 1.113, which reaches them through
 * `\\wsl$\<distro>`.
 */
export function canRevealInOS(host: RevealHost): boolean {
  if (!host.desktop) return false;
  if (host.remoteName === undefined || host.remoteName === '') return true;
  return host.remoteName === 'wsl' && versionAtLeast(host.version, WSL_REVEAL_SINCE);
}

/** `major.minor.patch` compared as numbers; a suffix (`-insider`) is ignored, an unreadable version is too old. */
export function versionAtLeast(version: string, min: string): boolean {
  const parts = (v: string): number[] => (/^(\d+)\.(\d+)\.(\d+)/u.exec(v.trim()) ?? []).slice(1).map(Number);
  const have = parts(version);
  const need = parts(min);
  if (have.length !== 3 || need.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i]! > need[i]!;
  }
  return true;
}

/** What a row reveals: its file, or a folder row's folder. */
export interface RevealTarget {
  readonly repoRoot: string;
  /** Repository-relative, `/`-separated. */
  readonly relPath: string;
  readonly folder: boolean;
}

/** The Commit window's repository rows, by their `webviewSection`. */
const REPOSITORY_ROW = 'commitRepository';

/** A repository row's target: its repository's folder, `.` inside the repository. */
export const REPOSITORY_FOLDER = '.';

/**
 * The row a `webview/context` menu was opened on, or the keyboard's row
 * (`CommitRevealParamsDto`). A folder row also carries its first file in
 * `relPath`, where Open Changes starts; the folder is the row, so it wins.
 *
 * Only the row itself, never the rest of a selection: like Open File, revealing
 * means one place, the one pointed at, and a selection over twenty folders must
 * not open twenty windows. VS Code's Git view reveals the clicked file alone too.
 *
 * Refuses a path that would leave the repository, as `folderOf` does.
 */
export function revealTargetOf(args: readonly unknown[]): RevealTarget | undefined {
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) continue;
    const c = arg as { repoRoot?: unknown; relPath?: unknown; folder?: unknown; webviewSection?: unknown };
    if (typeof c.repoRoot !== 'string' || c.repoRoot.length === 0) continue;
    // POST-P14cb: a repository row shows the repository's own folder.
    if (c.webviewSection === REPOSITORY_ROW) return { repoRoot: c.repoRoot, relPath: REPOSITORY_FOLDER, folder: true };
    if (c.folder !== undefined) {
      // A folder row whose folder is unusable reveals nothing rather than its first file.
      const folder = typeof c.folder === 'string' ? insideRepo(c.folder) : undefined;
      if (folder !== undefined) return { repoRoot: c.repoRoot, relPath: folder, folder: true };
      continue;
    }
    const file = typeof c.relPath === 'string' ? insideRepo(c.relPath) : undefined;
    if (file !== undefined) return { repoRoot: c.repoRoot, relPath: file, folder: false };
  }
  return undefined;
}

/** A repository-relative path cleaned to `/` separators, or undefined when it is empty or would leave the repository. */
function insideRepo(raw: string): string | undefined {
  const clean = raw.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  if (clean.length === 0 || /^[A-Za-z]:/u.test(clean)) return undefined;
  return clean.split('/').includes('..') ? undefined : clean;
}

/** The target's path on disk, under `root`, the repository's own spelling of its root. */
export function revealPath(root: string, target: RevealTarget): string {
  return path.join(root, ...target.relPath.split('/'));
}
