/**
 * Draws `refLabels.ts`'s labels: IntelliJ's tag icon — one outlined tag per
 * colour, each overlapping the one before, the top one dotted — then the name
 * in grey. A label without a name is the icon alone; `Detached HEAD` is a
 * warning icon and warning-coloured text.
 */
import { useId, type MouseEvent as ReactMouseEvent } from 'react';
import { LABEL_METRICS, iconWidth, type RefKind, type RefLabel } from './refLabels';

/** IntelliJ's tag outline (`TagPainter`, from its `currentBranch.svg`), on a 16-unit square. */
const TAG_PATH =
  'M13.4495 7.5001L7.01028 13.9394C6.81502 14.1347 6.49843 14.1347 6.30317 13.9394L2.06053 9.69679' +
  'C1.86527 9.50152 1.86527 9.18494 2.06053 8.98968L8.49978 2.55035C8.61106 2.43907 8.76824 2.38667 8.92404 2.40893' +
  'L12.6363 2.93926C12.8563 2.97069 13.0292 3.14354 13.0606 3.36352L13.5909 7.07584' +
  'C13.6132 7.23163 13.5608 7.38882 13.4495 7.5001Z';

/** How far each further colour's tag sits to the right, in the same units. */
const STEP = 2 * (16 / 6.25);

export function RefIcon({ colors }: { colors: readonly RefKind[] }) {
  const id = useId().replace(/:/gu, '');
  const height = LABEL_METRICS.iconHeight;
  const width = iconWidth(colors.length, height);
  const viewWidth = 16 + STEP * Math.max(0, colors.length - 1);
  return (
    <svg
      className="gt-ref-icon"
      width={width}
      height={height}
      viewBox={`0 0 ${viewWidth} 16`}
      aria-hidden="true"
      data-colors={colors.join(' ')}
    >
      {colors.length > 1 ? (
        <defs>
          {colors.slice(0, -1).map((_, i) => (
            // Each tag is hidden where a later one lies over it, as IntelliJ
            // paints each tag's body in the background colour over the last.
            <mask key={i} id={`${id}m${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width={viewWidth} height="16">
              <rect width={viewWidth} height="16" fill="white" />
              {colors.slice(i + 1).map((__, j) => (
                <path
                  key={j}
                  d={TAG_PATH}
                  transform={`translate(${STEP * (i + 1 + j)} 0)`}
                  fill="black"
                  stroke="black"
                  strokeWidth="2"
                />
              ))}
            </mask>
          ))}
        </defs>
      ) : null}
      {colors.map((kind, i) => {
        const top = i === colors.length - 1;
        return (
          <g
            key={i}
            className={`gt-ref-kind-${kind}`}
            transform={`translate(${STEP * i} 0)`}
            mask={top ? undefined : `url(#${id}m${i})`}
          >
            <path
              d={TAG_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {top ? <circle cx="10.5" cy="5.5" r="1" fill="currentColor" /> : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface RefLabelsProps {
  labels: readonly RefLabel[];
  compact: boolean;
  onHover: (label: RefLabel, el: HTMLElement) => void;
  onLeave: (el: HTMLElement) => void;
}

export function RefLabels({ labels, compact, onHover, onLeave }: RefLabelsProps) {
  if (labels.length === 0) return null;
  const gap = compact ? LABEL_METRICS.compactMiddlePadding : LABEL_METRICS.middlePadding;
  return (
    <span className="gt-ref-labels" data-testid="ref-labels">
      {labels.map((label, i) => (
        <span
          key={i}
          className={`gt-ref-label${label.detached === true ? ' gt-ref-detached' : ''}`}
          style={i > 0 ? { marginLeft: gap } : undefined}
          data-testid="ref-label"
          aria-label={label.refs
            .filter((r) => r.kind !== 'head')
            .map((r) => r.name)
            .join(', ') || label.text}
          onMouseEnter={(e: ReactMouseEvent<HTMLSpanElement>) => onHover(label, e.currentTarget)}
          onMouseLeave={(e: ReactMouseEvent<HTMLSpanElement>) => onLeave(e.currentTarget)}
        >
          {label.detached === true ? (
            <span className="codicon codicon-warning gt-ref-warning" aria-hidden="true" />
          ) : (
            <RefIcon colors={label.colors} />
          )}
          {label.text.length > 0 ? <span className="gt-ref-label-text">{label.text}</span> : null}
        </span>
      ))}
    </span>
  );
}
