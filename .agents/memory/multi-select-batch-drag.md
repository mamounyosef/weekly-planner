---
name: Multi-select & batch drag
description: Interaction model for selecting and batch-moving events with Ctrl+click and rubber-band selection.
---

## Selection model

- `selectedIds: Set<string>` — React state, synced to `selectedIdsRef` for use in stale-closure handlers.
- **Ctrl+click** on an event toggles it in/out of the set. Click without Ctrl clears selection.
- **Click on empty column space** clears selection before creating the new event.
- **Escape** clears selection (global keydown handler).

## Rubber-band (marquee) selection

- **Ctrl+mousedown** on empty column area starts the band: stores `{ col, startY }` in `selDragRef`, initialises `selRect` state.
- **Global mousemove** detects `selDragRef.current`, updates `selRect` (top/height in px).
- **Global mouseup** computes time range from the rect, iterates `eventsRef.current` for events in `sr.col` whose time range overlaps, adds them to `selectedIds`.
- Selection rect renders as a translucent blue rectangle inside the column.

## Batch drag

- Initiated when **mousedown on a selected event while `selectedIds.size > 1`**.
- `batchDragRef` stores: `eventIds`, `baseStartMins` (original startMin per event), `durations`, `baseMouseMin` (snappedMin at drag start).
- During mousemove: delta = `snappedMin - baseMouseMin`, each event's new start = `baseStartMins[id] + delta`. Stored in `batchDisp` state + `batchDispRef`.
- `dispProps()` checks `batchDisp` first → batch-dragged events render at their displaced positions.
- On mouseup: commit via `batchDispRef.current` (avoids stale closure of state).

**Why separate `batchDispRef` from `batchDisp`:** The global mouseup handler is a useEffect closure and can't read the latest `batchDisp` React state. Using a ref gives the commit handler the final positions reliably.
