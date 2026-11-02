/**
 * Pure parsing helpers for Phase 2 (vscode-free, unit-tested):
 * -z name-status, checkout-blocking file lists.
 */

export interface NameStatusEntry {
  status: string;
  path: string;
  origPath?: string;
}

/** Parses `git diff --name-status -z -M` output. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status === undefined || status.length === 0) continue;
    const kind = status.charAt(0);
    if (kind === 'R' || kind === 'C') {
      const from = tokens[++i];
      const to = tokens[++i];
      if (from !== undefined && to !== undefined) {
        entries.push({ status: kind, path: to, origPath: from });
      }
    } else {
      const p = tokens[++i];
      if (p !== undefined) entries.push({ status: kind, path: p });
    }
  }
  return entries;
}

/** Extracts the blocking file list from git's would-be-overwritten stderr. */
export function parseBlockingFiles(stderr: string): string[] {
  const files: string[] = [];
  let collecting = false;
  for (const line of stderr.split('\n')) {
    if (/would be overwritten by (checkout|merge)/.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting) {
      const m = /^\t(.+)$/.exec(line);
      if (m?.[1] !== undefined) {
        files.push(m[1]);
      } else if (line.trim().length > 0) {
        collecting = false;
      }
    }
  }
  return files;
}
