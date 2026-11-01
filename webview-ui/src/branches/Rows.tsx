/**
 * The Branches panel's rows and a branch's card (new-way-4). Presentational:
 * every decision about what a row holds is the model's (`model.ts`), every
 * gesture goes back to the App through the callbacks.
 */
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import type {
  BranchPanelButtonDto,
  BranchPanelDetailsDto,
  BranchPanelRepoDto,
} from '../../../src/shared/protocol';
import {
  isCurrentEverywhere,
  longAge,
  quickActions,
  relationShort,
  relationText,
  shortAge,
  trackingShort,
  trackingText,
  type BranchEntry,
  type PanelRow,
  type QuickAction,
} from './model';

/** One indent step, the width VS Code's trees use. */
export const INDENT = 12;

export function Codicon({
  name,
  spin,
  className,
}: {
  name: string;
  spin?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`codicon codicon-${name}${spin === true ? ' gt-spin' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  );
}

/** A small icon button inside a row; its clicks never reach the row. */
export function RowButton({
  icon,
  title,
  onClick,
  spin,
  className,
  pressed,
}: {
  icon: string;
  title: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  spin?: boolean;
  className?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`gt-toolbar-button gtp-icon-button${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      <Codicon name={icon} spin={spin} />
    </button>
  );
}

/** `↓3 ↑2`: incoming then outgoing, IntelliJ's order and colours. */
export function SyncCounts({ ahead, behind }: { ahead?: number; behind?: number }) {
  if ((ahead ?? 0) === 0 && (behind ?? 0) === 0) return null;
  return (
    <span className="gtp-sync">
      {(behind ?? 0) > 0 ? (
        <span className="gtp-behind" title={`${behind} incoming: commits to pull`}>
          ↓{behind}
        </span>
      ) : null}
      {(ahead ?? 0) > 0 ? (
        <span className="gtp-ahead" title={`${ahead} outgoing: commits to push`}>
          ↑{ahead}
        </span>
      ) : null}
    </span>
  );
}

/** A name with its lead dimmed and the search's matches marked. */
export function Name({
  prefix,
  label,
  highlights,
}: {
  prefix: string;
  label: string;
  highlights: ReadonlyArray<readonly [number, number]>;
}) {
  const text = prefix + label;
  const parts: ReactNode[] = [];
  // Cut points: the prefix boundary and every highlight edge.
  const cuts = new Set<number>([0, prefix.length, text.length]);
  for (const [a, b] of highlights) {
    cuts.add(a);
    cuts.add(b);
  }
  const points = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a === b) continue;
    const marked = highlights.some(([x, y]) => a >= x && b <= y);
    const dim = b <= prefix.length;
    const cls = `${dim ? 'gtp-prefix' : ''}${marked ? ' gtp-match' : ''}`.trim();
    parts.push(
      <span key={a} className={cls.length > 0 ? cls : undefined}>
        {text.slice(a, b)}
      </span>,
    );
  }
  return <span className="gtp-name">{parts}</span>;
}

// ---------------------------------------------------------------------------
// Section, remote and folder rows
// ---------------------------------------------------------------------------

export function SectionRow({
  row,
  searching,
  actions,
}: {
  row: Extract<PanelRow, { kind: 'section' }>;
  searching: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="gtp-section">
      <span className="gtp-twisty">
        {searching ? null : <Codicon name={row.open ? 'chevron-down' : 'chevron-right'} />}
      </span>
      <span className="gtp-section-label">{row.label}</span>
      <span className="gtp-count">{row.count}</span>
      <span className="gtp-spacer" />
      {actions !== undefined ? <span className="gtp-section-actions">{actions}</span> : null}
    </div>
  );
}

