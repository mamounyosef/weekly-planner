/**
 * Drag a row to reorder it.
 *
 * THE THREE THINGS THAT MADE THE OLD ONE DO NOTHING
 *
 * 1. The list lives inside a ScrollView. On Android the scroller intercepts a
 *    vertical drag NATIVELY, before the JS responder system ever gets a look,
 *    so the pan handler was simply never granted and the finger just scrolled
 *    the page. Nothing in the component itself was wrong; it was never asked.
 *    The fix is `SortableScrollView`: the list switches its scroller off for
 *    the duration of the drag, through a context, so a row nested three levels
 *    down (a subtask inside a card inside the list) can still do it.
 *
 * 2. Even once granted, the pan had `onPanResponderTerminationRequest` at its
 *    default, which is "yes, take it": the scroller could snatch the gesture
 *    back mid-drag and the row would spring home.
 *
 * 3. Rows were keyed by INDEX. A reorder then hands row 3's component row 4's
 *    task, and React reuses the node rather than remounting it, which is how a
 *    card ends up drawn at a size that was measured for a different task. Keys
 *    come from the caller now, and they are identity, not position.
 *
 * All the arithmetic (where it lands, how far the others move aside) lives in
 * `lib/dragSort.ts` and is unit tested. This file is only the gesture and the
 * animation.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, LayoutChangeEvent, PanResponder, ScrollView, ScrollViewProps,
  Vibration, View,
} from 'react-native';
import {
  dropIndexFor, shiftThreshold, slotSpan, type RowBox,
} from '../lib/dragSort';
import { radius } from '../theme';

/** How long a press has to be held before it becomes a drag. */
export const DRAG_HOLD_MS = 220;

/** What a row needs to take part. Spread `handlers` onto its Pressable. */
export interface DragHandle {
  /** True while THIS row is the one under the finger. */
  active: boolean;
  handlers: {
    onLongPress: () => void;
    onPressOut: () => void;
    delayLongPress: number;
  };
}

// ─── The scroll lock ─────────────────────────────────────────────────────────

type Lock = (id: number, held: boolean) => void;

const ScrollLock = React.createContext<Lock | null>(null);

let nextListId = 1;

/**
 * A ScrollView that stops scrolling while anything inside it is being dragged.
 *
 * Ref counted, because a screen can hold several lists and a card can hold a
 * list of its own. A drag that ends any way at all (dropped, cancelled, the
 * row unmounted underneath it) releases its own hold, so the page can never be
 * left unable to scroll.
 */
export function SortableScrollView({ children, ...props }: ScrollViewProps) {
  const held = useRef<Set<number>>(new Set()).current;
  const [locked, setLocked] = useState(false);

  const lock = useMemo<Lock>(() => (id, on) => {
    if (on) held.add(id); else held.delete(id);
    setLocked(held.size > 0);
  }, [held]);

  return (
    <ScrollLock.Provider value={lock}>
      <ScrollView {...props} scrollEnabled={props.scrollEnabled !== false && !locked}>
        {children}
      </ScrollView>
    </ScrollLock.Provider>
  );
}

// ─── The list ────────────────────────────────────────────────────────────────

