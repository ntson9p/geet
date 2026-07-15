# Phase 8 — Deep Provider Integrations (GitHub / GitLab)

**Goal:** FEATURES.md §7 — Pull/Merge Request list with filters, full in-IDE review (line comments, Approve/Request Changes, merge) and a Timeline view with conversation + CI status. One abstraction, two providers, self-hosted included.

**Depends on:** P0 (auth plumbing, webview kit), P1 (repo model/remotes), P4 helpful for commit cross-links (soft).
**Exit criteria:** against live github.com and gitlab.com test repos: browse PRs, check out, review with line comments, approve, watch CI, and merge — without leaving VS Code.

---

## Status: SKIPPED (project-owner decision, 2026-07-16)

This phase was **not implemented**. The project owner decided to skip it because its exit
criteria require live github.com / gitlab.com accounts, seeded test repositories, PATs/OAuth
apps, and remote actions (pushing, creating PRs, merging) — none of which were available or
permitted for this build. No code under `src/review/**` exists; none of this phase's
contributions (`gittree-review` container, `gittree.pr.*` commands, `gittree.{github,gitlab}.hosts`
settings) are in `package.json`. FEATURES.md §7 is therefore intentionally unshipped, and the
P10 parity audit records it as *skipped by decision*, not as a gap that was missed.

Downstream adjustments made because of this skip:
- P10-T3's walkthrough omits the "connect GitHub/GitLab" step.
- The README parity matrix marks §7 as "not shipped (see PHASE-08 skip note)".
- P0-T8's askpass/auth bridge and the P0-T9 webview kit — this phase's two platform
  dependencies — are complete and tested, so nothing here was blocked on other phases.

### Getting started (guide for a future implementer)

The task specs below (T1–T7) remain the binding blueprint — implement them as written, in
dependency order. Practical notes from the rest of the codebase:

1. **Read first:** `IMPLEMENTATION_PLAN.md` §0 (agent rules), §4 (state/concurrency), §8
   (shared contracts — the `ReviewProvider` interface T2/T3 must implement is specified
   there), §9–10 (standards). Then this file top to bottom.
2. **Wire-up pattern:** create `src/review/register.ts` exporting `registerPhase08Review(core, context)`
   and append one call in `src/extension.ts` (append-only rule). Register debug internals via
   `core.debugRegistry.set('phase08', {...})` — integration tests reach internals only that way
   (never `instanceof` across the registry: module identity differs between the test compile
   and the dist bundle; compare `err.name` / use structural types).
3. **Existing platform pieces to reuse, not rebuild:**
   - Auth: `vscode.authentication.getSession('github', …)` for GitHub; for GitLab register the
     `gittree-gitlab` `AuthenticationProvider` per T1. SecretStorage only — never log tokens.
   - Webviews: the P0-T9 kit (`webview-ui/` Vite workspace, `protocol.ts` Msg v1, `WebviewRpcHost`,
     `RpcClient`, `VirtualList`, theme hooks). Add a `pr` entry alongside `log`/`rebaseEditor`.
   - Diff plumbing: `gittree-rev:` content provider + `makeRevUri` for local shas;
     `vscode.changes` for multi-diffs (see P2-T5/P4-T5 call sites).
   - Position mapping (T6): reuse `src/core/patch/patchParser.ts` (section split + hunk model)
     and P1's PatchBuilder line-diff for anchor→current-line mapping.
   - Commit cross-links (T7): P4's `revealCommit` command.
4. **Test strategy that works without accounts:** recorded-fixture tests (captured or
   hand-authored JSON payloads behind a fake fetch layer) cover every client method in CI;
   only the final smoke script needs live repos. Native auth dialogs can't be driven in
   integration tests — follow the existing `GITTREE_TEST_*` env-seam convention.
5. **What you must provision for the live exit criteria:** a GitHub test repo with a PR
   authored by a second account (GitHub forbids self-approval) and a CI workflow; a gitlab.com
   project + PAT (`api, read_repository`); optionally a GitLab OAuth app for the device flow
   (PAT-first is acceptable); GHES/self-managed GitLab can stay fixture-only with a deviation
   note.

---

## Tasks