export function GroupRow({
  icon,
  label,
  count,
  open,
  depth,
}: {
  icon: string;
  label: string;
  count: number;
  open: boolean;
  depth: number;
}) {
  return (
    <div className="gtp-node" style={{ paddingLeft: 8 + depth * INDENT }}>
      <span className="gtp-twisty">
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
      </span>
      <Codicon name={icon} className="gtp-icon" />
      <span className="gtp-label">{label}</span>
      <span className="gtp-count">{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function headText(repo: BranchPanelRepoDto): string {
  if (repo.unborn) return `${repo.head ?? 'main'} (no commits yet)`;
  if (repo.detached || repo.head === undefined) {
    return `detached at ${repo.headSha?.slice(0, 7) ?? 'HEAD'}`;
  }
  return repo.head;
}

export interface RepoButtonsProps {
  readonly repo: BranchPanelRepoDto;
  readonly onUpdate: () => void;
  readonly onPush: () => void;
  readonly onFetch: () => void;
  readonly onMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

function RepoButtons({ repo, onUpdate, onPush, onFetch, onMenu }: RepoButtonsProps) {
  return (
    <span className={`gtp-row-buttons${repo.fetching ? ' gtp-busy' : ''}`}>
      {repo.upstream !== undefined && repo.upstreamGone !== true ? (
        <RowButton icon="arrow-down" title="Update Project…" onClick={onUpdate} />
      ) : null}
      {!repo.unborn ? <RowButton icon="arrow-up" title="Push…" onClick={onPush} /> : null}
      <RowButton
        icon="sync"
        title={repo.fetching ? 'Fetching…' : 'Fetch'}
        spin={repo.fetching}
        className={repo.fetching ? 'gtp-keep' : undefined}
        onClick={onFetch}
      />
      <RowButton icon="ellipsis" title="More Actions…" onClick={onMenu} />
    </span>
  );
}

export function RepoRow({
  row,
  color,
  showInOut,
  buttons,
}: {
  row: Extract<PanelRow, { kind: 'repo' }>;
  color: string;
  showInOut: boolean;
  buttons: Omit<RepoButtonsProps, 'repo'>;
}) {
  const { repo } = row;
  const dim = row.narrowed && !row.inScope;
  const hint = row.narrowed && row.inScope
    ? 'Click to show every repository again · Ctrl+click to leave this one out'
    : 'Click to show only its branches · Ctrl+click to add it to what is shown';
  return (
    <div className={`gtp-repo${dim ? ' gtp-out-of-scope' : ''}`} title={`${repo.root}
${hint}`}>
      <span
        className={`gtp-dot${row.inScope ? ' gtp-dot-on' : ''}`}
        style={{ '--gtp-repo': color } as CSSProperties}
        aria-hidden="true"
      />
      <span className="gtp-repo-name">{repo.label}</span>
      <span className="gtp-repo-head" title={repo.upstream !== undefined ? `Tracks ${repo.upstream}` : undefined}>
        <Codicon name={repo.detached ? 'git-commit' : 'git-branch'} />
        <span className="gtp-repo-head-name">{headText(repo)}</span>
      </span>
      {showInOut ? <SyncCounts ahead={repo.ahead} behind={repo.behind} /> : null}
      {repo.changes > 0 ? (
        <span className="gtp-changes" title={`${repo.changes} changed file${repo.changes === 1 ? '' : 's'}`}>
          <Codicon name="diff-modified" />
          {repo.changes}
        </span>
      ) : null}
      <span className="gtp-spacer" />
      <RepoButtons repo={repo} {...buttons} />
    </div>
  );
}

export function HeadRow({
  row,
  showInOut,
  buttons,
  card,
}: {
  row: Extract<PanelRow, { kind: 'head' }>;
  showInOut: boolean;
  buttons: Omit<RepoButtonsProps, 'repo'>;
  card: ReactNode;
}) {
  const { repo } = row;
  const onBranch = !repo.detached && repo.head !== undefined;
  return (
    <div className="gtp-head-wrap">
      <div className="gtp-head">
        <span className="gtp-twisty">
          <Codicon name={row.card ? 'chevron-down' : 'chevron-right'} />
        </span>
        <Codicon name={onBranch ? 'check' : 'git-commit'} className="gtp-icon gtp-current-icon" />
        <span className="gtp-head-name">{headText(repo)}</span>
        {repo.upstream !== undefined ? (
          <span className={`gtp-dim${repo.upstreamGone === true ? ' gtp-gone-text' : ''}`}>
            {repo.upstreamGone === true ? `${repo.upstream} (gone)` : repo.upstream}
          </span>
        ) : onBranch && !repo.unborn ? (
          <span className="gtp-dim">not published</span>
        ) : null}
        {showInOut ? <SyncCounts ahead={repo.ahead} behind={repo.behind} /> : null}
        {repo.changes > 0 ? (
          <span className="gtp-changes" title={`${repo.changes} changed file${repo.changes === 1 ? '' : 's'}`}>
            <Codicon name="diff-modified" />
            {repo.changes}
          </span>
        ) : null}
        <span className="gtp-spacer" />
        <RepoButtons repo={repo} {...buttons} />
      </div>
      {card}
    </div>
  );
}

export function OperationRow({
  repo,
  onRun,
}: {
  repo: BranchPanelRepoDto;
  onRun: (command: string) => void;
}) {
  const op = repo.operation;
  if (op === undefined) return null;
  const verb =
    op.kind === 'rebase'
      ? 'Rebasing'
      : op.kind === 'cherry-pick'
        ? 'Cherry-picking'
        : op.kind === 'revert'
          ? 'Reverting'
          : 'Merging';
  const progress = op.step !== undefined && op.total !== undefined ? ` ${op.step}/${op.total}` : '';
  const conflicts =
    op.conflicts > 0 ? ` · ${op.conflicts} conflict${op.conflicts === 1 ? '' : 's'}` : '';
  const isRebase = op.kind === 'rebase';
  return (
    <div className="gtp-operation" role="status">
      <Codicon name="warning" className="gtp-operation-icon" />
      <span
        className="gtp-operation-text"
        title={`${repo.label}: ${verb.toLowerCase()}${progress}${conflicts}. Continue once the conflicts are resolved, or abort to go back.`}
      >
        {verb}
        {progress}
        {conflicts}
      </span>
      <span className="gtp-spacer" />
      {op.conflicts > 0 ? (
        <button
          type="button"
          className="gt-button gtp-small"
          tabIndex={-1}
          title="Resolve the conflicts"
          onClick={() => onRun('gittree.conflicts.focus')}
        >
          <Codicon name="git-merge" />
          <span className="gtp-button-label">Resolve…</span>
        </button>
      ) : null}
      <button
        type="button"
        className="gt-button gt-primary gtp-small"
        tabIndex={-1}
        title={`Continue the ${verb.toLowerCase().replace(/ing$/u, 'e')}`}
        onClick={() => onRun(isRebase ? 'gittree.rebase.continue' : 'gittree.merge.continueOp')}
      >
        <Codicon name="debug-continue" />
        <span className="gtp-button-label">Continue</span>
      </button>
      <button
        type="button"
        className="gt-button gtp-small"
        tabIndex={-1}
        title="Abort, back to where it started"
        onClick={() => onRun(isRebase ? 'gittree.rebase.abort' : 'gittree.merge.abortOp')}
      >
        <Codicon name="discard" />
        <span className="gtp-button-label">Abort</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch rows
// ---------------------------------------------------------------------------

function branchIcon(entry: BranchEntry): string {
  if (entry.currentIn.length > 0) return 'check';
  if (entry.favorite) return 'star-full';
  if (entry.kind === 'tag') return 'tag';
  return 'git-branch';
}

/** One dot per repository in view: filled where the branch is checked out, ringed where it exists. */
export function Markers({
  entry,
  repos,
  colorOf,
}: {
  entry: BranchEntry;
  repos: readonly BranchPanelRepoDto[];
  colorOf: (repo: BranchPanelRepoDto) => string;
}) {
  const parts: string[] = [];
  const dots = repos.map((repo) => {
    const p = entry.presence.find((x) => x.repo.root === repo.root);
    const state = p === undefined ? 'none' : p.ref.current === true ? 'current' : 'has';
    parts.push(
      `${repo.label}: ${state === 'current' ? 'checked out' : state === 'has' ? 'has it' : '—'}`,
    );
    return (
      <span
        key={repo.root}
        className="gtp-marker"
        data-state={state}
        style={{ '--gtp-repo': colorOf(repo) } as CSSProperties}
      />
    );
  });
  return (
    <span className="gtp-markers" title={parts.join('\n')}>
      {dots}
    </span>
  );
}

export interface BranchRowProps {
  readonly row: Extract<PanelRow, { kind: 'branch' }>;
  readonly now: number;
  readonly showInOut: boolean;
  readonly markers: boolean;
  readonly scopeRepos: readonly BranchPanelRepoDto[];
  readonly colorOf: (repo: BranchPanelRepoDto) => string;
  readonly onQuick: (action: QuickAction, e: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly card: ReactNode;
  readonly draggable: boolean;
  readonly onDragStart: (e: ReactDragEvent<HTMLDivElement>) => void;
}

function quickTitle(action: QuickAction, entry: BranchEntry): string {
  const n = entry.presence.length;
  switch (action) {
    case 'checkout':
      return n > 1 ? `Checkout in ${n} repositories` : 'Checkout';
    case 'update':
      return 'Update';
    case 'push':
      return 'Push…';
    case 'star':
      return entry.favorite ? 'Remove from Favorites' : 'Add to Favorites';
    case 'menu':
      return 'More Actions…';
  }
}

const QUICK_ICON: Record<QuickAction, string> = {
  checkout: 'arrow-swap',
  update: 'arrow-down',
  push: 'arrow-up',
  star: 'star-empty',
  menu: 'ellipsis',
};

export function BranchRow({
  row,
  now,
  showInOut,
  markers,
  scopeRepos,
  colorOf,
  onQuick,
  card,
  draggable,
  onDragStart,
}: BranchRowProps) {
  const { entry } = row;
  const current = entry.currentIn.length > 0;
  const partial = current && !isCurrentEverywhere(entry);
  const age = shortAge(now, entry.date);
  return (
    <div className="gtp-branch-wrap">
      <div
        className={`gtp-branch${current ? ' gtp-is-current' : ''}${partial ? ' gtp-partial' : ''}`}
        style={{ paddingLeft: 8 + row.depth * INDENT }}
        title={`${entry.name}${entry.subject !== undefined ? `
${entry.subject}` : ''}
Click for details · right-click for every action${
          draggable ? ' · drag onto another branch to merge or rebase' : ''
        }`}
        draggable={draggable}
        onDragStart={onDragStart}
      >
        <span className="gtp-twisty">
          <Codicon name={row.card ? 'chevron-down' : 'chevron-right'} className="gtp-disclosure" />
        </span>
        <Codicon
          name={branchIcon(entry)}
          className={`gtp-icon${current ? ' gtp-current-icon' : ''}${entry.favorite && !current ? ' gtp-star-icon' : ''}`}
        />
        <Name prefix={row.prefix} label={row.label} highlights={row.highlights} />
        {entry.gone ? (
          <span className="gtp-chip gtp-gone" title="The remote branch it tracked was deleted">
            gone
          </span>
        ) : null}
        {entry.merged && !current ? (
          <span
            className="gtp-chip gtp-merged"
            title={`Merged into ${entry.presence[0]?.repo.mainBranch ?? 'the main branch'}`}
          >
            merged
          </span>
        ) : null}
        <span className="gtp-spacer" />
        {showInOut && entry.kind === 'local' ? <SyncCounts ahead={entry.ahead} behind={entry.behind} /> : null}
        {markers ? <Markers entry={entry} repos={scopeRepos} colorOf={colorOf} /> : null}
        <span className="gtp-age" title={entry.date !== undefined ? longAge(now, entry.date) : undefined}>
          {age}
        </span>
        <span className="gtp-row-buttons">
          {quickActions(entry).map((action) => (
            <RowButton
              key={action}
              icon={action === 'star' && entry.favorite ? 'star-full' : QUICK_ICON[action]}
              title={quickTitle(action, entry)}
              className={action === 'star' && entry.favorite ? 'gtp-star-on' : undefined}
              pressed={action === 'star' ? entry.favorite : undefined}
              onClick={(e) => onQuick(action, e)}
            />
          ))}
        </span>
      </div>
      {card}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A branch's card
// ---------------------------------------------------------------------------

export interface CardProps {
  readonly entry: BranchEntry | undefined;
  readonly details: BranchPanelDetailsDto | undefined;
  readonly markers: boolean;
  readonly now: number;
  readonly indent: number;
  readonly colorOf: (repo: BranchPanelRepoDto) => string;
  readonly onButton: (button: BranchPanelButtonDto) => void;
  readonly onMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Detached HEAD: there is no branch to describe. */
  readonly detachedAt?: string;
}

/**
 * What a branch is, under its row: its last commit, where it stands against
 * what it tracks and against what is checked out, and the few actions that
 * fit — the model sizes it (`cardLineCount`), so its lines are fixed.
 */
export function BranchCard({
  entry,
  details,
  markers,
  now,
  indent,
  colorOf,
  onButton,
  onMenu,
  detachedAt,
}: CardProps) {
  const lines: ReactNode[] = [];
  if (entry === undefined) {
    lines.push(
      <div key="detached" className="gtp-card-line">
        <Codicon name="git-commit" />
        <span className="gtp-ellipsis">HEAD is detached at {detachedAt ?? 'a commit'}</span>
      </div>,
      <div key="hint" className="gtp-card-line gtp-dim">
        <span className="gtp-ellipsis">Check out a branch, or start one here.</span>
      </div>,
    );
  } else {
    const newest = details?.repos.find((r) => r.date !== undefined && r.author !== undefined) ?? details?.repos[0];
    lines.push(
      <div key="commit" className="gtp-card-line">
        <Codicon name="git-commit" />
        <span className="gtp-ellipsis gtp-subject" title={entry.subject}>
          {entry.subject ?? '…'}
        </span>
        <span className="gtp-card-meta">
          {newest?.author !== undefined ? `${newest.author} · ` : ''}
          {longAge(now, newest?.date ?? entry.date)}
        </span>
      </div>,
    );
    const many = markers && entry.presence.length > 1;
    if (many) {
      for (const p of entry.presence) {
        const d = details?.repos.find((r) => r.root === p.repo.root);
        const relation = p.ref.current === true ? undefined : relationShort(d);
        lines.push(
          <div key={p.repo.root} className="gtp-card-line">
            <span
              className="gtp-marker"
              data-state={p.ref.current === true ? 'current' : 'has'}
              style={{ '--gtp-repo': colorOf(p.repo) } as CSSProperties}
            />
            <span className="gtp-card-repo">{p.repo.label}</span>
            <span className="gtp-ellipsis gtp-dim">
              {p.ref.current === true ? 'checked out · ' : ''}
              {trackingShort(p.ref, entry.kind, d?.trackedBy)}
              {relation !== undefined ? ` · ${relation}` : ''}
            </span>
          </div>,
        );
      }
    } else {
      const p = entry.presence[0];
      const d = details?.repos[0];
      const merged = entry.merged ? ` · merged into ${p?.repo.mainBranch ?? 'the main branch'}` : '';
      lines.push(
        <div key="tracking" className="gtp-card-line">
          <Codicon name={entry.kind === 'tag' ? 'tag' : 'cloud'} />
          <span className="gtp-ellipsis">
            {p !== undefined ? trackingText(p.ref, entry.kind, d?.trackedBy) : ''}
            {merged}
          </span>
        </div>,
      );
      if (!isCurrentEverywhere(entry)) {
        lines.push(
          <div key="relation" className="gtp-card-line">
            <Codicon name="git-compare" />
            <span className="gtp-ellipsis gtp-dim">{relationText(d) ?? (details ? '' : '…')}</span>
          </div>,
        );
      }
    }
  }
  return (
    <div className="gtp-card" style={{ marginLeft: indent }} onClick={(e) => e.stopPropagation()}>
      {lines}
      <div className="gtp-card-buttons">
        {(details?.buttons ?? []).map((button, i) => (
          <button
            key={`${button.label}-${i}`}
            type="button"
            className={`gt-button gtp-card-button${i === 0 ? ' gt-primary' : ''}`}
            title={button.title}
            onClick={() => onButton(button)}
          >
            <Codicon name={button.icon} />
            <span className="gtp-button-label">{button.label}</span>
          </button>
        ))}
        {details === undefined ? <span className="gtp-dim gtp-loading">Loading…</span> : null}
        <span className="gtp-spacer" />
        <button
          type="button"
          className="gt-toolbar-button gtp-icon-button"
          title="More Actions…"
          aria-label="More Actions…"
          onClick={onMenu}
        >
          <Codicon name="ellipsis" />
        </button>
      </div>
    </div>
  );
}
