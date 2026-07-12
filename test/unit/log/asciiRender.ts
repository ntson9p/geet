/**
 * Test-only ASCII renderer for GraphRow[] (P4-T2 step 4): git-log-graph
 * style, two lines per row — lanes occupy every second column ('| | |'),
 * connectors use '/', '\' and '_'. Golden snapshots make layout regressions
 * reviewable.
 */
import type { GraphRow } from '../../../src/log/graphLayout/layout';

export function renderAscii(rows: readonly GraphRow[], labelOf?: (sha: string) => string): string {
  const laneMax = rows.reduce(
    (w, r) =>
      Math.max(
        w,
        r.nodeLane + 1,
        ...r.lanesBefore.map((l) => l.lane + 1),
        ...r.forks.map((f) => f.lane + 1),
        ...r.continues.map((c) => c.lane + 1),
      ),
    1,
  );
  const width = laneMax * 2 - 1;
  const col = (lane: number): number => lane * 2;
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as GraphRow;

    // --- node line ---
    // Join lanes already bent into the node on the connector ABOVE — their
    // vertical must not reappear on this line.
    const joinLanes = new Set(row.joins.map((j) => j.lane));
    const node = Array.from({ length: width }, () => ' ');
    for (const l of row.lanesBefore) {
      if (!joinLanes.has(l.lane)) node[col(l.lane)] = '|';
    }
    node[col(row.nodeLane)] = '*';
    const label = labelOf ? ` ${labelOf(row.sha)}` : ` ${row.sha}`;
    lines.push(node.join('').replace(/\s+$/, '') + label);

    if (i === rows.length - 1) break;

    // --- connector line (between this row and the next) ---
    const next = rows[i + 1] as GraphRow;
    const conn = Array.from({ length: width }, () => ' ');
    const put = (c: number, ch: string): void => {
      if (c < 0 || c >= width) return;
      if (conn[c] === ' ' || (conn[c] === '_' && ch !== '_')) conn[c] = ch;
    };

    // Where does each post-row lane head at the next row?
    const nextJoins = new Set(next.joins.map((j) => j.lane));
    const active = [
      ...row.forks.filter((f) => f.kind === 'first').map((f) => f.lane),
      ...row.continues.map((c) => c.lane),
      // Newborn extra-parent lanes start AT the node — no vertical yet.
      ...row.forks.filter((f) => f.kind === 'extra' && f.joinsExisting === true).map((f) => f.lane),
    ];
    const seen = new Set<number>();
    for (const lane of active) {
      if (seen.has(lane)) continue;
      seen.add(lane);
      const target = nextJoins.has(lane) || lane === next.nodeLane ? next.nodeLane : lane;
      if (target === lane) {
        put(col(lane), '|');
      } else if (target < lane) {
        put(col(lane) - 1, '/');
        for (let c = col(target) + 1; c < col(lane) - 1; c++) put(c, '_');
      } else {
        put(col(lane) + 1, '\\');
        for (let c = col(lane) + 2; c < col(target); c++) put(c, '_');
      }
    }
    // Node fanning out to extra-parent lanes happens on this connector too.
    // The diagonal anchors next to the TARGET lane so it flows into the
    // vertical that starts on the following row.
    for (const fork of row.forks) {
      if (fork.kind !== 'extra' || fork.lane === row.nodeLane) continue;
      put(fork.lane > row.nodeLane ? col(fork.lane) - 1 : col(fork.lane) + 1, fork.lane > row.nodeLane ? '\\' : '/');
    }

    lines.push(conn.join('').replace(/\s+$/, ''));
  }
  return lines.filter((l, idx) => !(l.length === 0 && idx % 2 === 1)).join('\n');
}
