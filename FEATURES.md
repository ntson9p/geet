Below is the exhaustive, structured specification of IntelliJ IDEA Ultimate’s Git features, broken down by UI/UX components and underlying functionalities.

---

## 1. Global UI & Editor Integration

### Editor Gutter Annotations

* **Color-Coded Line Tracking:** The left editor gutter shows vertical color bars indicating line status: **Green** (added), **Blue** (modified), **Grey** (deleted).
* **Click-to-Diff:** Clicking a color bar opens a floating inline diff viewer showing the original code versus the current code.
* **Inline Rollback:** From this floating popup, the user can click a "Rollback" icon to revert just that specific hunk, or a "Stash/Commit" icon to manage it.

### Git Blame (Annotations)

* **Toggleable Gutter Blame:** Right-clicking the gutter allows users to enable "Annotate with Git Blame."
* **Visual History:** The gutter expands to show the author's name, date, and commit hash for every line.
* **Color Fading:** Recent commits are highlighted in darker/bolder colors, while older commits fade, providing a heat-map of code age.
* **Interactivity:** Clicking a blame annotation opens the corresponding commit in the Git Log tool window.

### The VCS Status Widget

* **Location:** Bottom right of the status bar (or top left in the New UI).
* **Function:** Displays the current branch name, sync status (arrows with numbers for incoming/outgoing commits). Clicking it opens the **Branches Popup** (detailed below).

---

## 2. Branch Management (The Branches Popup)

IntelliJ abandons command-line branch switching for a highly categorized, searchable, and protective GUI.

### Structure & UI

* **Search Bar:** Filters branches by name instantly.
* **Categories:** Branches are strictly categorized into: **Current Branch**, **Recent Branches** (automatically populated based on checkout frequency), **Local Branches**, and **Remote Branches**.
* **Favorites:** Users can click a star icon next to any branch to pin it to the top.

### Core Functionalities

* **Smart Checkout:** If local uncommitted changes conflict with the target branch, IntelliJ intercepts the `git checkout` failure and offers a "Smart Checkout." It automatically stashes the changes, checks out the target branch, and unstashes the changes, initiating a merge conflict resolution if necessary.
* **Context Menu Actions per Branch:**
* *Checkout*
* *Checkout and Rebase onto Current*
* *New Branch from Selected*
* *Compare with Current* (Opens a unified tree view showing all commits and file diffs between the two branches).
* *Show Diff with Working Tree*
* *Rename / Delete / Push*

---

## 3. The Commit Lifecycle (Commit Tool Window)

IntelliJ offers two distinct paradigms for staging, configurable in the settings. Your extension must support both to achieve parity.

### Paradigm A: Changelists (The Default)

* **Concept:** Bypasses the Git index (staging area) entirely. Changes are grouped into logical, IDE-managed buckets called "Changelists" (e.g., "Default Changelist", "Refactoring Database").
* **Function:** Users can check/uncheck files within these lists to commit. This is ideal for working on multiple distinct tasks simultaneously without branching.

### Paradigm B: Git Staging Area

* **Concept:** Mirrors the native `git add` workflow.
* **UI Layout:** The window splits into **Staged** and **Unstaged** changes.
* **Hunk/Line Level Staging:** Selecting a file opens a diff viewer directly below it. Users can select specific lines or hunks and click `>>` to move them to the Staged area.

### Pre-Commit Checks (Crucial Differentiator)

Before executing a commit, the UI offers a checklist of operations that the IDE performs automatically:

1. **Reformat Code:** Runs the IDE's code formatter on the modified lines only.
2. **Optimize Imports:** Removes unused imports.
3. **Analyze Code:** Runs static analysis/linting and halts the commit if warnings or errors are found (prompts the user to review or commit anyway).
4. **Check TODOs:** Warns if new `TODO` or `FIXME` comments were introduced.
5. **Cleanup:** Applies safe code cleanups.

### Commit Actions

* **Commit Message History:** A dropdown remembers previous commit messages.
* **Amend:** A simple checkbox merges the current staged files into the previous commit and loads the previous message into the text area.
* **Sign Commit:** GPG signature integration via a toggleable icon.

---

