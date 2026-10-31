/**
 * Git tool window (P12-T1, P12-T8, POST-P14k): the tab strip and whichever tab
 * is in front. The strip is IntelliJ's: `Log`, `Console`, `Worktrees`, then
 * any extra Log tabs in the order they were opened, each with a `×`, and `+`
 * (`Open Another Log Tab`) after the last. Right-clicking a tab offers Close
 * Tab / Close Other Tabs / Close All Tabs; only the extra Log tabs ever close.
 *
 * The host owns the Log tabs: it opens them for File History, Compare with
 * Current and an update's Show in Log, and keeps them across restarts. The
 * strip asks for the list once and then follows `evtTabs`. A Log tab is
 * mounted the first time it is shown and kept from then on, so a tab restored
 * after a restart costs nothing until it is looked at, and one already seen
 * keeps its rows, selection and scroll when another is in front. The active
 * Log tab, the one commands act on, is always mounted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LOG_PRESENTATION,
  LOG_METHODS,
  type LogPresentationDto,
  type LogTabDto,
  type LogTabsDto,
} from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { RpcClient } from '../lib/rpc';
import { TabPanel, Tabs, type TabDef } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { getVsCodeApi } from '../lib/vscodeApi';
import { ConsolePane } from './ConsolePane';
import { LogTab, type LogTabUiState } from './LogTab';
import {
  FIXED_TABS,
  MAIN_LOG_TAB,
  afterClose,
  closeTargets,
  stripOrder,
  tabTitle,
  type CloseAction,
} from './logTabsModel';
import type { ShellLayout } from './Shell';
import { WorktreesPane } from './WorktreesPane';

interface PersistedState {
  /** Before tabs, the single log kept these at the top level; read once for the main tab. */
  filter?: LogTabUiState['filter'];
  focusSha?: string;
  layout?: ShellLayout;
  filesRollup?: boolean;
  previewOnClick?: boolean;
  highlightMine?: boolean;
  /** The strip item in front: a Log tab id, `console` or `worktrees`. */
  tab?: string;
  /** Each Log tab's focus and layout. */
  tabsUi?: Record<string, LogTabUiState>;
}

/** Until the host answers `log/tabs` (or if it cannot): the main tab alone. */
const MAIN_ONLY: LogTabDto[] = [{ id: MAIN_LOG_TAB, filter: { sort: 'date', refs: 'HEAD' }, closable: false }];

const isFixed = (id: string): boolean => (FIXED_TABS as readonly string[]).includes(id);

function readState(): PersistedState {
  return (getVsCodeApi().getState() as PersistedState | undefined) ?? {};
}

/** A whole `LogPresentationDto`, or nothing: a stray `{ ok: true }` must not blank both toggles. */
function asPresentation(value: unknown): LogPresentationDto | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { showTagNames, showTags } = value as Partial<LogPresentationDto>;
  return typeof showTagNames === 'boolean' && typeof showTags === 'boolean'
    ? { showTagNames, showTags }
    : undefined;
}

/** A usable tab list, or nothing (a host from before tabs answers `{ ok: true }`). */
function asTabs(value: unknown): LogTabsDto | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const dto = value as Partial<LogTabsDto>;
  if (!Array.isArray(dto.tabs) || typeof dto.active !== 'string') return undefined;
  const tabs = dto.tabs.filter(
    (t): t is LogTabDto => t !== null && typeof t === 'object' && typeof t.id === 'string',
  );
  if (!tabs.some((t) => t.id === MAIN_LOG_TAB)) return undefined;
  return { tabs, active: dto.active, ...(typeof dto.show === 'string' ? { show: dto.show } : {}) };
}