export function SortableList<T>({
  data,
  keyExtractor,
  renderItem,
  onReorder,
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, index: number, drag: DragHandle) => React.ReactNode;
  onReorder: (from: number, to: number) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);
  // Whether the pan actually took the gesture. A long press that is released
  // without moving never grants, and only that case may be cancelled by the
  // row's own press-out -- the same press-out arrives when the pan TAKES the
  // gesture off the Pressable, and acting on that one would end every drag the
  // instant it began.
  const granted = useRef(false);
  const pan = useRef(new Animated.Value(0)).current;
  const boxes = useRef<Array<RowBox | undefined>>([]);
  const listId = useRef(nextListId++).current;

  // Read at gesture time, not at the time the responder was built: the pan is
  // created once and the list changes under it constantly.
  const dataRef = useRef(data);
  dataRef.current = data;
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;

  const lock = useContext(ScrollLock);
  useEffect(() => {
    lock?.(listId, active !== null);
    return () => { lock?.(listId, false); };
  }, [active, listId, lock]);

  // A stale measurement past the end of the list would let a drag "reach" a row
  // that is not there any more.
  if (boxes.current.length > data.length) boxes.current.length = data.length;

  const buzz = (ms: number) => { try { Vibration.vibrate(ms); } catch { /* no vibrator */ } };

  const finish = () => {
    activeRef.current = null;
    granted.current = false;
    pan.setValue(0);
    setActive(null);
  };

  const start = (index: number) => {
    activeRef.current = index;
    granted.current = false;
    pan.setValue(0);
    setActive(index);
    buzz(12);
  };

  /** The row was let go without ever moving: a long press and nothing more. */
  const cancelIfIdle = () => {
    if (!granted.current && activeRef.current !== null) finish();
  };

  const responder = useRef(PanResponder.create({
    // A tap still belongs to the row it landed on.
    onStartShouldSetPanResponderCapture: () => false,
    // Capture, so the gesture is taken off the row's own Pressable the moment
    // the finger moves, rather than after it has decided the press is over.
    onMoveShouldSetPanResponderCapture: (_, g) => (
      activeRef.current !== null && Math.abs(g.dy) > 1
    ),
    onPanResponderGrant: () => {
      granted.current = true;
      pan.setValue(0);
    },
    onPanResponderMove: (_, g) => { pan.setValue(g.dy); },
    // Nobody gets to take a drag back once it has started, least of all the
    // scroller this list is sitting in.
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderRelease: (_, g) => {
      const from = activeRef.current;
      if (from === null) { finish(); return; }
      const to = dropIndexFor(boxes.current, from, g.dy, dataRef.current.length);
      finish();
      if (to !== from) {
        buzz(8);
        reorderRef.current(from, to);
      }
    },
    onPanResponderTerminate: () => finish(),
  })).current;

  const span = active === null ? 0 : slotSpan(boxes.current, active);

  return (
    <View {...responder.panHandlers}>
      {data.map((item, index) => {
        const isActive = index === active;

        // Every row that the dragged one has passed slides one whole slot out
        // of its way, driven straight off the pan value: no state, no re-render
        // per frame, and the moment a row moves on screen is by construction
        // the moment the drop index counts it as passed.
        let motion: Animated.AnimatedInterpolation<number> | Animated.Value | null = null;
        if (isActive) {
          motion = pan;
        } else if (active !== null && span > 0) {
          const t = shiftThreshold(boxes.current, active, index);
          if (t !== null) {
            const lead = Math.min(24, span / 2);
            motion = index > active
              ? pan.interpolate({ inputRange: [t - lead, t], outputRange: [0, -span], extrapolate: 'clamp' })
              : pan.interpolate({ inputRange: [t, t + lead], outputRange: [span, 0], extrapolate: 'clamp' });
          }
        }

        return (
          <Animated.View
            key={keyExtractor(item, index)}
            onLayout={(e: LayoutChangeEvent) => {
              const { y, height } = e.nativeEvent.layout;
              boxes.current[index] = { y, height };
            }}
            style={[
              // The radius is here for the SHADOW, not for the corners: with no
              // outline of its own an elevated wrapper casts a rectangular
              // shadow around a rounded card.
              isActive
                ? {
                    zIndex: 20,
                    elevation: 8,
                    borderRadius: radius.md,
                    shadowColor: '#000',
                    shadowOpacity: 0.3,
                    shadowRadius: 12,
                    shadowOffset: { width: 0, height: 5 },
                  }
                : { zIndex: 1 },
              motion
                ? { transform: isActive ? [{ translateY: motion }, { scale: 1.02 }] : [{ translateY: motion }] }
                : null,
            ]}
          >
            {renderItem(item, index, {
              active: isActive,
              handlers: {
                onLongPress: () => start(index),
                onPressOut: cancelIfIdle,
                delayLongPress: DRAG_HOLD_MS,
              },
            })}
          </Animated.View>
        );
      })}
    </View>
  );
}
