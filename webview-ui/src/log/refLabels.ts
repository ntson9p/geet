/**
 * What a commit row draws for its refs, under `Presentation Settings ▾ · Tag
 * Names` (`gittree.log.showTagNames`).
 *
 * Branches are always named. Tags follow IntelliJ: with Tag Names on, each tag
 * is a chip with the tag icon *and* its name; with it off, all of a commit's
 * tags gather into one chip that is the tag icon alone, and hovering over it
 * shows their names. Nothing is ever hidden outright: a commit that carries a
 * tag still says so.
 */
import type { RefChipDto } from '../../../src/shared/protocol';

export type RefLabel =
  /** A named chip: any branch, HEAD, or a tag while Tag Names is on. */
  | { readonly kind: 'ref'; readonly ref: RefChipDto }
  /** Tag Names off: the commit's tags, drawn as one tag icon. */
  | { readonly kind: 'tags'; readonly names: readonly string[] };

export function refLabels(refs: readonly RefChipDto[], showTagNames: boolean): RefLabel[] {
  if (showTagNames) return refs.map((ref) => ({ kind: 'ref', ref }));
  const names = refs.filter((r) => r.type === 'tag').map((r) => r.name);
  const out: RefLabel[] = [];
  let placed = false;
  for (const ref of refs) {
    if (ref.type !== 'tag') {
      out.push({ kind: 'ref', ref });
    } else if (!placed) {
      // The icon takes the first tag's place, so the chips keep the order the
      // host gave them, which is git's own decoration order.
      out.push({ kind: 'tags', names });
      placed = true;
    }
  }
  return out;
}

/** The hover text for an icon-only tag chip: one name per line. */
export function tagsTooltip(names: readonly string[]): string {
  return names.join('\n');
}
