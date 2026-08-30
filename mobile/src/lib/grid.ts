// ─── Laying out a day on a time grid ─────────────────────────────────────────
// Where each block sits, and how wide it is when several overlap.
//
// WHY THIS IS NOT DONE IN THE COMPONENT
// Overlap is the one part of a calendar that is genuinely an algorithm rather
// than styling, and it is wrong in a way nobody notices until it matters: two
// events at the same time render on top of each other, and the one underneath is
// simply invisible. You do not find out you missed it until afterwards. So it
// lives here, pure, with a test that asserts no two overlapping blocks are ever
// given the same column.

export interface Placeable {
  id: string;
  /** Minutes from midnight. */
  startMin: number;
  /** Minutes from midnight. Blocks with no end get a minimum height. */
  endMin: number | null;
}

export interface Placed<T> {
  item: T;
  /** Which column of its overlap group, from zero. */
  column: number;
  /** How many columns that group needs. Width is 1/columns of the day. */
  columns: number;
  top: number;
  height: number;
}

/** Below this a block is unreadable, so it is drawn taller than it is long. */
export const MIN_BLOCK_MINUTES = 20;

export function blockEnd(item: Placeable): number {
  const start = item.startMin;
  const end = item.endMin === null ? start + MIN_BLOCK_MINUTES : item.endMin;
  return Math.max(end, start + MIN_BLOCK_MINUTES);
}

/**
 * Group items into runs that overlap, then give each run as many columns as its
 * busiest moment needs.
 *
 * The greedy column assignment is the standard one: walk the items in start
 * order and drop each into the first column whose last block has finished. It is
 * not the tightest possible packing, but it is stable — the same input always
 * produces the same layout, so a block does not jump sideways when an unrelated
 * event three hours later is edited.
 */
export function layoutDay<T extends Placeable>(
  items: readonly T[],
  opts: { pxPerHour: number; dayStartHour?: number },
): Placed<T>[] {
  const dayStart = (opts.dayStartHour ?? 0) * 60;
  const perMinute = opts.pxPerHour / 60;

  const sorted = [...items]
    .filter(i => i && typeof i.startMin === 'number' && Number.isFinite(i.startMin))
    // Ties broken by id so two events starting together never swap places
    // between renders.
    .sort((a, b) => a.startMin - b.startMin
      || blockEnd(a) - blockEnd(b)
      || (a.id < b.id ? -1 : 1));

  const out: Placed<T>[] = [];
  let run: T[] = [];
  let runEnd = -Infinity;

  const flush = () => {
    if (run.length === 0) return;
    // Column ends within this run only; a new run starts with a clean slate.
    const columnEnds: number[] = [];
    const placed: { item: T; column: number }[] = [];

    for (const item of run) {
      let col = columnEnds.findIndex(end => end <= item.startMin);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(blockEnd(item));
      } else {
        columnEnds[col] = blockEnd(item);
      }
      placed.push({ item, column: col });
    }

    const columns = columnEnds.length;
    for (const { item, column } of placed) {
      const end = blockEnd(item);
      out.push({
        item,
        column,
        columns,
        top: (item.startMin - dayStart) * perMinute,
        height: Math.max(1, (end - item.startMin) * perMinute),
      });
    }
    run = [];
    runEnd = -Infinity;
  };

  for (const item of sorted) {
    // A run continues while the next block starts before the run has ended.
    if (run.length > 0 && item.startMin >= runEnd) flush();
    run.push(item);
    runEnd = Math.max(runEnd, blockEnd(item));
  }
  flush();

  return out;
}

/** The hour labels down the side of a grid. */
export function hourMarks(dayStartHour = 0, dayEndHour = 24): number[] {
  const from = Math.max(0, Math.min(23, Math.floor(dayStartHour)));
  const to = Math.max(from + 1, Math.min(24, Math.ceil(dayEndHour)));
  const out: number[] = [];
  for (let h = from; h <= to; h += 1) out.push(h);
  return out;
}

/** Where a moment sits, in pixels from the top of the grid. */
export function yOf(minutes: number, pxPerHour: number, dayStartHour = 0): number {
  return (minutes - dayStartHour * 60) * (pxPerHour / 60);
}

/** The weeks of a month, as rows of dates, padded to whole weeks. */
export function monthGrid(
  anchor: string,
  weekStartsOn: number,
): { weeks: string[][]; month: number } {
  const [y, m] = anchor.split('-').map(Number);
  const first = new Date(y, (m || 1) - 1, 1);
  const month = first.getMonth();

  // Back up to the start of the week the 1st falls in.
  const lead = ((first.getDay() - weekStartsOn) % 7 + 7) % 7;
  const cursor = new Date(first);
  cursor.setDate(cursor.getDate() - lead);

  const weeks: string[][] = [];
  // Six rows always, so the grid does not change height between months and the
  // cells stop shifting under the thumb as you page through.
  for (let w = 0; w < 6; w += 1) {
    const row: string[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(
        `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`,
      );
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }
  return { weeks, month };
}
