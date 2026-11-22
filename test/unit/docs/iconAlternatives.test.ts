/**
 * POST-P14cz: icons the owner liked but did not pick, kept in
 * `docs/icon-alternatives/` so Geet can switch to one later (its README says
 * how). Each folder there must stay ready to copy over `media/`: the same four
 * files, drawn the way the live icon is drawn, and none of it shipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const store = 'docs/icon-alternatives';
const FILES = ['geet-mark.svg', 'geet-mark-solid.svg', 'icon.svg', 'icon.png'];

const alternatives = readdirSync(path.join(root, store)).filter((name) => statSync(path.join(root, store, name)).isDirectory());

/** An SVG's lines, trimmed: its opening tag first. */
const lines = (rel: string): string[] =>
  read(rel)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
/** What an SVG draws: its paths and circles, as written. */
const drawn = (rel: string): string[] => lines(rel).filter((line) => /^<(path|circle) /u.test(line));

interface Dot {
  cx: number;
  cy: number;
  r: number;
  /** The attributes after `r`. */
  rest: string;
}
function dots(rel: string): Dot[] {
  return [...read(rel).matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"([^>]*)\/>/gu)].map((m) => ({
    cx: Number(m[1]),
    cy: Number(m[2]),
    r: Number(m[3]),
    rest: (m[4] ?? '').trim(),
  }));
}

describe('icons kept for later (docs/icon-alternatives)', () => {
  it('keep "Dot tucked in", which the owner asked to keep', () => {
    expect(alternatives).toContain('dot-tucked-in');
  });

  it('are left out of the VSIX, as all of docs/ is', () => {
    expect(read('.vscodeignore').split(/\r?\n/u)).toContain('docs/**');
  });

  describe.each(alternatives)('%s', (name) => {
    const dir = `${store}/${name}`;

    it('has the four files media/ has', () => {
      expect(FILES.filter((file) => !existsSync(path.join(root, dir, file)))).toEqual([]);
    });

    it('is described in the README', () => {
      expect(read(`${store}/README.md`)).toContain(`| \`${name}/\` |`);
    });

    it('draws its mark as the live mark is drawn: the same 24px box and 1.5px round line, one line and one hollow dot', () => {
      expect(lines(`${dir}/geet-mark.svg`)[0]).toBe(lines('media/geet-mark.svg')[0]);
      const shapes = drawn(`${dir}/geet-mark.svg`);
      expect(shapes.filter((line) => line.startsWith('<path '))).toHaveLength(1);
      expect(dots(`${dir}/geet-mark.svg`)).toEqual([expect.objectContaining({ rest: '' })]);
      expect(shapes).toHaveLength(2);
    });

    it('its solid mark is the same line with the dot filled to its outer edge', () => {
      const mark = `${dir}/geet-mark.svg`;
      const solid = `${dir}/geet-mark-solid.svg`;
      expect(lines(solid)[0]).toBe(lines(mark)[0]);
      const isPath = (line: string): boolean => line.startsWith('<path ');
      expect(drawn(solid).filter(isPath)).toEqual(drawn(mark).filter(isPath));
      const [hollow] = dots(mark);
      const [filled] = dots(solid);
      expect(dots(solid)).toHaveLength(1);
      expect([filled?.cx, filled?.cy]).toEqual([hollow?.cx, hollow?.cy]);
      expect(filled?.r).toBeCloseTo((hollow?.r ?? 0) + 1.5 / 2, 5);
      expect(filled?.rest).toBe('fill="currentColor" stroke="none"');
    });

    it('its Marketplace icon is its mark four times over, on the live icon’s tile', () => {
      const icon = lines(`${dir}/icon.svg`);
      // The <svg>, the tile and the scaling: the live icon's, line for line.
      expect(icon.slice(0, 3)).toEqual(lines('media/icon.svg').slice(0, 3));
      expect(drawn(`${dir}/icon.svg`)).toEqual(drawn(`${dir}/geet-mark.svg`));
    });

    it('its icon.png is its icon.svg rendered at 256px (GEET_CAPTURE=1 makes it)', () => {
      const png = decodePng(path.join(root, dir, 'icon.png'));
      expect([png.width, png.height]).toEqual([256, 256]);
      // The tile is a rounded rect: its corners stay transparent.
      expect(png.px(0, 0)[3]).toBe(0);
      expect(png.px(255, 255)[3]).toBe(0);
      const svg = read(`${dir}/icon.svg`);
      const tile = rgba(/<rect [^>]*fill="(#[0-9a-f]{6})"/u.exec(svg)?.[1] ?? '');
      const ink = rgba(/<g [^>]*stroke="(#[0-9a-f]{6})"/u.exec(svg)?.[1] ?? '');
      expect(png.px(128, 12)).toEqual(tile);
      // The dot: its ring is the line's colour, its middle the tile's.
      const [dot] = dots(`${dir}/icon.svg`);
      const at = (v: number): number => Math.floor((16 + v * 4) * 2);
      const { cx = 0, cy = 0, r = 0 } = dot ?? {};
      expect(png.px(at(cx + r), at(cy))).toEqual(ink);
      expect(png.px(at(cx), at(cy))).toEqual(tile);
    });
  });
});

const rgba = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);

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
