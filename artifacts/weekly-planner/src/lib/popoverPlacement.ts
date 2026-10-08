// Where the item popup goes, relative to the block it belongs to.
//
// The rule the user cares about: the popup must never sit on top of the thing
// that was clicked. So it goes beside the block (right first, then left), and
// only when neither side has room does it fall back to the side with MORE room,
// clamped into the window. Vertically it lines up with the block's top, but a
// block whose top is scrolled off screen does not drag the popup off with it.

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }
export interface Viewport { width: number; height: number }

export interface PlaceOpts { margin?: number; gap?: number }

const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

export function placeBeside(anchor: Rect, size: Size, vp: Viewport, opts: PlaceOpts = {}): { x: number; y: number } {
  const margin = Math.max(0, finite(opts.margin ?? 8, 8));
  const gap = Math.max(0, finite(opts.gap ?? 6, 6));
  const vw = Math.max(0, finite(vp.width, 0));
  const vh = Math.max(0, finite(vp.height, 0));
  const w = Math.max(0, finite(size.width, 0));
  const h = Math.max(0, finite(size.height, 0));
  const left = finite(anchor.left, 0);
  const right = finite(anchor.right, left);
  const top = finite(anchor.top, 0);

  const roomRight = vw - margin - (right + gap);
  const roomLeft = left - gap - margin;
  let x: number;
  if (w <= roomRight) x = right + gap;
  else if (w <= roomLeft) x = left - gap - w;
  else x = roomLeft > roomRight ? left - gap - w : right + gap;

  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  x = Math.min(Math.max(x, margin), maxX);
  const y = Math.min(Math.max(top, margin), maxY);
  return { x: Math.round(x), y: Math.round(y) };
}

/** How much of `r` is visible inside the viewport (area, px^2). */
export function visibleArea(r: Rect, vp: Viewport): number {
  const w = Math.min(r.right, vp.width) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, vp.height) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Pick which on-screen piece of an item the popup should follow. An overnight
 * item is drawn as several pieces (one per day column) that share one id; the
 * popup must follow the piece that was CLICKED, not whichever piece comes first
 * in the page. `prefer` is the clicked piece's last known rect: the candidate
 * nearest to it wins, ties broken by how much of it is visible.
 */
export function pickAnchor<T>(cands: { item: T; rect: Rect }[], vp: Viewport, prefer?: Rect | null): T | null {
  if (cands.length === 0) return null;
  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    let score: number;
    if (prefer) {
      const dx = (c.rect.left + c.rect.right) / 2 - (prefer.left + prefer.right) / 2;
      const dy = (c.rect.top + c.rect.bottom) / 2 - (prefer.top + prefer.bottom) / 2;
      score = Math.hypot(dx, dy) - visibleArea(c.rect, vp) * 1e-9;
    } else {
      score = -visibleArea(c.rect, vp);
    }
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best.item;
}
