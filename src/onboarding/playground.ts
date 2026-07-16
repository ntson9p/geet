/**
 * Playground repository generator (P10-T3): `gittree.generatePlayground`
 * seeds a disposable LOCAL repo shaped for the walkthrough — a pending edit
 * for the first commit, a branch whose rebase conflicts for the 3-pane merge
 * editor, and enough history to make the log and blame interesting. No
 * remotes are configured and nothing leaves the machine.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core } from '../core/core';

const DIR_NAME = 'gittree-playground';

const README = `# GitTree Playground

A disposable repository for learning GitTree. Nothing here touches your real
projects — delete this folder when you're done.

## Try it

1. **Your first commit** — \`NOTES.md\` has a pending edit. Open the Source
   Control view (\`Ctrl+Shift+G\`), click the file to review the diff, write a
   message and commit.
2. **Resolve a conflict** — in the Branches view, right-click
   \`feature/polish\` → **Checkout and Rebase onto Current**. \`src/greeting.js\`
   conflicts: open it from the SCM view and resolve in the 3-pane merge
   editor — \`F7\` jumps between conflicts, \`Alt+Enter\` accepts the side at the
   cursor, the magic wand auto-resolves the simple ones.
3. **Explore the log** — \`Ctrl+Alt+G F\` focuses the log filter. Try the
   Branch/User/Date/Path chips and the IntelliSort order.
4. **Blame** — open \`src/greeting.js\` and press \`Ctrl+Alt+G B\`.
5. **Local History** — edit a file, save a few times, then check the file's
   Timeline view: every save and git operation is restorable.
`;

const GREETING_V1 = `function greeting(name) {
  return 'Hello, ' + name + '!';
}

module.exports = { greeting };
`;

const GREETING_V2 = `function greeting(name) {
  return 'Hello, ' + name + '!';
}

function farewell(name) {
  return 'Bye, ' + name + '.';
}

module.exports = { greeting, farewell };
`;

/** main's edit — overlaps the same line feature/polish rewrites. */
const GREETING_MAIN = GREETING_V2.replace("'Hello, ' + name + '!'", '`Hello, ${name}!`');

/** feature/polish's edit — conflicts with GREETING_MAIN on rebase. */
const GREETING_POLISH = GREETING_V2.replace(
  "return 'Hello, ' + name + '!';",
  "const salutation = 'Hello';\n  return salutation + ', ' + name + '!';",
);

const NOTES_V1 = `# Notes

- Playground created by GitTree.
`;

const NOTES_PENDING = `${NOTES_V1}- TODO: commit me — I am your first commit.
`;

async function isUsableTarget(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch {
    return true; // does not exist yet
  }
}

/** Creates the playground repo and returns its path (undefined = cancelled). */
export async function generatePlayground(core: Core): Promise<string | undefined> {
  const seeded = process.env['GITTREE_TEST_PLAYGROUND_DIR'];
  let target: string;
  if (seeded !== undefined && seeded.length > 0) {
    target = seeded;
  } else {
    const parent = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: vscode.l10n.t('Choose where to create the GitTree playground'),
      openLabel: vscode.l10n.t('Create Playground Here'),
    });
    if (!parent || parent.length === 0) return undefined;
    target = path.join(parent[0]!.fsPath, DIR_NAME);
  }

  if (!(await isUsableTarget(target))) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Playground folder is not empty: {0}', target),
    );
    return undefined;
  }
  await fs.mkdir(target, { recursive: true });

  const git = core.git;
  const run = (args: string[]): Promise<unknown> => git.exec(target, args);
  const write = (rel: string, content: string): Promise<void> =>
    fs.writeFile(path.join(target, rel), content, 'utf8');
  const commit = async (message: string): Promise<void> => {
    await run(['add', '-A']);
    await run(['commit', '-m', message]);
  };

  await run(['init']);
  // Identity is repo-local so the playground works without global git config;
  // `checkout -b` (not `init -b`) keeps git 2.28 compatibility.
  await run(['config', 'user.name', 'GitTree Playground']);
  await run(['config', 'user.email', 'playground@gittree.invalid']);
  await run(['checkout', '-b', 'main']);

  await fs.mkdir(path.join(target, 'src'), { recursive: true });
  await write('README.md', README);
  await write('src/greeting.js', GREETING_V1);
  await write('NOTES.md', NOTES_V1);
  await commit('Initial playground: README, greeting, notes');

  await write('src/greeting.js', GREETING_V2);
  await commit('Add farewell()');

  // The conflicting branch forks here…
  await run(['branch', 'feature/polish']);

  // …main rewrites the greeting line…
  await write('src/greeting.js', GREETING_MAIN);
  await commit('main: switch greeting to a template literal');

  // …and feature/polish rewrites the same line differently.
  await run(['checkout', 'feature/polish']);
  await write('src/greeting.js', GREETING_POLISH);
  await commit('polish: extract the salutation');
  await run(['checkout', 'main']);

  // The pending edit for the user's first commit.
  await write('NOTES.md', NOTES_PENDING);

  core.output.appendLine(`[onboarding] playground created at ${target}`);

  if (seeded === undefined) {
    const open = vscode.l10n.t('Add to Workspace');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('GitTree playground created. Add it to this workspace to continue the walkthrough?'),
      open,
    );
    if (choice === open) {
      vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        0,
        { uri: vscode.Uri.file(target), name: DIR_NAME },
      );
    }
  }
  return target;
}
