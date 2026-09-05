/**
 * Drag a row to reorder it.
 *
 * WHY THE DROP IS THE HARDEST PART OF THIS FILE
 *
 * A row is drawn in its slot and then pushed away from it by a transform. Those
 * are two different machines: the transform is set imperatively and reaches the
 * screen on the very next frame, while the slot comes from a React render that
 * lands whenever React gets round to it. On a drop, BOTH have to change -- the
 * transform back to nothing, the slot to the new position -- and if they do not
 * change together the row is drawn wrong in between.
 *
 * They did not change together. Clearing the transform reached the screen at
 * once; the re-render with the new order came only after the drop's write had
 * gone through the merge, the database and the start of a sync, which on a real
 * list is the better part of a second. The whole of that window was painted as
 * the OLD order with no transform: the row sitting exactly where it had been
 * picked up. Then the render landed and it jumped. Drop, snap back, wait, jump.
 *
 * THE RULE THIS FILE NOW KEEPS: never change one without the other. On release
 * the transform is snapped to the exact offset of the slot being dropped into,
 * and the order on screen is FROZEN as it was. That picture -- old order, full
 * transforms -- is pixel for pixel the picture of the new order with no
 * transforms at all. So when the render finally lands and swaps one for the
 * other, nothing moves, however long it took to arrive.
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
  bridgeVerdict, dropIndexFor, reorderList, shiftThreshold, slotSpan, type RowBox,
} from '../lib/dragSort';
import { NO_HOLDS, isHeld, setHold } from '../lib/scrollLock';
import { radius } from '../theme';

/** How long a press has to be held before it becomes a drag. */
export const DRAG_HOLD_MS = 220;

/**
 * How long the list will go on showing a move the parent has not confirmed.
 *
 * Long enough to cover a slow write on a full database, short enough that a
 * move which genuinely failed does not sit there looking like it worked.
 */
export const SETTLE_TTL_MS = 4000;

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

/**
 * What a dragging list can ask of the scroller it sits in.
 *
 * `lock` stops the page moving under the finger. `edgeScroll` is the opposite
 * request and is why it is here at all: with the page frozen, nothing scrolled
 * while a row was held at the top or bottom of the screen, so on a list longer
 * than one screenful a task simply COULD NOT be moved to the bottom. You had to
 * drag, drop, scroll, and drag again. The web's own touch drag has done this
 * properly for a long time; the phone, which needs it more, had nothing.
 *
 * `edgeScroll` is handed the finger's absolute Y on the screen, or null when
 * the drag ends. It answers with how far it has scrolled since the drag began,
 * because the list needs that number: the row has to stay under the finger
 * while the content moves beneath it, and the slot it would land in has to be
 * measured against the content, not against the screen.
 */
interface ScrollControl {
  lock: Lock;
  edgeScroll: (pageY: number | null) => void;
  /** Pixels auto-scrolled since the current drag began. */
  scrolledSinceDrag: () => number;
}

const ScrollLock = React.createContext<ScrollControl | null>(null);

let nextListId = 1;

/** How close to an edge the finger has to be before the page starts moving. */
const EDGE_ZONE_PX = 84;
/** The fastest the page moves, in pixels per frame, at the very edge. */
const EDGE_SPEED_MAX = 14;

/**
 * A ScrollView that stops scrolling while anything inside it is being dragged.
 *
 * Ref counted, because a screen can hold several lists and a card can hold a
 * list of its own. A drag that ends any way at all (dropped, cancelled, the
 * row unmounted underneath it) releases its own hold, so the page can never be
 * left unable to scroll.
 */
