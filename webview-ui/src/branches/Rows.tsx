/**
 * The Repositories panel's rows and a branch's card (new-way-4). Presentational:
 * every decision about what a row holds is the model's (`model.ts`), every
 * gesture goes back to the App through the callbacks.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
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
  relationText,
  remoteTwin,
  repoHint,
  shortAge,
  tabTitle,
  trackingText,
  upstreamElsewhere,
  type BranchEntry,
  type BranchTab,
  type CardGroup,
  type CardLine,
  type PanelRow,
  type QuickAction,
  type RowWhere,
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

/** What a `→ origin/x` says under the pointer. */
function elsewhereTitle(upstream: string): string {
  return `Tracks ${upstream}, a remote branch of another name: a push goes there, not to a branch of its own. Right-click to stop tracking.`;
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

/**
 * The roomiest of `levels` its element fits in, for a strip that would rather
 * drop words than cut a control off or shrink every label to a letter. Each
 * level is tried on the element's `data-fit`, roomiest first, and the first
 * with nothing overflowing is kept; CSS says what each level drops. Measured
 * again when the element is resized, or when `content` says what it holds changed.
 */
function useFit<L extends string>(
  levels: readonly L[],
  content: string,
): [MutableRefObject<HTMLDivElement | null>, L] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<L>(levels[0]!);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      const chosen =
        levels.find((level) => {
          el.dataset['fit'] = level;
          return el.scrollWidth <= el.clientWidth;
        }) ?? levels[levels.length - 1]!;
      el.dataset['fit'] = chosen;
      setFit(chosen);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content, levels]);
  return [ref, fit];
}

type TabsFit = 'full' | 'names' | 'snug' | 'tight';
/** Roomiest first: names and counts, names alone, then less and less padding. */
const TABS_FITS: readonly TabsFit[] = ['full', 'names', 'snug', 'tight'];

type CardFit = 'full' | 'lead' | 'icons' | 'tight';
/** Roomiest first: every button's words, the first one's alone, icons with their hovers, then less padding. */
const CARD_FITS: readonly CardFit[] = ['full', 'lead', 'icons', 'tight'];

/**
 * Recent, Local, Remote and Tags: which kind of branch the list below shows,
 * styled as GitTree's other tab strips. The row is what the keyboard reaches
 * (Left and Right switch, as on a tab strip); the tabs themselves are for the
 * pointer, and a press on one leaves focus where it was until the click lands.
 */
