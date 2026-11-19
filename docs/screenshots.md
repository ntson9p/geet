# Screenshots

The README's images are taken by a script, so they can be taken again whenever
GitTree's look changes:

```sh
npm run screenshots
```

It takes about three minutes and needs nothing beyond `npm install`. Leave the
VS Code window it opens alone while it runs. Then look at the new images in
`docs/images/` (git shows only those that changed), commit them, and push them
to `main`: the Marketplace page shows the copies on GitHub's default branch.

## What it does

1. **Builds GitTree** as it ships: `node esbuild.mjs --production` and the
   webviews (`npm run build:webviews`).
2. **Builds a demo workspace** (`scripts/screenshots/demo.mjs`): *pantry*, a
   made-up meal-planning app kept in three repositories, `web`, `api` and
   `shared`, each with an origin. Its history
   (`scripts/screenshots/demoHistory.mjs`) is written with fixed people and
   fixed dates, so every run makes the same commits with the same hashes.
3. **Opens it in a scratch VS Code** (`scripts/screenshots/vscode.mjs`): the
   version pinned in `VSCODE_VERSION`, downloaded once into `.vscode-test/`,
   with a throwaway profile, the settings in `SETTINGS` (Dark Modern, no
   welcome pages or prompts) and this checkout as the extension under
   development. It always draws a window of the same size at twice the
   pixels, whatever your screen, so the images are sharp on high-DPI screens.
4. **Plays the scenes** (`scripts/screenshots/scenes.mjs`) through the Chrome
   DevTools protocol, as a person would: commands from the Command Palette,
   clicks and right-clicks in GitTree's views. Each scene writes its image to
   `docs/images/`.
5. **Closes VS Code** and deletes the demo and the profile.

| Option | What it does |
| --- | --- |
| `--only hero,log` | Plays only these scenes (the set-up they share still runs). |
| `--no-build` | Uses `dist/` as it is. |
| `--keep` | Keeps the demo and the VS Code profile, to look at afterwards. |
| `--work <folder>` | Where the demo and the profile go. |

The work folder is `C:\gittree-screenshots` on Windows and
`<temp>/gittree-screenshots` elsewhere. GitTree shows a repository's full
path in places (the Log's Changed Files), and on Windows the temp folder is
under your user folder, whose name would then be in the images. The script
deletes only a folder it made itself (it leaves a marker file in it), and
refuses any other.

If a scene fails, the run carries on, exits with an error, and keeps the work
folder: `failed-<scene>.png` in it shows the window at the failure, and
`vscode/user-data/logs/` has VS Code's logs.

## The scenes

| Image | Scene | What it shows |
| --- | --- | --- |
| `hero.png` | `hero` | The whole window: the Commit window with three changelists, GitTree's diff of an uncommitted change, and the Log. |
| `commit.png` | `commit` | The Commit window, wide: changelists across two repositories, and the diff preview with one change of a file left out. |
| `log.png` | `log` | The Log, maximized: branches, the graph of every branch, a commit's files and details. |
| `branches.png` | `branches` | The branches popup for the `web` repository. |
| `rebase.png` | `rebase` | The interactive rebase editor, two fixups planned. |
| `push.png` | `push` | The Push dialog with two repositories ticked and the commands it will run. |
| `merge.png` | `merge` | The three-pane merge editor on a real conflict in `shared`. |
| `blame.png` | `blame` | Blame beside the code, three authors and an uncommitted line. |

## Nothing personal in the images

- The people are invented, their addresses are on `example.com`, and the
  origins look like `https://git.example.com/pantry/web.git` (bare repositories
  on disk, through git's `url.<base>.insteadOf`).
- Git runs with no system or global configuration of yours: VS Code is started
  with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` pointing at the demo's
  own `gitconfig`, so your name, e-mail address and aliases never reach GitTree.
- VS Code runs with a profile of its own: none of your settings, extensions or
  accounts.
- Paths start at the work folder above, never at your user folder.

Look at the images before committing them all the same.

## What changes between runs

On the same computer, nothing, unless GitTree or the scenes changed: an image
that comes out the same is written byte for byte the same. Three things can
differ elsewhere or later:

- **Times** are shown in your time zone.
- **Fonts** are your operating system's.
- **Blame** gives each line's age from today ("2mo ago"), so `blame.png` moves
  on as the demo's dates grow older.

## Changing the scenes

- A scene is an entry of `SCENES` in `scripts/screenshots/scenes.mjs`: its
  name, what it shows, the image files it writes, what it does, and how it
  puts back what it changed.
- Every image the README shows must come from a scene, and every scene's image
  must be in the README; `test/unit/scripts/screenshots.test.ts` holds both.
- Images live in `docs/images/`, which `.vscodeignore` leaves out of the VSIX:
  vsce points the README's relative image paths at GitHub's copies.
- Moving to a newer VS Code changes every image a little: bump
  `VSCODE_VERSION` on purpose, and look at all of them.
