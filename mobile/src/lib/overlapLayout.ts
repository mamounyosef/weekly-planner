// ─── Overlapping blocks in one day column ────────────────────────────────────
// Where each timed block sits horizontally, and how wide it is, when several of
// them share the same stretch of the day. Blocks never cover each other.
//
// TWO MODES
//   'fit'      (default) A block is split ONLY for the stretch of time it
//              actually shares. An 8h sleep that touches the next item for its
//              last ten minutes is full width for 7h50m and half width for the
//              last ten minutes; the next item is half width for those same ten
//              minutes and full width after. So a block's width can change
//              along its length: it is described as a list of `segments`, and
//              the renderer clips the block to that stepped shape.
//   'columns'  The classic layout: a block keeps one width for its whole
//              length, the width its busiest moment needs.
//
// WHY ONE CLUSTER-WIDE COLUMN ORDER
// The previous layout gave each block its own column count but kept a column
// index from a shared pass, so two neighbours could disagree about how wide a
// column is (Friday Prayer drawn half on top of the block to its left). Here
// every block in an overlap group gets one column index from one pass, and
// both modes derive positions from that same order, so blocks never cross.

export type OverlapLayoutMode = 'fit' | 'columns';

export const OVERLAP_LAYOUT_MODES: readonly OverlapLayoutMode[] = ['fit', 'columns'];

/** Anything that is not exactly 'columns' is the default. */
export function coerceOverlapLayoutMode(v: unknown): OverlapLayoutMode {
  return v === 'columns' ? 'columns' : 'fit';
}

export interface OverlapInput {
  id: string;
  /** Minutes on the column's own axis. */
  startMin: number;
  /** Minutes on the column's own axis. Clamped to at least startMin + 1. */
  endMin: number;
}

/** One stretch of a block with a constant horizontal position. */
export interface OverlapSegment {
  fromMin: number;
  toMin: number;
  /** Fractions of the day column, 0..1. */
  left: number;
  width: number;
}

export interface OverlapBox {
  /** Bounding box across all segments, as fractions of the day column. */
  left: number;
  width: number;
  /** Top to bottom, contiguous, never empty. One entry when the width never changes. */
  segments: OverlapSegment[];
}

interface Norm { id: string; s: number; e: number }

const EPS = 1e-9;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

export function layoutOverlaps(
  items: readonly OverlapInput[],
  opts: { mode: OverlapLayoutMode },
): Map<string, OverlapBox> {
  const out = new Map<string, OverlapBox>();

  // Drop junk, collapse duplicate ids (first one wins), make every block at
  // least a minute long so a zero-length block still occupies a slot.
  const seen = new Set<string>();
  const list: Norm[] = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || seen.has(it.id)) continue;
    if (!Number.isFinite(it.startMin)) continue;
    const s = it.startMin;
    const e = Number.isFinite(it.endMin) ? Math.max(it.endMin, s + 1) : s + 1;
    seen.add(it.id);
    list.push({ id: it.id, s, e });
  }

  // Earlier first; on a tie the LONGER one first so it takes column 0; then
  // id, so the same input always lays out the same way.
  list.sort((a, b) => a.s - b.s || b.e - a.e || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Groups: runs of blocks connected by overlap.
  const groups: Norm[][] = [];
  let run: Norm[] = [];
  let runEnd = -Infinity;
  for (const n of list) {
    if (run.length > 0 && n.s >= runEnd) { groups.push(run); run = []; runEnd = -Infinity; }
    run.push(n);
    runEnd = Math.max(runEnd, n.e);
  }
  if (run.length > 0) groups.push(run);

  for (const group of groups) {
    // Greedy columns: first column whose last block has finished.
    const colEnds: number[] = [];
    const colOf = new Map<string, number>();
    for (const n of group) {
      let c = colEnds.findIndex(end => end <= n.s);
      if (c === -1) { c = colEnds.length; colEnds.push(n.e); } else colEnds[c] = n.e;
      colOf.set(n.id, c);
    }

    if (opts.mode === 'columns') {
      const numCols = colEnds.length;
      for (const n of group) {
        const c = colOf.get(n.id)!;
        // Widen right while the next column is free for this block's whole span.
        let span = 1;
        for (let k = c + 1; k < numCols; k++) {
          if (group.some(o => colOf.get(o.id) === k && o.s < n.e && o.e > n.s)) break;
          span++;
        }
        const left = c / numCols, width = span / numCols;
        out.set(n.id, { left, width, segments: [{ fromMin: n.s, toMin: n.e, left, width }] });
      }
      continue;
    }

    // 'fit': cut the group's time at every start and end. In each slice the
    // blocks running then split the width equally, in column order.
    const cuts = [...new Set(group.flatMap(n => [n.s, n.e]))].sort((a, b) => a - b);
    const segs = new Map<string, OverlapSegment[]>();
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i], to = cuts[i + 1];
      const active = group
        .filter(n => n.s < to && n.e > from)
        .sort((a, b) => colOf.get(a.id)! - colOf.get(b.id)!);
      const k = active.length;
      active.forEach((n, rank) => {
        const left = rank / k, width = 1 / k;
        const list = segs.get(n.id) ?? [];
        const last = list[list.length - 1];
        if (last && same(last.left, left) && same(last.width, width) && last.toMin === from) {
          last.toMin = to;
        } else {
          list.push({ fromMin: from, toMin: to, left, width });
        }
        segs.set(n.id, list);
      });
    }
    for (const n of group) {
      const segments = segs.get(n.id)!;
      const left = Math.min(...segments.map(s => s.left));
      const right = Math.max(...segments.map(s => s.left + s.width));
      out.set(n.id, { left, width: right - left, segments });
    }
  }
  return out;
}

