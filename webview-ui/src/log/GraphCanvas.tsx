/**
 * Graph canvas layer (P4-T3): one viewport-sized <canvas> overlaying the row
 * list, redrawn per scroll frame — lanes, joins, forks and nodes for the
 * visible rows only (≤ 8 ms/frame budget).
 */
import { useEffect, useRef } from 'react';
import type { GraphRowDto } from '../../../src/shared/protocol';
import { GRAPH_HUES } from '../../../src/log/graphLayout/colors';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';

export interface GraphViewport {
  scrollTop: number;
  first: number;
  last: number;
}

export function laneColor(colorIdx: number, dark: boolean): string {
  const hue = GRAPH_HUES[colorIdx % GRAPH_HUES.length] ?? 210;
  return dark ? `hsl(${hue} 65% 65%)` : `hsl(${hue} 70% 40%)`;
}

export function GraphCanvas(props: {
  rows: readonly { graph: GraphRowDto }[];
  viewport: GraphViewport;
  rowHeight: number;
  laneWidth: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== props.width * dpr || canvas.height !== props.height * dpr) {
      canvas.width = props.width * dpr;
      canvas.height = props.height * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, props.width, props.height);
    ctx.lineWidth = 2;

    const { rows, viewport, rowHeight, laneWidth } = props;
    const x = (lane: number): number => lane * laneWidth + laneWidth / 2;

    for (let i = viewport.first; i <= viewport.last && i < rows.length; i++) {
      const row = rows[i]?.graph;
      if (!row) continue;
      const yTop = i * rowHeight - viewport.scrollTop;
      const yMid = yTop + rowHeight / 2;
      const yBottom = yTop + rowHeight;
      const joinLanes = new Set(row.joins.map((j) => j.lane));

      // Verticals entering the row: uninvolved lanes run straight through;
      // the node lane and join lanes run to the node center.
      for (const l of row.lanesBefore) {
        ctx.strokeStyle = laneColor(l.colorIdx, dark);
        ctx.beginPath();
        if (l.lane === row.nodeLane) {
          ctx.moveTo(x(l.lane), yTop);
          ctx.lineTo(x(l.lane), yMid);
        } else if (joinLanes.has(l.lane)) {
          ctx.moveTo(x(l.lane), yTop);
          ctx.bezierCurveTo(x(l.lane), yMid, x(row.nodeLane), yTop + rowHeight * 0.15, x(row.nodeLane), yMid);
        } else {
          ctx.moveTo(x(l.lane), yTop);
          ctx.lineTo(x(l.lane), yMid);
        }
        ctx.stroke();
      }
      // Below the node: forks + continues.
      for (const c of row.continues) {
        ctx.strokeStyle = laneColor(c.colorIdx, dark);
        ctx.beginPath();
        ctx.moveTo(x(c.lane), yMid);
        ctx.lineTo(x(c.lane), yBottom);
        ctx.stroke();
      }
      for (const f of row.forks) {
        ctx.strokeStyle = laneColor(f.colorIdx, dark);
        ctx.beginPath();
        if (f.lane === row.nodeLane) {
          ctx.moveTo(x(f.lane), yMid);
          ctx.lineTo(x(f.lane), yBottom);
        } else {
          ctx.moveTo(x(row.nodeLane), yMid);
          ctx.bezierCurveTo(x(row.nodeLane), yBottom, x(f.lane), yMid + rowHeight * 0.35, x(f.lane), yBottom);
        }
        ctx.stroke();
      }
      // Node dot.
      ctx.fillStyle = laneColor(row.colorIdx, dark);
      ctx.beginPath();
      ctx.arc(x(row.nodeLane), yMid, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  return (
    <canvas
      ref={canvasRef}
      className="gt-log-graph-canvas"
      style={{ width: props.width, height: props.height }}
      aria-hidden="true"
    />
  );
}
