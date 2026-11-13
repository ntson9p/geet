/**
 * Which of a toolbar's actions stay on its row when the row is short of room
 * (POST-P14ca). The rest go into a `⋯` menu at the row's end, as VS Code's own
 * toolbars fold theirs. Pure, so what a width keeps is testable without a page.
 */

export interface FitAction {
  readonly id: string;
  /** Lower stays longer: 0 is the last to fold into the menu. */
  readonly priority: number;
}

export interface ToolbarFit {
  /** On the row, in the actions' own order. */
  readonly shown: readonly string[];
  /** In the `⋯` menu, in the actions' own order. Empty when everything fits. */
  readonly more: readonly string[];
}

/**
 * The actions that fit in `available` px, each button `button` px wide with
 * `gap` px between. All of them when they all fit; otherwise the ones wanted
 * most, leaving a button's room for the `⋯` that holds the others. An unknown
 * width (0, before the row is laid out) keeps everything, so a first frame
 * never flashes a lone `⋯`.
 */
export function toolbarFit(
  actions: readonly FitAction[],
  available: number,
  button: number,
  gap: number,
): ToolbarFit {
  const ids = actions.map((a) => a.id);
  const width = (n: number): number => (n <= 0 ? 0 : n * button + (n - 1) * gap);
  if (available <= 0 || width(actions.length) <= available) return { shown: ids, more: [] };
  // Every button kept on the row costs its width and a gap; the `⋯` its width.
  const slots = Math.max(0, Math.floor((available - button) / (button + gap)));
  const kept = new Set(
    actions
      .map((a, order) => ({ a, order }))
      .sort((x, y) => x.a.priority - y.a.priority || x.order - y.order)
      .slice(0, slots)
      .map((x) => x.a.id),
  );
  return {
    shown: ids.filter((id) => kept.has(id)),
    more: ids.filter((id) => !kept.has(id)),
  };
}
