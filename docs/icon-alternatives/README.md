# Icon alternatives

Icons the owner liked but did not pick, kept so Geet can switch to one later.
Each folder holds the same four files as `media/`, drawn the same way:

- `geet-mark.svg`: the activity bar's icon;
- `geet-mark-solid.svg`: the same with its dot filled;
- `icon.svg`: the Marketplace icon;
- `icon.png`: `icon.svg` at 256px, rendered by `webview-ui/tests/capture.spec.ts` with `GEET_CAPTURE=1`.

Like the rest of `docs/`, they are left out of the VSIX.
`test/unit/docs/iconAlternatives.test.ts` checks that each folder stays ready to use.

| Folder | The icon |
| --- | --- |
| `dot-tucked-in/` | "Dot tucked in", V2 of the second round of drawings (2026-11-22). A G drawn as VS Code's Refresh arrow, mirrored: the line starts on a hollow dot tucked inside the circle and runs round into the corner where the G's stem meets its crossbar. |

## Switching to one

1. Copy its four files over the ones in `media/`.
2. Rework the shape tests in `test/unit/docs/icon.test.ts` for the new drawing.
3. Retake the README screenshots that show the activity bar:
   `npm run screenshots -- --only hero,merge`.
4. Say so in `CHANGELOG.md` and `docs/plan/PROGRESS.md`.
