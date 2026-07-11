# Progress log

P0-T1 ✅ 2026-07-11 — scaffold: manifest (engine ^1.96), esbuild bundle, strict tsc, eslint flat config (type-checked, no-floating-promises), vitest, CI matrix workflow, vsce packaging verified, integration bootstrap green locally (Windows); CI execution pending first push (no remote configured).
P0-T2 ✅ 2026-07-11 — GitExecutor: vscode-free core with injected trace/env, locator chain (settings→PATH→well-known), capabilities probe, stderr classifier, NUL/LF stream pump with yield-based backpressure, tree-kill cancellation; 52 unit + 6 integration tests green.
P0-T3 ✅ 2026-07-11 — Porcelain parsers (statusV2/refs/logFormat/blameIncremental/stashList/reflog) with fixtures captured from real git via test/unit/fixtures/git/capture.mjs: unicode paths, -z renames, unmerged stage masks, detached, gone upstream, merge log, boundary blame; 46 new tests.