export function SortableScrollView({ children, ...props }: ScrollViewProps) {
  const scroller = useRef<ScrollView>(null);
  const held = useRef<readonly number[]>(NO_HOLDS);
  const [locked, setLocked] = useState(false);
  const allowed = props.scrollEnabled !== false;

  // ── Auto-scroll while a row is held at an edge ───────────────────────────
  // Everything here is refs: this runs on a timer during a gesture, and a
  // render per frame is exactly what the drag cannot afford.
  const viewTop = useRef(0);
  const viewHeight = useRef(0);
  const scrollY = useRef(0);
  const contentHeight = useRef(0);
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fingerY = useRef<number | null>(null);
  const scrolledSinceDrag = useRef(0);

  const stopEdgeScroll = () => {
    if (edgeTimer.current) { clearInterval(edgeTimer.current); edgeTimer.current = null; }
    fingerY.current = null;
  };

  const edgeScroll = useMemo(() => (pageY: number | null) => {
    if (pageY === null) { stopEdgeScroll(); scrolledSinceDrag.current = 0; return; }
    fingerY.current = pageY;
    if (edgeTimer.current) return;

    edgeTimer.current = setInterval(() => {
      const y = fingerY.current;
      const h = viewHeight.current;
      if (y === null || h <= 0) return;

      const fromTop = y - viewTop.current;
      const fromBottom = viewTop.current + h - y;

      // Proportional, so the page creeps near the edge of the zone and moves
      // properly at the very edge. A single fixed speed either overshoots the
      // row you were aiming for or takes too long to be worth using.
      let step = 0;
      if (fromTop < EDGE_ZONE_PX) {
        step = -EDGE_SPEED_MAX * Math.min(1, (EDGE_ZONE_PX - fromTop) / EDGE_ZONE_PX);
      } else if (fromBottom < EDGE_ZONE_PX) {
        step = EDGE_SPEED_MAX * Math.min(1, (EDGE_ZONE_PX - fromBottom) / EDGE_ZONE_PX);
      }
      if (step === 0) return;

      // Clamped to the real ends, or `scrolledSinceDrag` would go on counting
      // movement that never happened and the row would drift off the finger.
      const maxY = Math.max(0, contentHeight.current - h);
      const next = Math.max(0, Math.min(maxY, scrollY.current + step));
      const moved = next - scrollY.current;
      if (moved === 0) return;

      scrollY.current = next;
      scrolledSinceDrag.current += moved;
      // Not animated: this IS the animation, one small step per frame.
      scroller.current?.scrollTo({ y: next, animated: false });
    }, 16);
  }, []);

  useEffect(() => stopEdgeScroll, []);

  const lock = useMemo<Lock>(() => (id, on) => {
    const next = setHold(held.current, id, on);
    if (next === held.current) return;
    held.current = next;

    // IMPERATIVELY FIRST, AND THROUGH STATE AS WELL.
    //
    // A long press is accepted in JS, and the scroller is asked to stop
    // scrolling. Going through state alone, that request does not reach the
    // native view until React has committed a render -- and on Android the
    // native ScrollView decides whether to take a vertical drag BEFORE the JS
    // responder system is consulted. A finger that starts moving inside that
    // gap is taken by the scroller, the drag never happens, and the page scrolls
    // instead. It is rare, it is entirely dependent on how busy the thread is,
    // and it is exactly the kind of thing that reads as "the app is flaky".
    //
    // `setNativeProps` reaches the view in this same tick. The state update
    // follows so the next render agrees with what the view is already doing,
    // rather than handing it the old value back.
    try {
      scroller.current?.setNativeProps({ scrollEnabled: allowed && !isHeld(next) });
    } catch {
      // An unmounted or not-yet-mounted scroller. The state update below is the
      // fallback, and it is correct, just a frame later.
    }
    setLocked(isHeld(next));
  }, [allowed]);

  const control = useMemo<ScrollControl>(
    () => ({ lock, edgeScroll, scrolledSinceDrag: () => scrolledSinceDrag.current }),
    [lock, edgeScroll],
  );

  return (
    <ScrollLock.Provider value={control}>
      <ScrollView
        {...props}
        ref={scroller}
        scrollEnabled={allowed && !locked}
        // The three measurements the edge scroll needs, taken from the events
        // that already fire rather than by measuring on demand mid-gesture.
        onLayout={e => {
          viewHeight.current = e.nativeEvent.layout.height;
          // Where the scroller sits on the screen, so the finger's absolute Y
          // can be compared with its edges. Measured rather than assumed: this
          // view sits under a header whose height differs per screen.
          (scroller.current as unknown as {
            measureInWindow?: (cb: (x: number, y: number) => void) => void;
          } | null)?.measureInWindow?.((_x, y) => { viewTop.current = y; });
          props.onLayout?.(e);
        }}
        onScroll={e => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          props.onScroll?.(e);
        }}
        onContentSizeChange={(w, h) => {
          contentHeight.current = h;
          props.onContentSizeChange?.(w, h);
        }}
        scrollEventThrottle={props.scrollEventThrottle ?? 16}
      >
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
  gap = 0,
  sortable = true,
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, index: number, drag: DragHandle) => React.ReactNode;
  onReorder: (from: number, to: number) => void;
  /** Space between rows. Counted into the slot a dragged row leaves behind. */
  gap?: number;
  /**
   * Whether a hand-made order means anything in this list.
   *
   * False for a list that is sorted by something else entirely -- Done is in the
   * order things were finished -- where a drag would lift the row, move it, drop
   * it, and have the list put it straight back. Offering a gesture that cannot
   * work is worse than not offering it: the user is left thinking the app is
   * broken rather than that the list is not theirs to arrange.
   */
  sortable?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);

  /**
   * The new order, drawn by this list until the parent's own order agrees.
   *
   * A BRIDGE, NOT A SECOND SOURCE OF TRUTH. The parent owns where things go;
   * this only covers the gap between the finger lifting and the parent saying
   * so, which is as long as a merge, a database write and the start of a sync
   * take. It is dropped the moment `data` matches it, and dropped anyway after
   * a few seconds if it never does.
   */
  const [settled, setSettled] = useState<readonly T[] | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const control = useContext(ScrollLock);
  // Through a ref, like `dataRef` above: the PanResponder is built once and
  // would otherwise hold the first render's context value forever.
  const controlRef = useRef(control);
  controlRef.current = control;
  useEffect(() => {
    control?.lock(listId, active !== null);
    return () => { control?.lock(listId, false); };
  }, [active, listId, control]);

  // A stale measurement past the end of the list would let a drag "reach" a row
  // that is not there any more.
  if (boxes.current.length > data.length) boxes.current.length = data.length;

  const buzz = (ms: number) => { try { Vibration.vibrate(ms); } catch { /* no vibrator */ } };

  /** Give up the gesture with nothing moved: the picture is already right. */
  const finish = () => {
    activeRef.current = null;
    granted.current = false;
    // Whatever ended the drag -- a drop, a cancel, the row unmounting -- the
    // page must stop moving with it, or it would go on scrolling on its own.
    controlRef.current?.edgeScroll(null);
    pan.setValue(0);
    setActive(null);
  };

  const start = (index: number) => {
    if (!sortable) return;
    activeRef.current = index;
    granted.current = false;
    // Zeroes the auto-scroll counter as well as stopping any leftover loop, so
    // this drag starts measuring from nothing.
    controlRef.current?.edgeScroll(null);
    pan.setValue(0);
    setActive(index);
    // A new drag ends any bridge the last one left behind. Its own drop is
    // about to say where everything goes.
    setSettled(null);
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
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
    onPanResponderMove: (_, g) => {
      // Ask the page to move if the finger is at an edge, and take back how far
      // it has moved so far. The row has to stay under the FINGER while the
      // content slides beneath it, so its displacement within the content is
      // the finger's travel plus everything the page has scrolled.
      controlRef.current?.edgeScroll(g.moveY);
      pan.setValue(g.dy + (controlRef.current?.scrolledSinceDrag() ?? 0));
    },
    // Nobody gets to take a drag back once it has started, least of all the
    // scroller this list is sitting in.
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderRelease: (_, g) => {
      const from = activeRef.current;
      if (from === null) { finish(); return; }

      // The page stops moving the instant the finger lifts, but what it has
      // already scrolled still counts towards where the row landed.
      const scrolled = controlRef.current?.scrolledSinceDrag() ?? 0;
      controlRef.current?.edgeScroll(null);

      const items = dataRef.current;
      // The SAME displacement the transform has been drawing all along, or the
      // row would be dropped into a different slot from the one it was
      // visibly sitting in.
      const travel = g.dy + scrolled;
      const to = dropIndexFor(boxes.current, from, travel, items.length);

      // Dropped where it was picked up: the settled picture is this one with no
      // transform, so clearing it now is already correct.
      if (to === from) { finish(); return; }

      buzz(8);

      // 1. SNAP THE TRANSFORM TO THE SLOT, IMMEDIATELY. This is imperative and
      //    reaches the screen on the next frame no matter how busy the JS
      //    thread is about to get. The row lands in the gap the moment the
      //    finger leaves it, which is the whole feel of a drop. Half measured
      //    lists fall back to where the finger actually was, which is within
      //    half a row of right and never wrong enough to look broken.
      const offset = shiftThreshold(boxes.current, from, to);
      pan.setValue(offset === null ? travel : offset);

      // 2. Tell the parent. Everything from here on may block for a long time
      //    -- the merge, the database, the start of a sync -- and none of it
      //    can spoil the picture any more, because the picture is not waiting
      //    on it. Until the render below lands, the screen goes on showing the
      //    OLD order with the transform above, which IS the dropped layout.
      reorderRef.current(from, to);

      // 3. The new order with the transforms gone, in ONE render. Every state
      //    change in this handler lands in that single commit, so the screen
      //    never sees the new order still carrying a transform, nor the old one
      //    without it -- which was the row appearing back where it started.
      //    Before and after are the same picture, so nothing moves when it
      //    arrives, however late that is.
      activeRef.current = null;
      granted.current = false;
      setSettled(reorderList(items, from, to));
      setActive(null);

      // The bridge is dropped as soon as the parent's own order agrees with it,
      // in the effect below. This is the safety net for the case where it never
      // does -- a write that failed, a sync that overruled it -- so that the
      // screen goes back to telling the truth rather than showing a move that
      // did not happen.
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        setSettled(null);
      }, SETTLE_TTL_MS);
    },
    onPanResponderTerminate: () => finish(),
  })).current;

  /**
   * What is on screen: the bridged order while a drop is settling, and simply
   * what the parent says the rest of the time.
   */
  const shown = settled ?? data;

  // The bridge lives exactly as long as the parent takes to catch up, and not
  // one render longer.
  useEffect(() => {
    if (!settled) return;

    const drop = () => {
      setSettled(null);
      if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
    };

    // The decision itself is in `dragSort.ts`, where it is tested. Getting it
    // wrong shows either a stale list or the flicker this exists to remove, and
    // neither is something a thumb can reliably reproduce.
    const verdict = bridgeVerdict(
      settled.map((item, i) => keyExtractor(item, i)),
      data.map((item, i) => keyExtractor(item, i)),
    );
    if (verdict !== 'waiting') drop();
  }, [data, settled, keyExtractor]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const span = active === null ? 0 : slotSpan(boxes.current, active);

  return (
    <View style={gap > 0 ? { gap } : undefined} {...responder.panHandlers}>
      {shown.map((item, index) => {
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