## 4. Git Log & History (Git Tool Window)

This is the control center for reviewing project history, replacing tools like SourceTree or GitKraken.

### The Graph View

* **Visuals:** A highly optimized, color-coded topological graph of commits.
* **Intelli-Sort:** Supports native Git sorting (`Date`, `Topo`) plus JetBrains' proprietary "IntelliSort," which makes complex merge histories easier to read visually.

### Search and Filtering Engine

* **Filters:** Top bar allows intersecting filters by: **Branch** (e.g., only `HEAD` or `master`), **User** (auto-completes author names), **Date** (ranges), and **Path** (filters the entire graph to show only commits affecting a specific file/folder).

### Advanced Context Menu Actions (Commit Modification)

Right-clicking any commit in the log provides access to advanced rewriting tools without touching the CLI:

* **Interactive Rebase:** Selecting a sequence of commits opens a bespoke UI where users can drag-and-drop commits to reorder them, and select actions from a dropdown: *Pick*, *Squash*, *Reword*, *Fixup*, or *Drop*.
* **Undo Commit:** Automatically creates a reverse patch of a commit and puts it in the staging area.
* **Revert Commit:** Executes `git revert`.
* **Cherry-Pick:** Copies a commit from another branch into the current working branch, auto-resolving cleanly when possible.
* **Drop Commit:** Hard removes the commit (executes a background rebase).

---

## 5. 3-Way Merge Conflict Resolution Engine

This is widely considered IntelliJ's strongest feature. When a merge conflict occurs, the "Conflicts" dialog appears.

### The UI Layout

* Clicking "Merge" opens a dedicated three-pane window.
* **Left Pane:** Local version (Your changes).
* **Right Pane:** Server/Remote version (Their changes).
* **Center Pane:** The "Result" file being built.

### Resolution Mechanics

* **The Magic Wand:** A button in the toolbar that automatically resolves all "simple" (non-overlapping) conflicts instantly.
* **Chevrons (`>>`, `<<`):** Conflicts are highlighted with colored blocks. Clicking the chevron on the left pulls your code into the center; clicking the chevron on the right pulls their code in.
* **Manual Editing:** The center pane is a fully functional editor with syntax highlighting and autocompletion, allowing manual rewriting if `>>`/`<<` isn't sufficient.
* **Accept Left / Accept Right:** Global buttons to blindly overwrite with one side's version.

---

## 6. Stash and Shelve

IntelliJ supports native Git stashing and its own proprietary shelving.

### Git Stash

* Standard `git stash` GUI. Allows saving the working directory, viewing the stash list, diffing stashes against the current working tree, and popping/applying them.

### Git Shelve

* **Concept:** An IDE-specific feature that stores uncommitted changes as `.patch` files on the local disk, entirely outside of Git's `.git` directory structure.
* **Why it exists:** It allows users to store changes safely even if they need to delete the Git repository or perform destructive Git operations that might wipe native stashes.
* **UI:** A dedicated "Shelf" tab in the Commit Tool window allows users to view shelved patches, edit them, and unshelve them to the current working tree.

---

## 7. Deep Provider Integrations (GitHub / GitLab)

Ultimate Edition integrates cloud provider APIs to move code review into the IDE.

* **Pull Requests Tool Window:** Lists all open PRs. Users can filter by assignee, author, or state.
* **In-IDE Review:** Clicking a PR opens its diffs. Users can add comments directly to lines of code inside the IDE, submit reviews (Approve, Request Changes), and merge the PR.
* **Timeline View:** Shows the conversation thread, CI/CD pipeline status (e.g., GitHub Actions results), and commit list.

---

## 8. The Failsafe: Local History

While not strictly a Git feature, no implementation plan of IntelliJ's VCS capabilities is complete without **Local History**.

* **Function:** The IDE independently records every file save, test run, and Git operation in an offline, invisible timeline, completely independent of Git.
* **UX:** If a user accidentally runs a destructive Git command (e.g., a bad `git reset --hard` or deleting an uncommitted file), they can right-click the project root, select "Local History -> Show History," and restore the exact state of the files from 5 minutes ago. Your VSCode extension should bridge to VSCode's native "Timeline" feature to replicate this safety net.
