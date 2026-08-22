/**
 * Commit-body linkification (P12-T4): URLs always, issue keys when the user
 * configured a pattern (`gittree.log.issuePattern` + `gittree.log.issueUrl`,
 * `$0` in the URL is the matched key). Pure and unit-tested — the panel just
 * maps segments to <a>/<span>.
 */

export interface BodySegment {
  text: string;
  href?: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function linkifyBody(
  body: string,
  issue?: { pattern: string; url: string },
): BodySegment[] {
  interface Hit {
    start: number;
    end: number;
    href: string;
  }
  const hits: Hit[] = [];
  for (const m of body.matchAll(URL_RE)) {
    hits.push({ start: m.index, end: m.index + m[0].length, href: m[0] });
  }
  if (issue !== undefined && issue.pattern.length > 0 && issue.url.length > 0) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(issue.pattern, 'g');
    } catch {
      re = undefined; // invalid user pattern → issues off, URLs still work
    }
    if (re) {
      for (const m of body.matchAll(re)) {
        if (m[0].length === 0) break; // zero-width match would loop forever
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          href: issue.url.replace(/\$0/g, m[0]),
        });
      }
    }
  }
  // Earlier match wins on overlap; URL hits were collected first.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: BodySegment[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue; // overlaps something already linked
    if (hit.start > at) out.push({ text: body.slice(at, hit.start) });
    out.push({ text: body.slice(hit.start, hit.end), href: hit.href });
    at = hit.end;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

/** Human label for git's `%G?` signature state; undefined = show nothing. */
export function signatureLabel(code: string | undefined): string | undefined {
  if (code === 'G') return 'Good signature';
  if (code === 'B') return 'BAD signature';
  if (code === 'U' || code === 'X' || code === 'Y' || code === 'R') {
    return 'Signature: unverified';
  }
  if (code === 'E') return 'Signature: cannot be checked';
  return undefined; // 'N' or absent — unsigned commits say nothing
}