/** The Log tab an event names (no `logTab` means the main tab). */
function logTabOf(params: unknown): string {
  const tab = (params as { logTab?: unknown } | undefined)?.logTab;
  return typeof tab === 'string' ? tab : MAIN_LOG_TAB;
}

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';
  const boot = useMemo(readState, []);

  const [tabs, setTabs] = useState<LogTabDto[]>(MAIN_ONLY);
  /** The strip item in front: a Log tab id, `console` or `worktrees`. */
  const [strip, setStrip] = useState<string>(boot.tab ?? MAIN_LOG_TAB);
  /** The Log tab commands act on: the last one shown. */
  const [activeLog, setActiveLog] = useState<string>(MAIN_LOG_TAB);
  /** Log tabs shown at least once, kept mounted so they keep their place. */
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  /** Nothing mounts before the host has said which tabs exist. */
  const [ready, setReady] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  // Tag Names and Show Tags. Settings, not view state, so the host owns them:
  // they arrive with each tab's `init`/`reset` and on `evtPresentation`.
  const [presentation, setPresentation] = useState<LogPresentationDto>(DEFAULT_LOG_PRESENTATION);
  // Pane preferences: one for the window, the same in every Log tab.
  const [filesRollup, setFilesRollup] = useState(boot.filesRollup ?? true);
  const [previewOnClick, setPreviewOnClick] = useState(boot.previewOnClick ?? false);
  const [highlightMine, setHighlightMine] = useState(boot.highlightMine ?? false);

  // Callbacks registered once read the current values through these.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const activeLogRef = useRef(activeLog);
  activeLogRef.current = activeLog;

  useEffect(() => {
    const prev = readState();
    getVsCodeApi().setState({ ...prev, filesRollup, previewOnClick, highlightMine, tab: strip });
  }, [filesRollup, highlightMine, previewOnClick, strip]);

  /**
   * Brings a strip item forward. A Log tab is mounted the first time and
   * becomes the one commands act on; `tell: false` when the host already
   * knows (it picked the tab itself).
   */
  const show = useCallback(
    (id: string, opts?: { tell?: boolean }) => {
      setStrip(id);
      if (isFixed(id)) return;
      setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setActiveLog(id);
      if (opts?.tell !== false) {
        void rpc.request(LOG_METHODS.activateTab, { logTab: id }).catch(() => undefined);
      }
    },
    [rpc],
  );

  useEffect(() => {
    let disposed = false;
    rpc.request<unknown>(LOG_METHODS.tabs).then(
      (raw) => {
        if (disposed) return;
        const dto = asTabs(raw) ?? { tabs: MAIN_ONLY, active: MAIN_LOG_TAB };
        setTabs(dto.tabs);
        setActiveLog(dto.active);
        const known = (id: string | undefined): id is string =>
          id !== undefined && (isFixed(id) || dto.tabs.some((t) => t.id === id));
        // Something asked for a tab before this view could hear it (POST-P14af),
        // else the item that was in front before the reload, else the host's.
        const first = known(dto.show) ? dto.show : known(boot.tab) ? boot.tab : dto.active;
        show(first, { tell: !isFixed(first) && first !== dto.active });
        setReady(true);
      },
      () => {
        if (disposed) return;
        show(MAIN_LOG_TAB, { tell: false });
        setReady(true);
      },
    );

    const offTabs = rpc.onEvent(LOG_METHODS.evtTabs, (params) => {
      const dto = asTabs(params);
      if (!dto) return;
      setTabs(dto.tabs);
      const alive = (id: string): boolean => dto.tabs.some((t) => t.id === id);
      setMounted((prev) => {
        const kept = [...prev].filter(alive);
        return kept.length === prev.size ? prev : new Set(kept);
      });
      if (dto.show !== undefined) {
        // A command opened or picked this tab; the host already made it active.
        show(dto.show, { tell: false });
        return;
      }
      if (!alive(activeLogRef.current)) setActiveLog(dto.active);
      if (!isFixed(stripRef.current) && !alive(stripRef.current)) setStrip(dto.active);
    });
    // POST-P14af: a push notification's `Show Details` lands on the Console.
    const offShowTab = rpc.onEvent(LOG_METHODS.evtShowTab, (params) => {
      const tab = (params as { tab?: unknown } | undefined)?.tab;
      if (typeof tab === 'string') show(tab, { tell: false });
    });
    // A reveal or a focus-the-filter is about a Log tab, which then has to be in front.
    const offReveal = rpc.onEvent(LOG_METHODS.evtReveal, (params) => show(logTabOf(params), { tell: false }));
    const offFocus = rpc.onEvent(LOG_METHODS.evtFocusFilter, (params) =>
      show(logTabOf(params), { tell: false }),
    );
    // Tag Names / Show Tags changed, here or in the Settings editor. Only the
    // drawing changes: the rows, the selection and the scroll stay.
    const offPresentation = rpc.onEvent(LOG_METHODS.evtPresentation, (params) => {
      const next = asPresentation(params);
      if (next) setPresentation(next);
    });
    return () => {
      disposed = true;
      offTabs();
      offShowTab();
      offReveal();
      offFocus();
      offPresentation();
    };
    // Boot effect: intentionally runs once per rpc instance.
  }, [rpc]); // `show` and `boot` are stable for the boot path

  /** A toggle in either settings menu: drawn at once, then confirmed by the host. */
  const changePresentation = useCallback(
    (patch: Partial<LogPresentationDto>) => {
      setPresentation((prev) => ({ ...prev, ...patch }));
      rpc.request<unknown>(LOG_METHODS.setPresentation, patch).then(
        (res) => {
          const next = asPresentation(res);
          if (next) setPresentation(next);
        },
        () => undefined,
      );
    },
    [rpc],
  );

  /** IntelliJ's `+`: a new tab matching the current Log tab's filters, shown at once. */
  const openAnother = useCallback(() => {
    rpc.request<{ logTab?: unknown }>(LOG_METHODS.openTab, { from: activeLogRef.current }).then(
      (res) => {
        if (typeof res?.logTab === 'string') show(res.logTab, { tell: false });
      },
      () => undefined,
    );
  }, [rpc, show]);

  /** `×`, middle-click, and the tab menu: gone at once, the host told after. */
  const closeLogTabs = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const gone = new Set(ids);
      const next = afterClose(stripOrder(tabsRef.current), stripRef.current, ids);
      setTabs((prev) => prev.filter((t) => !gone.has(t.id)));
      setMounted((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      const state = readState();
      if (state.tabsUi !== undefined) {
        const tabsUi = Object.fromEntries(Object.entries(state.tabsUi).filter(([id]) => !gone.has(id)));
        getVsCodeApi().setState({ ...state, tabsUi });
      }
      // Sent first, so the host's own fallback (the main tab) is overridden by
      // the tab actually brought forward, below.
      void rpc.request(LOG_METHODS.closeTabs, { tabs: ids }).catch(() => undefined);
      if (gone.has(activeLogRef.current)) setActiveLog(MAIN_LOG_TAB);
      if (next !== stripRef.current || !isFixed(next)) show(next, { tell: !isFixed(next) });
    },
    [rpc, show],
  );

  const uiFor = (id: string): LogTabUiState => {
    const state = readState();
    const own = state.tabsUi?.[id];
    if (own !== undefined) return own;
    if (id !== MAIN_LOG_TAB) return {};
    // The single log's state, from before tabs.
    return {
      ...(state.focusSha !== undefined ? { focusSha: state.focusSha } : {}),
      ...(state.layout !== undefined ? { layout: state.layout } : {}),
      ...(state.filter !== undefined ? { filter: state.filter } : {}),
    };
  };

  const saveUi = (id: string, patch: Partial<LogTabUiState>): void => {
    const state = readState();
    const tabsUi = state.tabsUi ?? {};
    getVsCodeApi().setState({ ...state, tabsUi: { ...tabsUi, [id]: { ...tabsUi[id], ...patch } } });
  };

  const stripTabs: TabDef[] = stripOrder(tabs).map((id) => {
    if (id === 'console') return { id, label: 'Console' };
    if (id === 'worktrees') return { id, label: 'Worktrees' };
    const tab = tabs.find((t) => t.id === id);
    const title = tab !== undefined ? tabTitle(tab.filter) : 'Log';
    return { id, label: title, title, closable: tab?.closable === true };
  });

  const menuItems = (id: string): MenuItem[] => [
    { kind: 'item', id: 'close', label: 'Close Tab', disabled: closeTargets(tabs, id, 'close').length === 0 },
    {
      kind: 'item',
      id: 'others',
      label: 'Close Other Tabs',
      disabled: closeTargets(tabs, id, 'others').length === 0,
    },
    { kind: 'item', id: 'all', label: 'Close All Tabs', disabled: closeTargets(tabs, id, 'all').length === 0 },
  ];

  const logIds = tabs.map((t) => t.id).filter((id) => mounted.has(id) || id === activeLog);

  return (
    <div className="gt-log-root">
      <Tabs
        ariaLabel="Git tool window"
        active={strip}
        onChange={(id) => show(id)}
        tabs={stripTabs}
        onClose={(id) => closeLogTabs([id])}
        onTabContextMenu={(id, at) => setTabMenu({ id, at })}
        trailing={<ToolbarButton icon="add" label="Open Another Log Tab" onClick={openAnother} />}
      />
      {tabMenu !== null ? (
        <Menu
          items={menuItems(tabMenu.id)}
          at={tabMenu.at}
          ariaLabel="Tab actions"
          onClose={() => setTabMenu(null)}
          onSelect={(action) => closeLogTabs(closeTargets(tabs, tabMenu.id, action as CloseAction))}
        />
      ) : null}
      <TabPanel id="worktrees" active={strip} className="gt-log-tabpanel">
        <WorktreesPane rpc={rpc} />
      </TabPanel>
      <TabPanel id="console" active={strip} className="gt-log-tabpanel">
        <ConsolePane
          rpc={rpc}
          onCopy={(text: string) => void rpc.request(LOG_METHODS.copy, { text })}
        />
      </TabPanel>
      {ready
        ? logIds.map((id) => (
            // Hidden, not unmounted, so a tab keeps its place behind another.
            <div
              key={id}
              role="tabpanel"
              id={`gt-tabpanel-${id}`}
              aria-labelledby={`gt-tab-${id}`}
              aria-hidden={id === strip ? undefined : true}
              className={`gt-tabpanel gt-log-tabpanel${id === strip ? '' : ' gt-tab-behind'}`}
              data-testid={`log-tab-${id}`}
            >
              <LogTab
                rpc={rpc}
                tabId={id}
                visible={id === strip}
                dark={dark}
                presentation={presentation}
                onPresentationChange={changePresentation}
                onPresentationSeen={setPresentation}
                filesRollup={filesRollup}
                onFilesRollupChange={setFilesRollup}
                previewOnClick={previewOnClick}
                onPreviewOnClickChange={setPreviewOnClick}
                highlightMine={highlightMine}
                onHighlightMineChange={setHighlightMine}
                saved={uiFor(id)}
                onSave={(patch) => saveUi(id, patch)}
              />
            </div>
          ))
        : null}
    </div>
  );
}
