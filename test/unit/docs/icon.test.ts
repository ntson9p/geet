/**
 * POST-P14cz: Geet's icon, a G with a commit at its heart. The owner chose it
 * from drawings made after their sketch, then asked for its curve to be part
 * of one exact circle and for the dot to sit at that circle's centre. So the
 * crossbar runs in at the centre's height, from the circle's edge to the dot.
 * It is drawn in the style of VS Code's own icons (the owner's request, beside
 * the Source Control icon), and is one drawing in three files:
 *
 * - `media/geet-mark.svg`, the activity bar's: a 24px mask VS Code fills with
 *   the theme's colour, drawn on the codicons' grid in their 1.5px line;
 * - `media/geet-mark-solid.svg`, the same with a filled dot;
 * - `media/icon.svg`, the Marketplace's: the mark four times over on a tile
 *   with the proportions of VS Code's active activity-bar tile (24px in 32px,
 *   4px corners), rendered to `media/icon.png` by
 *   `webview-ui/tests/capture.spec.ts` with `GEET_CAPTURE=1`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

interface Drawing {
  svg: string;
  /** The line: the arc, then the crossbar. */
  d: string;
  dot: { cx: number; cy: number; r: number; filled: boolean };
  strokeWidth: number;
}

function drawing(rel: string): Drawing {
  const svg = read(rel);
  const paths = [...svg.matchAll(/<path d="([^"]+)"/gu)].map((m) => m[1] ?? '');
  const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"([^>]*)\/>/gu)];
  expect(paths, rel).toHaveLength(1);
  expect(dots, rel).toHaveLength(1);
  const [, cx, cy, r, rest] = dots[0] ?? [];
  return {
    svg,
    d: paths[0] ?? '',
    dot: { cx: Number(cx), cy: Number(cy), r: Number(r), filled: /\bfill="(?!none)/u.test(rest ?? '') },
    strokeWidth: Number(/stroke-width="([\d.]+)"/u.exec(svg)?.[1]),
  };
}

interface Point {
  x: number;
  y: number;
}

/** The line, read: an arc from `start` to `end`, then a horizontal line to `barEnd`. */
function line(d: string): { start: Point; rx: number; ry: number; largeArc: number; sweep: number; end: Point; barEnd: number } {
  const m = /^M([\d.]+) ([\d.]+)A([\d.]+) ([\d.]+) 0 ([01]) ([01]) ([\d.]+) ([\d.]+)H([\d.]+)$/u.exec(d);
  expect(m, d).not.toBeNull();
  const n = (i: number): number => Number(m?.[i]);
  return { start: { x: n(1), y: n(2) }, rx: n(3), ry: n(4), largeArc: n(5), sweep: n(6), end: { x: n(7), y: n(8) }, barEnd: n(9) };
}

const mark = drawing('media/geet-mark.svg');
const solid = drawing('media/geet-mark-solid.svg');
const icon = drawing('media/icon.svg');
const { start, rx, ry, largeArc, sweep, end, barEnd } = line(mark.d);
const centre: Point = { x: mark.dot.cx, y: mark.dot.cy };
/** An angle on screen, in degrees: 0 is to the right of the centre, -90 above it. */
const angle = (p: Point): number => (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;

describe("Geet's icon is one drawing", () => {
  it('the activity bar shows the mark', () => {
    const pkg = JSON.parse(read('package.json')) as {
      icon: string;
      contributes: { viewsContainers: { activitybar: Array<{ id: string; icon: string }> } };
    };
    expect(pkg.contributes.viewsContainers.activitybar).toEqual([expect.objectContaining({ id: 'geet', icon: 'media/geet-mark.svg' })]);
    expect(pkg.icon).toBe('media/icon.png');
  });

  it("the mark is drawn as VS Code's own icons are: a 24px box, 1.5px round lines, no fill", () => {
    expect(mark.svg).toContain('viewBox="0 0 24 24"');
    expect(mark.strokeWidth).toBe(1.5);
    expect(mark.svg).toMatch(/<svg [^>]*fill="none" stroke="currentColor"/u);
    expect(mark.svg).toContain('stroke-linecap="round"');
    expect(mark.svg).toContain('stroke-linejoin="round"');
  });

  it('its curve is part of one exact circle, and the hollow dot sits at that circle’s centre', () => {
    // The owner's words: "the curved line should be a part of a perfect
    // circle", and the dot "at the absolute center" of it.
    expect(rx).toBe(ry);
    expect(Math.hypot(start.x - centre.x, start.y - centre.y)).toBeCloseTo(rx, 3);
    expect(Math.hypot(end.x - centre.x, end.y - centre.y)).toBeCloseTo(rx, 3);
    expect(mark.dot.filled).toBe(false);
  });

  it('the circle, and so the dot, is centred in the 24px box', () => {
    expect(centre).toEqual({ x: 12, y: 12 });
  });

  it('the curve runs seven eighths of the way round: anticlockwise from the top right to the right', () => {
    expect(angle(start)).toBeCloseTo(-45, 1);
    // The long way round, anticlockwise on screen.
    expect([largeArc, sweep]).toEqual([1, 0]);
    expect(end).toEqual({ x: centre.x + rx, y: centre.y });
  });

  it('the crossbar runs in at the centre’s height, from the circle’s edge to the dot', () => {
    // It ends on the dot's own line, so the two join without poking into the dot.
    expect(barEnd).toBe(centre.x + mark.dot.r);
    expect(barEnd).toBeLessThan(end.x);
  });

  it('its straight edges fall on whole device pixels at the owner’s 125%, and the circles’ edges at 200% too', () => {
    // A line of width 1.5 centred on v covers [v - 0.75, v + 0.75]. The activity
    // bar starts the 24px box on a whole device pixel, so at a scale s the line is
    // sharp when that span covers no more device pixels than it must. At 200% the
    // crossbar, on the centre line, is the one edge left soft: centring won.
    const pixels = (v: number, s: number): number => Math.ceil(s * (v + 0.75)) - Math.floor(s * (v - 0.75));
    const R = rx;
    const r = mark.dot.r;
    const circleEdges = [centre.x - R, centre.x + R, centre.y - R, centre.y + R, centre.x - r, centre.x + r, centre.y - r, centre.y + r];
    for (const v of [centre.y, ...circleEdges]) expect(pixels(v, 1.25), `${v} at 125%`).toBe(2);
    for (const v of circleEdges) expect(pixels(v, 2), `${v} at 200%`).toBe(3);
  });

  it('the solid mark is the same line with the dot filled to its outer edge', () => {
    expect(solid.d).toBe(mark.d);
    expect(solid.strokeWidth).toBe(mark.strokeWidth);
    expect([solid.dot.cx, solid.dot.cy]).toEqual([mark.dot.cx, mark.dot.cy]);
    expect(solid.dot.filled).toBe(true);
    expect(solid.dot.r).toBeCloseTo(mark.dot.r + mark.strokeWidth / 2, 5);
  });

  it('the Marketplace icon is the mark four times over, 16 in from a 128 tile', () => {
    expect(icon.svg).toContain('viewBox="0 0 128 128"');
    expect(icon.svg).toContain('<g transform="translate(16 16) scale(4)"');
    expect(icon.d).toBe(mark.d);
    expect(icon.dot).toEqual(mark.dot);
    expect(icon.strokeWidth).toBe(mark.strokeWidth);
    // VS Code's active activity-bar tile: 32px with 4px corners, so 128 with 16.
    expect(icon.svg).toMatch(/<rect width="128" height="128" rx="16" fill="#[0-9a-f]{6}"\/>/u);
  });
});

/** An 8-bit RGBA PNG's pixels (what Chromium's capture writes). */
function decodePng(file: string): { width: number; height: number; px: (x: number, y: number) => number[] } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // Bit depth 8, colour type 6 (RGBA), not interlaced.
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (out[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const c = i >= 4 && y > 0 ? (out[(y - 1) * stride + i - 4] ?? 0) : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      out[y * stride + i] = (v + predicted) & 0xff;
    }
  }
  return { width, height, px: (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

const rgba = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);

describe('media/icon.png is media/icon.svg rendered at 256px (GEET_CAPTURE=1 makes it)', () => {
  const png = decodePng(path.join(root, 'media', 'icon.png'));
  const tile = rgba(/<rect [^>]*fill="(#[0-9a-f]{6})"/u.exec(icon.svg)?.[1] ?? '');
  const ink = rgba(/<g [^>]*stroke="(#[0-9a-f]{6})"/u.exec(icon.svg)?.[1] ?? '');
  /** An icon.svg unit of the 24 grid, as a pixel of the 256px PNG. */
  const at = (v: number): number => Math.floor((16 + v * 4) * 2);

  it('is 256px square, with the tile’s corners left transparent', () => {
    expect([png.width, png.height]).toEqual([256, 256]);
    expect(png.px(0, 0)[3]).toBe(0);
    expect(png.px(255, 255)[3]).toBe(0);
  });

  it('in the tile’s colour and the line’s', () => {
    expect(png.px(128, 12)).toEqual(tile);
    // The dot: its ring is the line's colour, its middle the tile's.
    const { cx, cy, r } = icon.dot;
    expect(png.px(at(cx + r), at(cy))).toEqual(ink);
    expect(png.px(at(cx), at(cy))).toEqual(tile);
  });

  it('its crossbar is 12px of the line’s colour, with no partial pixels', () => {
    // 1.5 units at 4x, at 2px a unit; it starts on a whole pixel.
    const top = (16 + end.y * 4) * 2 - 6;
    expect(Number.isInteger(top)).toBe(true);
    const x = at((end.x + barEnd) / 2);
    for (let y = top; y < top + 12; y++) expect(png.px(x, y), `row ${y}`).toEqual(ink);
    expect(png.px(x, top - 1)).toEqual(tile);
    expect(png.px(x, top + 12)).toEqual(tile);
  });
});