### P8-T1 · Accounts, auth & host detection
**Depends:** P0-T8 · **Complexity:** M
**Output files:** `src/review/auth/{accounts.ts,gitlabAuthProvider.ts}`, `src/review/hostDetect.ts`.
**Steps:**
1. Host detection from `git remote -v`: parse https/ssh forms → `{provider: github|gitlab, host, owner, repo}`; extra hosts via `gittree.github.hosts` / `gittree.gitlab.hosts` (GHES / self-managed GitLab, incl. API base path overrides).
2. GitHub: `vscode.authentication.getSession('github', ['repo'], {createIfNone: onDemand})`; GHES uses the `github-enterprise` provider id when the user configured `github-enterprise.uri`, else PAT fallback below.
3. GitLab: register our own `AuthenticationProvider` (`gittree-gitlab`): PAT flow (scopes `api,read_repository`; validated via `/user`) + OAuth device-authorization flow where enabled; secrets in `SecretStorage`; multi-account per host; `registerUriHandler` for OAuth redirect.
4. Account status UI: Accounts submenu in PR view title (sign in/out, switch), auth-failure classification → re-auth prompt (single-flight, never a prompt storm).
**Accept:** unit: remote-URL parser matrix (ssh, https, ports, subgroups, `.git` suffix); manual: PAT + OAuth sign-in on gitlab.com; GH session reuse verified; secrets absent from logs.

### P8-T2 · GitHub client
**Depends:** T1 · **Complexity:** M
**Output files:** `src/review/providers/github.ts` (+ generated GraphQL types) implementing master-§8 `ReviewProvider`.
**Steps:**
1. GraphQL v4 for: PR search/list (states, author, assignee, review-requested, labels; pagination), PR detail (timeline items, review threads w/ positions & outdated flags, files, mergeability, reviewDecision), mutations (addReviewThread, submitReview PENDING→event, resolve/unresolve thread, merge with method).
2. REST for: check-runs/statuses per head sha, raw file content at sha (contents API w/ LFS pointer detection), merge fallback.
3. Infra: single fetch layer — token injection, ETag/If-None-Match cache (memory+`globalState`), secondary-rate-limit backoff (Retry-After), request coalescing, `AbortSignal` from CancellationTokens.
4. Capability map: `{reviews: true, draftReviews: true, mergeMethods: [merge,squash,rebase], resolveThreads: true, ciChecks: true}`.
**Accept:** recorded-fixture tests (nock-style captured payloads) for every method; live smoke script against a seeded test repo (rate-limit safe) run manually/nightly, not in PR CI.

### P8-T3 · GitLab client
**Depends:** T1 · **Complexity:** M
**Output files:** `src/review/providers/gitlab.ts`.
**Steps:**
1. REST v4: MR list (`state, author_username, assignee_username, reviewer_username, search`), MR detail (+ `diff_refs`: base/head/start shas), discussions (position payloads `{base_sha, head_sha, start_sha, old_path/new_path, old_line/new_line}`), notes CRUD, resolve discussion, approvals API (approve/unapprove), merge (`merge_when_pipeline_succeeds`, squash), pipelines+jobs per head sha, raw file at sha.
2. Same fetch-layer reuse; subgroup path encoding (`a%2Fb%2Fc`); pagination via `x-next-page`.
3. Capability map: `{requestChanges: false → mapped to unresolve+comment, approvals: true, mergeMethods per project settings, pipelines: true}` — UI hides unsupported verbs by capability, never hardcodes provider.
**Accept:** recorded-fixture tests incl. subgroup repos and position round-trips; capability-driven UI assertions (request-changes hidden for GitLab).

### P8-T4 · Pull Requests view (list + filters)
**Depends:** T2/T3 · **Complexity:** M
**Output files:** `src/review/prTree.ts`, view container `gittree-review` (activity bar) with view `gittree.pullRequests`.
**Steps:**
1. Query groups (collapsible): *Waiting on my review* · *Assigned to me* · *Created by me* · *All open* (+ custom queries in settings). PR rows: `#123 title` · author avatar (cached, CSP-safe via data URI) · state/CI/review badges · updated-at.
2. Filter title action: QuickPick chain (state → author → assignee → label → text) mapped to provider query; per-group manual refresh + poll (backoff: 60 s visible, 5 min hidden; ETag-driven cheap).
3. Row expansion: description node, commits, changed files (lazy). Context: Open in Browser, Copy URL, Checkout (T5), Open Timeline (T7).
4. Badge: view badge = count of *Waiting on my review*.
**Accept:** recorded-provider integration renders groups + badges; filter QuickPick narrows; poll respects backoff (fake timers).

### P8-T5 · Checkout & diffs (virtual FS)
**Depends:** T2/T3, P1 · **Complexity:** M
**Output files:** `src/review/prContent.ts` (`gittree-pr:` FileSystemProvider), `src/review/prCheckout.ts`.
**Steps:**
1. Checkout: GitHub `git fetch origin pull/<n>/head` → local branch `pr/<n>` (reuse+ff if exists); GitLab `git fetch origin merge-requests/<iid>/head` → `mr/<iid>`; sets an "active review" context linking editor buffers to the PR (enables commenting on real files, T6).
2. `gittree-pr:` serves file content at base/head shas from provider raw APIs with LRU + disk cache (`globalStorage/prcache`, size-capped); offline-tolerant (cache hit) and cancellable.
3. Diff UX: file node click → `vscode.diff(base, head)`; "View All Changes" → multi-diff (`vscode.changes`); works **without** checkout (spec: clicking a PR opens its diffs).
**Accept:** integration: diff opens pre-checkout from cache/API; checkout creates tracking branch and flips review context; re-fetch updates existing `pr/<n>` branch.

