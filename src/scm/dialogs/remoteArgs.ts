/**
 * Manage Remotes argv (P13-T4), vscode-free so the matrix is unit-testable.
 * There was **no remote-management command at all** before this — adding,
 * editing, removing and pruning a remote meant leaving the editor.
 */

export interface RemoteEdit {
  readonly name: string;
  readonly fetchUrl: string;
  /** Empty means "same as fetch" — git's default when no pushurl is set. */
  readonly pushUrl: string;
}

/** git's own rule: no whitespace, no `/`, and not empty. */
const NAME_SHAPE = /^[^\s/\\]+$/u;

export function validateRemoteEdit(
  edit: RemoteEdit,
  existingNames: readonly string[],
  originalName?: string,
): string[] {
  const errors: string[] = [];
  const name = edit.name.trim();
  if (name.length === 0) errors.push('Enter a remote name.');
  else if (!NAME_SHAPE.test(name)) errors.push('A remote name cannot contain spaces or slashes.');
  else if (name !== originalName && existingNames.includes(name)) {
    errors.push(`A remote named “${name}” already exists.`);
  }
  if (edit.fetchUrl.trim().length === 0) errors.push('Enter a fetch URL.');
  return errors;
}

export function buildRemoteAddArgs(edit: RemoteEdit): string[] {
  return ['remote', 'add', edit.name.trim(), edit.fetchUrl.trim()];
}

export function buildRemoteRenameArgs(from: string, to: string): string[] {
  return ['remote', 'rename', from, to.trim()];
}

export function buildRemoteSetUrlArgs(name: string, url: string): string[] {
  return ['remote', 'set-url', name, url.trim()];
}

export function buildRemoteSetPushUrlArgs(name: string, url: string): string[] {
  return ['remote', 'set-url', '--push', name, url.trim()];
}

/** Clearing a push URL restores "same as fetch" — `--delete` needs the old value. */
export function buildRemoteDeletePushUrlArgs(name: string, oldPushUrl: string): string[] {
  return ['remote', 'set-url', '--push', '--delete', name, oldPushUrl];
}

export function buildRemoteRemoveArgs(name: string): string[] {
  return ['remote', 'remove', name];
}

export function buildRemotePruneArgs(name: string): string[] {
  return ['remote', 'prune', name];
}

/**
 * The commands an edit implies, in order. Separated from execution so the
 * dialog can show them and the tests can assert them without a repository.
 */
export function planRemoteEdit(before: RemoteEdit | undefined, after: RemoteEdit): string[][] {
  const out: string[][] = [];
  const name = after.name.trim();
  if (before === undefined) {
    out.push(buildRemoteAddArgs(after));
    if (after.pushUrl.trim().length > 0) out.push(buildRemoteSetPushUrlArgs(name, after.pushUrl));
    return out;
  }
  if (before.name !== name) out.push(buildRemoteRenameArgs(before.name, name));
  if (before.fetchUrl.trim() !== after.fetchUrl.trim()) {
    out.push(buildRemoteSetUrlArgs(name, after.fetchUrl));
  }
  const beforePush = before.pushUrl.trim();
  const afterPush = after.pushUrl.trim();
  if (beforePush !== afterPush) {
    if (afterPush.length > 0) out.push(buildRemoteSetPushUrlArgs(name, afterPush));
    else out.push(buildRemoteDeletePushUrlArgs(name, beforePush));
  }
  return out;
}