// ─── Turning a box into rectangles (React Native, no clip-path) ─────────────

export interface SegmentRect {
  /** Pixels from the top of the block. */
  top: number;
  height: number;
  /** Fractions of the block's bounding box width, 0..1. */
  left: number;
  width: number;
}

/**
 * Each segment as a rectangle inside the block, for a renderer that draws the
 * stepped shape out of plain views. `yAt` maps a minute to the grid's y (it
 * may skip hidden hours, which is why it is a function and not a scale), and
 * `blockTop` / `blockHeight` are where the whole block was drawn. Rectangles
 * are clamped to the block so a minimum-height block still reads as one piece.
 */
export function segmentRects(
  box: OverlapBox, yAt: (minute: number) => number, blockTop: number, blockHeight: number,
): SegmentRect[] {
  const n = box.segments.length;
  return box.segments.map((s, i) => {
    const y0 = i === 0 ? 0 : Math.min(blockHeight, Math.max(0, yAt(s.fromMin) - blockTop));
    const y1 = i === n - 1 ? blockHeight : Math.min(blockHeight, Math.max(y0, yAt(s.toMin) - blockTop));
    return {
      top: y0,
      height: Math.max(0, y1 - y0),
      left: box.width > EPS ? (s.left - box.left) / box.width : 0,
      width: box.width > EPS ? s.width / box.width : 1,
    };
  });
}

/** Index of the segment the text goes in: the longest, the first on a tie. */
export function contentSegmentIndex(box: OverlapBox): number {
  let best = 0;
  box.segments.forEach((s, i) => {
    const b = box.segments[best];
    if (s.toMin - s.fromMin > b.toMin - b.fromMin + EPS) best = i;
  });
  return best;
}

// ─── Turning a box into CSS ──────────────────────────────────────────────────
// The element is placed at the bounding box. When the width changes along the
// block, a clip-path polygon cuts it to the stepped shape. Coordinates inside
// the polygon are relative to the element, which is already inset from the
// column by `edge` (at a column wall) or `gap / 2` (beside a neighbour); the
// px term in each point undoes that inset exactly, so a step lines up with the
// neighbour's edge to the pixel.

interface Insets { a: number; b: number }