export function TabsRow({
  row,
  onSelect,
}: {
  row: Extract<PanelRow, { kind: 'tabs' }>;
  onSelect: (tab: BranchTab) => void;
}) {
  // The counts go first, then some padding, so a narrow sidebar never cuts the last tab off.
  const [stripRef, fit] = useFit(TABS_FITS, row.tabs.map((t) => `${t.id}:${t.count}`).join(','));
  return (
    <div ref={stripRef} className="gtp-tabs" data-fit={fit} role="tablist" aria-label="Branches to show">
      {row.tabs.map((tab) => {
        const selected = tab.id === row.active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={selected}
            title={tabTitle(tab)}
            className={`gt-tab gtp-tab${selected ? ' gt-active' : ''}`}
            data-tab={tab.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(tab.id)}
          >
            <span className="gt-tab-label">{tab.label}</span>
            <span className="gtp-tab-count">{tab.count}</span>
          </button>
        );
      })}
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
  const elsewhere =
    repo.head !== undefined ? upstreamElsewhere(repo, repo.head, repo.upstream, repo.upstreamGone) : undefined;
  const hint = repoHint(row);
  return (
    <div className={`gtp-repo${dim ? ' gtp-out-of-scope' : ''}`} title={`${repo.root}
${hint}`}>
      <span
        className={`gtp-dot${row.inScope ? ' gtp-dot-on' : ''}`}
        style={{ '--gtp-repo': color } as CSSProperties}
        aria-hidden="true"
      />
      <span className="gtp-repo-name">{repo.label}</span>
      <span
        className="gtp-repo-head"
        title={
          elsewhere !== undefined
            ? elsewhereTitle(elsewhere)
            : repo.upstream !== undefined
              ? `Tracks ${repo.upstream}`
              : undefined
        }
      >
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
  const elsewhere = row.entry?.tracksElsewhere;
  const twin = repo.head !== undefined ? remoteTwin(repo, repo.head) : undefined;
  return (
    <div className="gtp-head-wrap">
      <div className="gtp-head">
        <span className="gtp-twisty">
          <Codicon name={row.card ? 'chevron-down' : 'chevron-right'} />
        </span>
        <Codicon name={onBranch ? 'check' : 'git-commit'} className="gtp-icon gtp-current-icon" />
        <span className="gtp-head-name">{headText(repo)}</span>
        {repo.upstream !== undefined ? (
          <span
            className={`gtp-dim gtp-head-upstream${
              repo.upstreamGone === true ? ' gtp-gone-text' : elsewhere !== undefined ? ' gtp-elsewhere' : ''
            }`}
            title={elsewhere !== undefined ? elsewhereTitle(elsewhere) : `Tracks ${repo.upstream}`}
          >
            {repo.upstreamGone === true
              ? `${repo.upstream} (gone)`
              : elsewhere !== undefined
                ? `→ ${elsewhere}`
                : repo.upstream}
          </span>
        ) : onBranch && !repo.unborn ? (
          <span className="gtp-dim gtp-head-upstream">
            {twin !== undefined ? `not tracking ${twin}` : 'not published'}
          </span>
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
  // IntelliJ's toolbar names a merge's button for what it does: Commit Merge
  // commits at once, with git's prepared message (POST-QA: "Continue" did the
  // same unannounced).
  const isMerge = op.kind === 'merge';
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
          onClick={() => onRun('gittree.conflicts.resolve')}
        >
          <Codicon name="git-merge" />
          <span className="gtp-button-label">Resolve…</span>
        </button>
      ) : null}
      <button
        type="button"
        className="gt-button gt-primary gtp-small"
        tabIndex={-1}
        title={
          isMerge
            ? "Commit the merge with Git's prepared message. To write your own, commit from the Commit window."
            : `Continue the ${verb.toLowerCase().replace(/ing$/u, 'e')}`
        }
        onClick={() => onRun(isRebase ? 'gittree.rebase.continue' : 'gittree.merge.continueOp')}
      >
        <Codicon name="debug-continue" />
        <span className="gtp-button-label">{isMerge ? 'Commit Merge' : 'Continue'}</span>
      </button>
      {isRebase ? (
        // IntelliJ's rebase toolbar keeps Skip Commit beside Continue; the
        // pause toast that offered it here is gone (POST-QA).
        <button
          type="button"
          className="gt-button gtp-small"
          tabIndex={-1}
          title="Skip this commit and go on with the rebase"
          onClick={() => onRun('gittree.rebase.skip')}
        >
          <Codicon name="debug-step-over" />
          <span className="gtp-button-label">Skip</span>
        </button>
      ) : null}
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

/**
 * Which repositories in view have the branch, in words (POST-P14bt): `in api, web`,
 * `in all 20`. A decoration in the Repository Dots' place, between the counts and the age,
 * so it comes after the hover buttons and holds still when they show, and its right edge
 * lines up with the next row's. A narrow sidebar gets the short form (`in 2`), a narrower
 * one none; the row's hover always names every repository.
 */
function Where({ where }: { where: RowWhere }) {
  return (
    <span className="gtp-where">
      <span className="gtp-where-text">{where.text}</span>
      <span className="gtp-where-short">{where.short}</span>
    </span>
  );
}

export interface BranchRowProps {
  readonly row: Extract<PanelRow, { kind: 'branch' }>;
  readonly now: number;
  readonly showInOut: boolean;
  /**
   * Draw the Repository Dots: several repositories in view, and the toggle on. They say
   * where the branch is in place of the row's words, which would only say it twice.
   */
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
  const { entry, where } = row;
  const current = entry.currentIn.length > 0;
  const partial = current && !isCurrentEverywhere(entry);
  const age = shortAge(now, entry.date);
  // Its name, where it is (every repository named, whatever the row had room for), its
  // last commit, then what the pointer can do with it.
  const title = [
    entry.name,
    ...(where !== undefined ? [where.title] : []),
    ...(entry.subject !== undefined ? [entry.subject] : []),
    `Double-click or Enter for details · right-click for every action${
      draggable ? ' · drag onto another branch to merge or rebase' : ''
    }`,
  ].join('\n');
  return (
    <div className="gtp-branch-wrap">
      <div
        className={`gtp-branch${current ? ' gtp-is-current' : ''}${partial ? ' gtp-partial' : ''}`}
        style={{ paddingLeft: 8 + row.depth * INDENT }}
        title={title}
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
        {entry.tracksElsewhere !== undefined ? (
          <span className="gtp-chip gtp-elsewhere" title={elsewhereTitle(entry.tracksElsewhere)}>
            → {entry.tracksElsewhere}
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
        {/* The hover buttons come before the counts, the repositories (words or
            dots) and the age, as VS Code puts a row's actions before its
            decorations: they take the free space (or the end of a long name),
            and nothing to their right moves, on any row, hovered or selected. */}
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
        {showInOut && entry.kind === 'local' ? <SyncCounts ahead={entry.ahead} behind={entry.behind} /> : null}
        {/* Where it is: in words, or with Repository Dots on, a dot per repository, in the same place. */}
        {where !== undefined && !markers ? <Where where={where} /> : null}
        {markers ? <Markers entry={entry} repos={scopeRepos} colorOf={colorOf} /> : null}
        <span className="gtp-age" title={entry.date !== undefined ? longAge(now, entry.date) : undefined}>
          {age}
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
  /** What the card says, line by line: the model built them, and sized the card by them. */
  readonly lines: readonly CardLine[];
  readonly details: BranchPanelDetailsDto | undefined;
  /** More than one repository in view: a line that speaks of one repository names it. */
  readonly markers: boolean;
  readonly now: number;
  readonly indent: number;
  readonly colorOf: (repo: BranchPanelRepoDto) => string;
  readonly onButton: (button: BranchPanelButtonDto) => void;
  readonly onMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Stops the branch tracking its upstream, in `roots` alone when it names some. */
  readonly onStopTracking: (roots?: readonly string[]) => void;
  /** Opens or shuts a group's list of its repositories. */
  readonly onToggleGroup: (key: string) => void;
  /** Detached HEAD: there is no branch to describe. */
  readonly detachedAt?: string;
  /** The button whose action is running: it spins until the host is done. */
  readonly running?: string;
}

function StopTracking({ upstream, onClick }: { upstream: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="gtp-link gtp-stop-tracking"
      title={`Stop tracking ${upstream}. The branch and the remote branch both stay.`}
      onClick={onClick}
    >
      Stop tracking
    </button>
  );
}

function RepoDot({ repo, state, colorOf }: { repo: BranchPanelRepoDto; state: 'current' | 'has' | 'none'; colorOf: (repo: BranchPanelRepoDto) => string }) {
  return (
    <span
      className="gtp-marker"
      data-state={state}
      style={{ '--gtp-repo': colorOf(repo) } as CSSProperties}
    />
  );
}

/** What a group's repositories share, after its label: `checked out · up to date · 2 ahead of current`. */
function GroupFacts({
  group,
  onStopTracking,
}: {
  group: CardGroup;
  onStopTracking: (roots: readonly string[]) => void;
}) {
  if (group.missing) return null;
  const rest = [group.tracking, ...(group.relation !== undefined ? [group.relation] : [])].join(' · ');
  return (
    <>
      <span className="gtp-ellipsis gtp-dim">
        {group.current ? 'checked out · ' : ''}
        {group.elsewhere !== undefined ? (
          <span className="gtp-elsewhere" title={elsewhereTitle(group.elsewhere)}>
            → {group.elsewhere} ·{' '}
          </span>
        ) : null}
        {rest}
      </span>
      {group.elsewhere !== undefined ? (
        <StopTracking
          upstream={group.elsewhere}
          onClick={() => onStopTracking(group.repos.map((r) => r.root))}
        />
      ) : null}
    </>
  );
}

/**
 * What a branch is, under its row: its last commit, where it stands against
 * what it tracks and against what is checked out, and the few actions that
 * fit. The model decides the lines (`cardLines`) and sizes the card by them;
 * this draws them. With several repositories in view, repositories that say
 * the same are one line, the ones lacking the branch another, and a group too
 * large to name lists its repositories when its count is clicked.
 */
export function BranchCard({
  entry,
  lines,
  details,
  markers,
  now,
  indent,
  colorOf,
  onButton,
  onMenu,
  onStopTracking,
  onToggleGroup,
  detachedAt,
  running,
}: CardProps) {
  // Too narrow for every button's words: the first keeps its own, then only
  // icons, each with its hover. Shrunk together, they read `U…`, `P…`.
  const [buttonsRef, buttonsFit] = useFit(
    CARD_FITS,
    `${(details?.buttons ?? []).map((b) => b.label).join('|')}|${details === undefined ? 'loading' : ''}`,
  );
  const presence = entry?.presence[0];
  const repoDetails = details?.repos[0];
  const drawn = lines.map((line, i) => {
    switch (line.kind) {
      case 'detached':
        return (
          <div key={i} className="gtp-card-line">
            <Codicon name="git-commit" />
            <span className="gtp-ellipsis">HEAD is detached at {detachedAt ?? 'a commit'}</span>
          </div>
        );
      case 'detachedHint':
        return (
          <div key={i} className="gtp-card-line gtp-dim">
            <span className="gtp-ellipsis">Check out a branch, or start one here.</span>
          </div>
        );
      case 'commit': {
        const newest =
          details?.repos.find((r) => r.date !== undefined && r.author !== undefined) ?? details?.repos[0];
        const age = longAge(now, newest?.date ?? entry?.date);
        return (
          <div key={i} className="gtp-card-line">
            <Codicon name="git-commit" />
            <span className="gtp-ellipsis gtp-subject" title={entry?.subject}>
              {entry?.subject ?? '…'}
            </span>
            <span className="gtp-card-meta" title={newest?.author !== undefined ? `${newest.author} · ${age}` : age}>
              {newest?.author !== undefined ? <span className="gtp-card-author">{newest.author} · </span> : null}
              {age}
            </span>
          </div>
        );
      }
      case 'tracking': {
        if (entry === undefined || presence === undefined) return <div key={i} className="gtp-card-line" />;
        const merged = entry.merged ? ` · merged into ${presence.repo.mainBranch ?? 'the main branch'}` : '';
        const elsewhere = entry.tracksElsewhere;
        const twin = entry.kind === 'local' ? remoteTwin(presence.repo, entry.name) : undefined;
        return (
          <div key={i} className="gtp-card-line">
            {markers ? (
              // Several repositories in view and one with the branch: say which.
              <>
                <RepoDot
                  repo={presence.repo}
                  state={presence.ref.current === true ? 'current' : 'has'}
                  colorOf={colorOf}
                />
                <span className="gtp-card-repo">{presence.repo.label}</span>
              </>
            ) : (
              <Codicon name={entry.kind === 'tag' ? 'tag' : 'cloud'} />
            )}
            <span
              className={`gtp-ellipsis${elsewhere !== undefined ? ' gtp-elsewhere' : ''}`}
              title={elsewhere !== undefined ? elsewhereTitle(elsewhere) : undefined}
            >
              {trackingText(presence.ref, entry.kind, repoDetails?.trackedBy, twin)}
              {merged}
            </span>
            {presence.ref.upstream !== undefined ? (
              <StopTracking upstream={presence.ref.upstream} onClick={() => onStopTracking()} />
            ) : null}
          </div>
        );
      }
      case 'relation':
        return (
          <div key={i} className="gtp-card-line">
            <Codicon name="git-compare" />
            <span className="gtp-ellipsis gtp-dim">{relationText(repoDetails) ?? (details ? '' : '…')}</span>
          </div>
        );
      case 'group': {
        const { group } = line;
        const state = group.missing ? 'none' : group.current ? 'current' : 'has';
        return (
          <div
            key={i}
            className={`gtp-card-line gtp-card-group${group.missing ? ' gtp-card-missing' : ''}`}
            title={group.repos.map((r) => r.label).join('\n')}
          >
            <span className="gtp-card-dots">
              {group.repos.map((repo) => (
                <RepoDot key={repo.root} repo={repo} state={state} colorOf={colorOf} />
              ))}
            </span>
            {line.expandable ? (
              <button
                type="button"
                className="gtp-card-repo gtp-group-toggle"
                aria-expanded={line.open}
                title={`${line.open ? 'Hide' : 'List'} the ${group.repos.length} repositories`}
                onClick={() => onToggleGroup(group.key)}
              >
                <span className="gtp-ellipsis">{line.label}</span>
                <Codicon name={line.open ? 'chevron-down' : 'chevron-right'} />
              </button>
            ) : (
              <span className="gtp-card-repo">{line.label}</span>
            )}
            <GroupFacts group={group} onStopTracking={(roots) => onStopTracking(roots)} />
          </div>
        );
      }
      case 'member': {
        const state = line.group.missing ? 'none' : line.group.current ? 'current' : 'has';
        return (
          <div key={i} className="gtp-card-line gtp-card-member">
            <RepoDot repo={line.repo} state={state} colorOf={colorOf} />
            <span className="gtp-ellipsis">{line.repo.label}</span>
          </div>
        );
      }
    }
  });
  return (
    <div className="gtp-card" style={{ marginLeft: indent }} onClick={(e) => e.stopPropagation()}>
      {drawn}
      <div ref={buttonsRef} className="gtp-card-buttons" data-fit={buttonsFit}>
        {(details?.buttons ?? []).map((button, i) => {
          const busy = running === button.label;
          return (
            <button
              key={`${button.label}-${i}`}
              type="button"
              className={`gt-button gtp-card-button${i === 0 ? ' gt-primary' : ''}`}
              title={button.title}
              aria-label={button.label}
              aria-busy={busy ? true : undefined}
              disabled={running !== undefined}
              onClick={() => onButton(button)}
            >
              <Codicon name={busy ? 'loading' : button.icon} spin={busy} />
              <span className="gtp-button-label">{button.label}</span>
            </button>
          );
        })}
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