### P8-T6 · Review comments (Comment API)
**Depends:** T5 · **Complexity:** L
**Output files:** `src/review/comments/{controller.ts,positionMap.ts,pendingReview.ts}`.
**Steps:**
1. One `CommentController` per active PR; `commentingRangeProvider` = full range on `gittree-pr:` head docs + on real files when the checked-out sha matches PR head (else read-only threads).
2. Thread sync: provider threads → `CommentThread`s (markdown bodies, author avatars, reactions read-only v1, resolved state → `CommentThreadState`); **positionMap**: anchor (sha, path, line/side) → current doc line via hunk-mapping across `anchorSha..headSha` diff (P1 PatchBuilder's differ reused); unmappable (outdated) threads render only in Timeline (T7) with an "outdated" tag.
3. Create/reply/edit/delete own comments; `comments/commentThread/context` actions: Start Review (pending batch), Add Single Comment, Resolve/Unresolve (capability-gated).
4. `pendingReview`: local draft batch (persisted in `workspaceState` against reloads); submit UI (view title + thread action): Approve / Request Changes (capability) / Comment, with summary body input; GitLab "request changes" maps to comment+unresolve per T3 capability doc.
5. Comment editing uses VS Code's native comment widget (markdown, @-mention completion from provider member search via `CompletionItemProvider` scoped to comment input scheme).
**Accept:** recorded round-trip: create thread on head doc line → appears on provider with correct position; position mapping survives a new push (line shift fixture); pending review batches N comments into one submitted review; resolve state syncs both ways on refresh.

### P8-T7 · Timeline & CI webview + merge actions
**Depends:** T2/T3, P0-T9 · **Complexity:** L
**Output files:** `src/review/timelineView.ts`, `webview-ui/src/pr/**`.
**Steps:**
1. Webview panel per PR (singleton per id, revive-safe): header (title, branches, state, author, reviewers with decision icons) · tab strip **Conversation / Commits / Checks** (spec triad).
2. Conversation: merged event+comment stream (comments, review submissions with verdict color, commits, label/assign events, outdated line-comment cards with diff-hunk preview); reply + new-comment composer at bottom (routes through T6 pending logic); resolved threads collapsed.
3. Commits tab: list → click cross-links to log view when the commit exists locally (P4 `revealCommit`) else opens provider diff. Checks tab: per check-run/pipeline job rows (status icon, duration, link out; GitLab job trace link); auto-poll while PR open with visibility-aware cadence; header shows rolled-up CI state live.
4. Action bar: Approve / Request Changes / Comment (reuse T6 submit), **Merge** split-button (merge/squash/rebase per capabilities + repo settings, optional "delete source branch", GitLab "merge when pipeline succeeds") with confirmation modal showing method + target; Close/Reopen; post-merge: offer local branch cleanup (delete `pr/<n>`, switch to default, pull).
5. All content sanitized markdown (provider HTML stripped through a strict renderer); avatars/data URIs only — CSP stays `default-src 'none'`.
**Accept:** Playwright: three tabs render recorded fixtures incl. outdated comment cards and mixed CI states; merge flow (recorded) fires correct mutation + local cleanup prompt; poll pauses when panel hidden.

---

## Contributions added this phase
Activity-bar container `gittree-review` (view `gittree.pullRequests`); commands `gittree.pr.{refresh,filter,checkout,openTimeline,openInBrowser,startReview,submitReview,approve,merge,close,signIn,signOut}`; comment controller + `comments/*` menus; settings `gittree.{github,gitlab}.hosts`, `gittree.pr.{pollIntervalSeconds,customQueries,deleteBranchOnMerge}`.

## Parity checklist (FEATURES.md §7) — all intentionally unshipped, see Status at top
- [ ] PR/MR tool window listing open items, filterable by assignee, author, state
- [ ] Click a PR → its diffs open in-IDE (no checkout required)
- [ ] Line comments on code inside the IDE, batched into reviews
- [ ] Submit review: Approve / Request Changes (capability-mapped on GitLab) / Comment
- [ ] Merge the PR from the IDE (method choice, delete-branch option)
- [ ] Timeline: conversation thread, commit list, CI/pipeline status live