function insets(box: OverlapBox, edge: number, gap: number): Insets {
  const atLeft = box.left <= EPS;
  const atRight = box.left + box.width >= 1 - EPS;
  return { a: edge + (atLeft ? 0 : gap / 2), b: edge + (atRight ? 0 : gap / 2) };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** CSS `left` / `right` for the element, inside a day column. */
export function overlapBoxCss(box: OverlapBox, edge: number, gap: number): { left: string; right: string } {
  const { a, b } = insets(box, edge, gap);
  const leftPct = box.left * 100;
  const rightPct = Math.max(0, 100 - (box.left + box.width) * 100);
  return {
    left: `calc(${round(leftPct)}% + ${a}px)`,
    right: `calc(${round(rightPct)}% + ${b}px)`,
  };
}

/** An x position inside the element, for a point at column fraction `f`, shifted by `shift` px. */
function xAt(box: OverlapBox, ins: Insets, f: number, shift: number): string {
  const rel = box.width > EPS ? (f - box.left) / box.width : 0;
  const px = rel * (ins.a + ins.b) - ins.a + shift;
  return `calc(${round(rel * 100)}% + ${round(px)}px)`;
}

function yAt(box: OverlapBox, min: number): string {
  const first = box.segments[0].fromMin;
  const last = box.segments[box.segments.length - 1].toMin;
  const span = last - first;
  return `${round(span > 0 ? ((min - first) / span) * 100 : 0)}%`;
}

function segLeftX(box: OverlapBox, ins: Insets, s: OverlapSegment, gap: number): string {
  return same(s.left, box.left) ? '0%' : xAt(box, ins, s.left, gap / 2);
}

function segRightX(box: OverlapBox, ins: Insets, s: OverlapSegment, gap: number): string {
  return same(s.left + s.width, box.left + box.width) ? '100%' : xAt(box, ins, s.left + s.width, -gap / 2);
}

/** True when the block keeps one width all the way down. */
export function isRectangular(box: OverlapBox): boolean {
  return box.segments.every(s => same(s.left, box.left) && same(s.width, box.width));
}

/**
 * The stepped shape as a `clip-path`, or undefined for a plain rectangle (so
 * the common case keeps its shadow, outline and rounded corners untouched).
 */
export function overlapClipPath(box: OverlapBox, edge: number, gap: number): string | undefined {
  if (box.segments.length === 0 || isRectangular(box)) return undefined;
  const ins = insets(box, edge, gap);
  const pts: string[] = [];
  const n = box.segments.length;
  // Down the right-hand side...
  box.segments.forEach((s, i) => {
    const x = segRightX(box, ins, s, gap);
    pts.push(`${x} ${i === 0 ? '0%' : yAt(box, s.fromMin)}`);
    pts.push(`${x} ${i === n - 1 ? '100%' : yAt(box, s.toMin)}`);
  });
  // ...and back up the left.
  for (let i = n - 1; i >= 0; i--) {
    const s = box.segments[i];
    const x = segLeftX(box, ins, s, gap);
    pts.push(`${x} ${i === n - 1 ? '100%' : yAt(box, s.toMin)}`);
    pts.push(`${x} ${i === 0 ? '0%' : yAt(box, s.fromMin)}`);
  }
  return `polygon(${pts.join(', ')})`;
}

/**
 * Where the title and times go: the LONGEST stretch of the block (the first
 * one on a tie), so the text sits where the block has the most room and is
 * never cut off by the step. Undefined for a plain rectangle.
 */
export function overlapContentArea(
  box: OverlapBox, edge: number, gap: number,
): { left: string; right: string; top: string; bottom: string; heightFraction: number } | undefined {
  if (box.segments.length === 0 || isRectangular(box)) return undefined;
  const ins = insets(box, edge, gap);
  const best = box.segments[contentSegmentIndex(box)];
  const l = segLeftX(box, ins, best, gap);
  const r = segRightX(box, ins, best, gap);
  const top = yAt(box, best.fromMin);
  const bottomPct = 100 - parseFloat(yAt(box, best.toMin));
  const total = box.segments[box.segments.length - 1].toMin - box.segments[0].fromMin;
  return {
    left: l,
    right: r === '100%' ? '0px' : `calc(100% - (${r}))`,
    top,
    bottom: `${round(Math.max(0, bottomPct))}%`,
    heightFraction: total > 0 ? (best.toMin - best.fromMin) / total : 1,
  };
}
