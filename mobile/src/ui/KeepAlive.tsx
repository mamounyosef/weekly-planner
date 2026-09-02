// ─── Tabs that survive being looked away from ────────────────────────────────
// Switching tabs used to unmount the screen you were on and mount the one you
// asked for, from nothing. Coming back to the calendar meant rebuilding seven
// days of agenda, laying out the grid again, and scrolling it back to the
// current hour — every single time — and the screen arrived with its scroll
// position, its chosen day and its open sections all forgotten.
//
// So a tab that has been visited stays mounted, and is hidden rather than
// destroyed. Returning to it is then a `display` change: no rebuild, no
// re-layout, no scroll to redo, nothing to forget.
//
// THREE THINGS THIS IS CAREFUL ABOUT:
//
//   • NOTHING IS MOUNTED UNTIL IT IS ASKED FOR. Rendering all four screens at
//     launch would move their whole cost onto the splash, which is the thing
//     this work is meant to shorten. A tab appears here the first time you go
//     to it, and not before.
//
//   • A HIDDEN SCREEN IS STILL RUNNING. Its timers tick, its effects hold, its
//     subscriptions stay open. That is deliberate: the calendar's minute hand
//     and the sync indicator have to be right the moment you look back, not a
//     second afterwards. It is also why the cost of leaving them mounted had to
//     be brought down first — see the memoised context in `planner.tsx`.
//
//   • `display: 'none'` REALLY REMOVES IT FROM LAYOUT, unlike zero opacity,
//     which would leave a hidden screen participating in flex sizing and
//     receiving touches. `pointerEvents` is set as well, belt and braces, so a
//     stray press can never reach a screen nobody can see.

import React, { useMemo, useRef } from 'react';
import { View } from 'react-native';

export function KeepAlive({ visible, children }: {
  visible: boolean;
  children: React.ReactNode;
}) {
  /**
   * Has this ever been visible?
   *
   * Once true it stays true: that is the whole lazy-mount rule, and reading it
   * from a ref rather than state means becoming visible costs no extra render.
   */
  const seen = useRef(visible);
  if (visible) seen.current = true;

  const style = useMemo(
    () => ({ flex: 1, display: (visible ? 'flex' : 'none') as 'flex' | 'none' }),
    [visible],
  );

  if (!seen.current) return null;

  return (
    <View style={style} pointerEvents={visible ? 'auto' : 'none'}>
      {children}
    </View>
  );
}
