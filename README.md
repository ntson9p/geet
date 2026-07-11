# GitTree

IntelliJ-grade Git integration for VS Code: changelists **and** staging paradigms, a
color-coded log graph, drag-and-drop interactive rebase, a true 3-pane merge editor
with full IntelliSense in the result pane, shelve, GitHub/GitLab code review, and an
operation-scoped Local History failsafe.

> Status: under construction. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
> and [docs/plan/](docs/plan/) for the build blueprint, [FEATURES.md](FEATURES.md)
> for the feature spec.

## Development

```sh
npm install
npm run watch          # esbuild watch → dist/extension.js  (F5 to debug)
npm run check          # typecheck + lint + unit tests
npm run test:integration  # @vscode/test-electron against fixture repos
npm run package        # vsce package --pre-release
```

Requirements: Node 20+, git ≥ 2.36 recommended (older versions degrade gracefully),
VS Code ≥ 1.96.
