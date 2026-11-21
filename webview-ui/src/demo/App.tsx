/**
 * P0-T9 demo app: exercises every kit piece — theme variables, codicons,
 * Toolbar/FilterChip, VirtualList @100k rows, RPC echo, state persistence,
 * data-vscode-context. Opened by "Geet: Open Webview Demo (Debug)".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_METHODS } from '../../../src/shared/protocol';
import { VsCodeContext } from '../lib/context';
import { RpcClient } from '../lib/rpc';
import { FilterChip, Toolbar, ToolbarButton } from '../lib/Toolbar';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';
import { getVsCodeApi } from '../lib/vscodeApi';

const ROW_COUNT = 100_000;
const ROW_HEIGHT = 22;

interface DemoState {
  filterOn?: boolean;
  focused?: number;
}

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const theme = useVsCodeTheme();
  const listRef = useRef<VirtualListHandle>(null);
  const saved = (getVsCodeApi().getState() as DemoState | undefined) ?? {};
  const [filterOn, setFilterOn] = useState(saved.filterOn ?? false);
  const [echoResult, setEchoResult] = useState<string>('');
  const [focused, setFocused] = useState(saved.focused ?? 0);

  useEffect(() => {
    getVsCodeApi().setState({ filterOn, focused } satisfies DemoState);
  }, [filterOn, focused]);

  const runEcho = (): void => {
    const payload = `ping @ ${new Date().toISOString()}`;
    rpc.request<{ echoed: string }>(DEMO_METHODS.echo, { text: payload }).then(
      (r) => setEchoResult(r.echoed),
      (e: Error) => setEchoResult(`error: ${e.message}`),
    );
  };

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Toolbar ariaLabel="Demo toolbar">
        <ToolbarButton icon="rocket" label="Echo over RPC" showLabel onClick={runEcho} />
        <FilterChip label="Even rows only" active={filterOn} onToggle={setFilterOn} />
        <ToolbarButton
          icon="arrow-down"
          label="Jump to row 99,999"
          onClick={() => listRef.current?.focusIndex(ROW_COUNT - 1)}
        />
        <ToolbarButton
          icon="arrow-up"
          label="Jump to top"
          onClick={() => listRef.current?.focusIndex(0)}
        />
      </Toolbar>

      <div data-testid="theme-banner">
        Theme: <strong>{theme}</strong> — background/foreground come from
        <code> --vscode-* </code> variables. <span className="codicon codicon-git-branch" aria-hidden="true" />
      </div>

      <div aria-live="polite" data-testid="echo-result">
        {echoResult}
      </div>

      <VsCodeContext
        context={{ webview: 'geet-demo', area: 'list' }}
        preventDefaults={false}
      >
        <VirtualList
          ref={listRef}
          rowCount={ROW_COUNT}
          rowHeight={ROW_HEIGHT}
          height={400}
          ariaLabel="Demo rows"
          onFocusIndex={setFocused}
          rowContext={(i) => ({ row: i })}
          renderRow={(i) => (
            <span data-testid={`row-${i}`} style={filterOn && i % 2 === 1 ? { opacity: 0.35 } : undefined}>
              <span className="codicon codicon-git-commit" aria-hidden="true" />{' '}
              row {i.toLocaleString('en-US')}
            </span>
          )}
        />
      </VsCodeContext>
      <div data-testid="focus-readout">focused: {focused}</div>
    </div>
  );
}
