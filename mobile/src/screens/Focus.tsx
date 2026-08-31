// ─── Focus ───────────────────────────────────────────────────────────────────
// Where the time goes, and where it went. Two halves of one screen, in that
// order, because a place you only ever look back from is a report and a place
// you can start from is a tool.
//
// THE LIVE HALF
// The clock at the top is the hero: big enough to read across a desk, and laid
// out one character per fixed-width cell so the digits never shuffle sideways as
// the seconds change. There is no monospace font to lean on here, and a hero
// clock that fidgets twice a second is the difference between calm and nervous.
//
// NOTHING ON THIS SCREEN COUNTS. Every number is derived from the stored start
// instant against the current clock, in `focusTimer.ts`, which is the only way a
// timer survives Android suspending the app: an interval that stops for twenty
// minutes leaves a counter twenty minutes short and nothing to notice it by. The
// one-second tick below exists purely to repaint. Delete it and the numbers are
// still right, they just stop moving.
//
// THE RING is plain Views. Two half-width clipping masks, each holding a circle
// with two of its four borders coloured (which draws exactly a 180 degree arc)
// rotated to where the arc should start. A charting or SVG library here would
// have to be a native one, and a native module would end over-the-air updates
// for this whole app: from then on every change reaches the phone only as a new
// APK. A ring is not worth that.
//
// THE BACKWARD HALF
// A total is not an answer on its own; the useful thing is the shape. So the
// range leads with one number, then the days as bars, because a week of ragged
// bars and a week of even ones mean completely different things and no total
// distinguishes them. Empty days are drawn as empty rather than skipped: a chart
// with the gaps closed up reads as unbroken work.
//
// The maths lives in `focusStats.ts` and the state machine in `focusTimer.ts`,
// both shared with the PC, so the two can never disagree about yesterday or
// about how long a session ran.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { HIT, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import {
  dateKey,
  describeDuration,
  focusDayKey,
  summariseFocus,
  type FocusSessionRecord,
} from '../lib/focusStats';
import {
  IDLE_FOCUS_TIMER,
  coerceFocusTimer,
  focusElapsedSeconds,
  focusIsOverdue,
  focusPhase,
  focusProgress,
  focusRemainingSeconds,
  focusUncreditedSeconds,
  formatFocusClock,
  formatFocusLength,
  reduceFocusTimer,
  type FocusTimerAction,
  type FocusTimerState,
} from '../lib/focusTimer';
import {
  computeGoalStats,
  adjustDayTotal,
  editSingleSession,
} from '../lib/focusGoals';
import { Field, Stepper } from '../ui/Fields';

type Range = 'week' | 'month' | 'year';

const RANGES: { id: Range; label: string; days: number }[] = [
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
];

/** The lengths worth one tap. Anything else is a rare enough case to live on the PC. */
const PRESETS = [15, 25, 45, 60, 90];

/**
 * What the planner context is expected to provide once the timer is wired in.
 *
 * Read through a cast rather than as required context fields, and with a local
 * fallback below, so this screen works the moment it lands and gains its memory
 * across restarts when the context grows to match. The alternative is a screen
 * that cannot even be opened until an unrelated file has changed.
 */
interface FocusTimerBridge {
  focusTimer?: unknown;
  runFocusTimer?: (action: FocusTimerAction) => void | Promise<void>;
}

/** Which confirmation, if any, is being asked for. */
type Pending = null | 'finish' | 'discard';

export function Focus() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const planner = usePlanner();
  const { focusSessions, shared, syncNow, saveRecord } = planner;

  const bridge = planner as unknown as FocusTimerBridge;
  const wired = typeof bridge.runFocusTimer === 'function';

  const [range, setRange] = useState<Range>('week');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  const focusDailyGoalSeconds = typeof (shared as any).focusDailyGoalSeconds === 'number'
    ? (shared as any).focusDailyGoalSeconds
    : 0;

  // Only ever used until the context owns the timer. Kept in a ref as well as in
  // state because an action has to read the CURRENT state, and a callback that
  // closed over an older render would silently re-anchor a running session.
  const [localTimer, setLocalTimer] = useState<FocusTimerState>(IDLE_FOCUS_TIMER);
  const localRef = useRef(localTimer);
  localRef.current = localTimer;

  const timer = useMemo(
    () => coerceFocusTimer(wired ? bridge.focusTimer : localTimer),
    [wired, bridge.focusTimer, localTimer],
  );

  // The repaint tick. It carries no information: every number below is computed
  // from `now` against the stored anchor, so a missed tick costs a frame and
  // never a second.
  const [now, setNow] = useState(() => Date.now());
  const phase = focusPhase(timer);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Coming back from the background is the case that matters: the clock may have
  // moved by hours, and the session may have finished long ago.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') setNow(Date.now());
    });
    return () => sub.remove();
  }, []);

  const run = useCallback((action: FocusTimerAction) => {
    setPending(null);
    if (wired) {
      void bridge.runFocusTimer!(action);
      setNow(Date.now());
      return;
    }
    const out = reduceFocusTimer(localRef.current, action, Date.now(), 'phone');
    if (!out.changed) return;
    localRef.current = out.state;
    setLocalTimer(out.state);
    setNow(Date.now());
    // A finished session is history the moment it ends, so it goes to the same
    // store the PC's sessions arrive in and merges by id.
    if (out.session) {
      void saveRecord('focusSessions', out.session.id, { ...out.session });
    }
  }, [wired, bridge, saveRecord]);

  // A session that ran past its planned length while the app was closed is
  // finished, and finished at the moment it ran out. Settling on every tick is
  // what puts it on the right day instead of on the day you next looked.
  useEffect(() => {
    if (focusIsOverdue(timer, now)) run({ kind: 'settle' });
  }, [timer, now, run]);

  const dayStartHour = typeof (shared as any).focusDayStartHour === 'number'
    ? (shared as any).focusDayStartHour
    : 0;

  const summary = useMemo(() => {
    const days = RANGES.find(r => r.id === range)!.days;
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    return summariseFocus(focusSessions as FocusSessionRecord[], {
      from: dateKey(from),
      to: dateKey(to),
      dayStartHour,
    });
  }, [focusSessions, range, dayStartHour]);

  /**
   * Today's total, including the session still running.
   *
   * The live part is the UNCREDITED elapsed time, never the raw elapsed: editing
   * a day's figure on the PC while a session runs banks what has been run so far
   * into the day directly, and counting it here as well would show the same
   * minutes twice and then log them twice when the session ends.
   */
  const todaySeconds = useMemo(() => {
    const key = focusDayKey(new Date(now), dayStartHour);
    const logged = summariseFocus(focusSessions as FocusSessionRecord[], {
      from: key, to: key, dayStartHour,
    }).totalSeconds;
    return logged + (phase === 'running' ? focusUncreditedSeconds(timer, now) : 0);
  }, [focusSessions, dayStartHour, now, phase, timer]);

  const goalStats = useMemo(() => {
    return computeGoalStats(focusSessions as FocusSessionRecord[], {
      now: new Date(now).toISOString(),
      goalSeconds: focusDailyGoalSeconds,
      dayStartHour,
    });
  }, [focusSessions, now, focusDailyGoalSeconds, dayStartHour]);

  const refresh = async () => {
    setRefreshing(true);
    try { await syncNow(); } finally { setRefreshing(false); }
  };

  const peak = summary.bestDay?.seconds ?? 0;
  // A year of daily bars is unreadable on a phone, so the long ranges show the
  // last stretch in detail rather than a smear of hairlines.
  const bars = range === 'year' ? summary.days.slice(-52) : summary.days;

  const elapsed = focusElapsedSeconds(timer, now);
  const remaining = focusRemainingSeconds(timer, now);
  const progress = focusProgress(timer, now);
  const ring = Math.min(268, Math.max(200, width - space.xl * 2 - space.lg * 2));

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View>
            <Text variant="caption" tone="faint">
              {phase === 'idle' ? 'HOW THE TIME GOES' : 'SESSION IN PROGRESS'}
            </Text>
            <Text variant="display">Focus</Text>
            {focusDailyGoalSeconds > 0 && (
              <Row gap={space.xs} style={{ marginTop: space.xs }}>
                <View style={{ width: 48, height: 4, backgroundColor: p.surfaceAlt, borderRadius: 2, overflow: 'hidden' }}>
                  <View style={{ width: `${goalStats.todayProgress * 100}%`, height: '100%', backgroundColor: goalStats.todayProgress >= 1 ? p.accent : p.inkSoft }} />
                </View>
                <Text variant="caption" tone={goalStats.todayProgress >= 1 ? 'accent' : 'soft'}>
                  {Math.round(goalStats.todayProgress * 100)}% of goal
                </Text>
              </Row>
            )}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="caption" tone="faint">TODAY</Text>
            <Text variant="title" tone={todaySeconds > 0 ? 'accent' : 'faint'}>
              {describeDuration(todaySeconds)}
            </Text>
          </View>
        </Row>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.xxl,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} />
        }
      >
        {/* ── The live timer ─────────────────────────────────────────────── */}
        <View style={{
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: phase === 'running' ? p.accent : p.line,
          backgroundColor: p.surface,
          padding: space.lg,
          alignItems: 'center',
          marginBottom: space.xl,
        }}>
          <Ring size={ring} progress={progress} phase={phase}>
            <Clock
              text={formatFocusClock(phase === 'idle' ? timer.plannedSeconds : remaining)}
              size={Math.round(ring * 0.21)}
            />
            <Text variant="label" tone="faint" style={{ marginTop: space.xs }}>
              {phase === 'idle' ? 'READY' : phase === 'paused' ? 'PAUSED' : 'LEFT'}
            </Text>
            {phase !== 'idle' ? (
              <Text variant="caption" tone="soft" style={{ marginTop: 2 }}>
                {formatFocusLength(elapsed)} of {formatFocusLength(timer.plannedSeconds)}
              </Text>
            ) : null}
          </Ring>

          <View style={{ height: space.lg }} />

          {pending ? (
            <Confirm
              kind={pending}
              elapsed={elapsed}
              onCancel={() => setPending(null)}
              onConfirm={() => run({ kind: pending === 'finish' ? 'stop' : 'discard' })}
            />
          ) : phase === 'idle' ? (
            <>
              <Row gap={space.xs} style={{ marginBottom: space.lg }}>
                {PRESETS.map(mins => {
                  const on = timer.plannedSeconds === mins * 60;
                  return (
                    <Pressable
                      key={mins}
                      onPress={() => run({ kind: 'setPlanned', seconds: mins * 60 })}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${mins} minute session`}
                      style={{
                        flex: 1,
                        height: 40,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: radius.sm,
                        borderWidth: 1,
                        borderColor: on ? p.accent : p.line,
                        backgroundColor: on ? p.accentSoft : 'transparent',
                      }}
                    >
                      <Text variant="bodyStrong" style={{ color: on ? p.accent : p.inkSoft }}>
                        {mins}
                      </Text>
                    </Pressable>
                  );
                })}
              </Row>
              <BigButton label="Start focus" tone="go" onPress={() => run({ kind: 'start' })} />
            </>
          ) : (
            <>
              <BigButton
                label={phase === 'running' ? 'Pause' : 'Resume'}
                tone={phase === 'running' ? 'hold' : 'go'}
                onPress={() => run({ kind: phase === 'running' ? 'pause' : 'resume' })}
              />
              <Row gap={space.sm} style={{ marginTop: space.md, alignSelf: 'stretch' }}>
                <SmallButton label="Finish" onPress={() => setPending('finish')} />
                <SmallButton label="Discard" tone="danger" onPress={() => setPending('discard')} />
              </Row>
            </>
          )}
        </View>

        {/* ── The history ────────────────────────────────────────────────── */}
        <Row
          gap={0}
          style={{
            backgroundColor: p.surfaceAlt,
            borderRadius: radius.md,
            padding: 3,
            borderWidth: 1,
            borderColor: p.line,
            marginBottom: space.xl,
          }}
        >
          {RANGES.map(r => {
            const on = r.id === range;
            return (
              <Pressable
                key={r.id}
                onPress={() => { setRange(r.id); setSelectedDay(null); }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={{
                  flex: 1, height: 38, alignItems: 'center', justifyContent: 'center',
                  borderRadius: radius.sm,
                  backgroundColor: on ? p.accent : 'transparent',
                }}
              >
                <Text variant="bodyStrong" style={{ color: on ? p.accentInk : p.inkSoft }}>
                  {r.label}
                </Text>
              </Pressable>
            );
          })}
        </Row>

        {summary.sessions === 0 ? (
          <View style={{ paddingTop: space.lg, alignItems: 'center', gap: space.sm }}>
            <Text variant="heading" tone="soft">No focus time yet</Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 280 }}>
              Start a session above, or run one on your PC. Both land here together.
            </Text>
          </View>
        ) : (
          <>
            {/* The headline. One number, big, with the rest as support. */}
            <View style={{ marginBottom: space.xl }}>
              <Text variant="label" tone="faint" style={{ letterSpacing: 1 }}>
                {range === 'week' ? 'THIS WEEK' : range === 'month' ? 'LAST 30 DAYS' : 'LAST YEAR'}
              </Text>
              <Text
                variant="display"
                style={{ fontSize: 44, lineHeight: 50, marginTop: 2, color: p.accent }}
              >
                {describeDuration(summary.totalSeconds)}
              </Text>
              <Text variant="caption" tone="soft" style={{ marginTop: 2 }}>
                {summary.sessions} session{summary.sessions === 1 ? '' : 's'}
              </Text>
            </View>

            <Chart days={bars} peak={peak} compact={range !== 'week'} />

            <Row gap={space.sm} style={{ marginTop: space.xl }}>
              <Stat label="Average day" value={describeDuration(summary.averageSeconds)}
                hint="over days you worked" />
              <Stat label="Best day" value={describeDuration(summary.bestDay?.seconds ?? 0)}
                hint={summary.bestDay ? niceDate(summary.bestDay.date) : undefined} />
            </Row>

            <Row gap={space.sm} style={{ marginTop: space.sm }}>
              <Stat
                label="Current streak"
                value={goalStats.currentStreak === 0 ? 'None' : `${goalStats.currentStreak} day${goalStats.currentStreak === 1 ? '' : 's'}`}
                hint={goalStats.currentStreak === 0 ? 'nothing today yet' : 'in a row'}
              />
              <Stat
                label="Best streak"
                value={`${goalStats.bestStreak} day${goalStats.bestStreak === 1 ? '' : 's'}`}
                hint="all time"
              />
            </Row>

            {selectedDay ? (
              <DayDetail
                date={selectedDay}
                sessions={focusSessions as FocusSessionRecord[]}
                dayStartHour={dayStartHour}
                onClose={() => setSelectedDay(null)}
                onEditTotal={(newTotal: number) => {
                  const activeKey = timer.sessionStartedAt ? focusDayKey(timer.sessionStartedAt, dayStartHour) : '';
                  if (activeKey && activeKey === selectedDay) {
                    const elaps = focusElapsedSeconds(timer, now);
                    const cred = Math.max(0, timer.creditedSeconds ?? 0);
                    if (elaps !== cred) {
                      run({ kind: 'credit', seconds: elaps });
                    }
                  }
                  const { mutated, deletedIds } = adjustDayTotal(focusSessions as FocusSessionRecord[], {
                    dateKeyVal: selectedDay,
                    newTotalSeconds: newTotal,
                    dayStartHour
                  });
                  mutated.forEach(s => void saveRecord('focusSessions', s.id, { ...s }));
                  // use delete_field for deletions
                  deletedIds.forEach(id => void saveRecord('focusSessions', id, { __deleted: true }));
                }}
                onEditSession={(id: string, newDur: number) => {
                  const s = (focusSessions as FocusSessionRecord[]).find(x => x.id === id);
                  if (s) {
                    const { mutated, deletedIds } = editSingleSession(s, newDur);
                    mutated.forEach(m => void saveRecord('focusSessions', m.id, { ...m }));
                    deletedIds.forEach(did => void saveRecord('focusSessions', did, { __deleted: true }));
                  }
                }}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * The progress ring, drawn with four Views and no dependency.
 *
 * A circle with only its top and right borders coloured is exactly a 180 degree
 * arc, spanning [r - 45, r + 135] once rotated by r. Clip the box to its right
 * half and rotate that arc so it ENDS at the current angle, and the visible part
 * is the fill from twelve o'clock round to wherever the session has got to; the
 * left half picks up the same arc for anything past halfway. Two masks, one
 * formula, no library.
 */
function Ring({ size, progress, phase, children }: {
  size: number;
  progress: number;
  phase: 'idle' | 'running' | 'paused';
  children: React.ReactNode;
}) {
  const p = useTheme();
  const stroke = Math.max(8, Math.round(size * 0.045));
  const angle = Math.min(360, Math.max(0, progress * 360));
  const colour = phase === 'paused' ? p.inkFaint : p.accent;

  // The arc is placed by where it ENDS, so both halves share one rotation.
  const rightRotation = Math.min(angle, 180) - 135;
  const leftRotation = Math.max(angle, 180) - 135;

  const arc = (rotation: number) => ({
    position: 'absolute' as const,
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: stroke,
    borderColor: 'transparent',
    borderTopColor: colour,
    borderRightColor: colour,
    transform: [{ rotate: `${rotation}deg` }],
  });

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* The track. Always a full circle, so the ring reads as a ring even at zero. */}
      <View style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: stroke,
        borderColor: p.line,
      }} />

      {/* Right half: the first 180 degrees. */}
      <View style={{
        position: 'absolute', right: 0, top: 0, width: size / 2, height: size, overflow: 'hidden',
      }}>
        <View style={[arc(rightRotation), { right: 0 }]} />
      </View>

      {/* Left half: anything past halfway. */}
      {angle > 180 ? (
        <View style={{
          position: 'absolute', left: 0, top: 0, width: size / 2, height: size, overflow: 'hidden',
        }}>
          <View style={[arc(leftRotation), { left: 0 }]} />
        </View>
      ) : null}

      <View style={{ alignItems: 'center', paddingHorizontal: stroke * 2 }}>{children}</View>
    </View>
  );
}

/**
 * The clock, one character per fixed-width cell.
 *
 * Proportional digits are different widths, so a plain string re-centres itself
 * on almost every tick and the whole line jitters. Giving each character a cell
 * of its own holds every digit exactly where it was; only the leading hour can
 * change the overall width, and that happens once an hour.
 */
function Clock({ text, size }: { text: string; size: number }) {
  const digit = Math.round(size * 0.6);
  const colon = Math.round(size * 0.3);
  return (
    <Row gap={0} align="baseline">
      {text.split('').map((ch, i) => (
        <View key={`${i}-${ch}`} style={{ width: ch === ':' ? colon : digit, alignItems: 'center' }}>
          <Text
            variant="display"
            style={{ fontSize: size, lineHeight: Math.round(size * 1.1), fontWeight: '800', letterSpacing: 0 }}
          >
            {ch}
          </Text>
        </View>
      ))}
    </Row>
  );
}

/** The one action that matters, sized so it cannot be missed or mistaken. */
function BigButton({ label, tone, onPress }: {
  label: string;
  tone: 'go' | 'hold';
  onPress: () => void;
}) {
  const p = useTheme();
  const go = tone === 'go';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: go ? 'rgba(0,0,0,0.15)' : p.accentSoft }}
      style={({ pressed }) => ({
        alignSelf: 'stretch',
        height: HIT + 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill,
        backgroundColor: go ? p.accent : p.surfaceAlt,
        borderWidth: go ? 0 : 1,
        borderColor: p.line,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <Text variant="title" style={{ color: go ? p.accentInk : p.ink }}>{label}</Text>
    </Pressable>
  );
}

/** Deliberately quieter and smaller than the primary action. */
function SmallButton({ label, tone, onPress }: {
  label: string;
  tone?: 'danger';
  onPress: () => void;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        flex: 1,
        height: HIT,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: tone === 'danger' ? p.danger : p.line,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text variant="bodyStrong" tone={tone === 'danger' ? 'danger' : 'soft'}>{label}</Text>
    </Pressable>
  );
}

/**
 * The second tap.
 *
 * Ending a session is not undoable: finishing logs it and clears the clock,
 * discarding throws the time away entirely. Both replace the controls with a
 * plain question rather than firing on the first touch, and the way out of the
 * question is the wide, obvious half.
 */
function Confirm({ kind, elapsed, onCancel, onConfirm }: {
  kind: 'finish' | 'discard';
  elapsed: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const p = useTheme();
  const finishing = kind === 'finish';
  return (
    <View style={{ alignSelf: 'stretch', gap: space.md }}>
      <Text variant="body" tone="soft" style={{ textAlign: 'center' }}>
        {finishing
          ? `Finish now and log ${formatFocusLength(elapsed)}?`
          : `Throw away ${formatFocusLength(elapsed)} and log nothing?`}
      </Text>
      <Row gap={space.sm}>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          android_ripple={{ color: p.accentSoft }}
          style={({ pressed }) => ({
            flex: 2,
            height: HIT,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.pill,
            backgroundColor: p.surfaceAlt,
            borderWidth: 1,
            borderColor: p.line,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text variant="bodyStrong">Keep going</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          accessibilityRole="button"
          android_ripple={{ color: p.accentSoft }}
          style={({ pressed }) => ({
            flex: 1,
            height: HIT,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: finishing ? p.accent : p.danger,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text variant="bodyStrong" tone={finishing ? 'accent' : 'danger'}>
            {finishing ? 'Finish' : 'Discard'}
          </Text>
        </Pressable>
      </Row>
    </View>
  );
}

/**
 * The days as bars.
 *
 * Height is relative to the best day in the range rather than to a fixed scale,
 * because the question is "how did this day compare with my others", not "how
 * many hours is that" — the number is already stated above.
 */
function Chart({ days, peak, compact }: {
  days: { date: string; seconds: number }[];
  peak: number;
  compact: boolean;
}) {
  const p = useTheme();
  const H = 120;
  const today = dateKey(new Date());

  return (
    <View>
      <View style={{
        height: H,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: compact ? 2 : 6,
      }}>
        {days.map(d => {
          const ratio = peak > 0 ? d.seconds / peak : 0;
          const isToday = d.date === today;
          return (
            <View key={d.date} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              <View
                style={{
                  width: '100%',
                  // A worked day never rounds to invisible: the floor is what
                  // separates "a little" from "none at all".
                  height: d.seconds > 0 ? Math.max(4, ratio * H) : 2,
                  borderRadius: 3,
                  backgroundColor: d.seconds === 0
                    ? p.line
                    : isToday ? p.accent : p.accentSoft,
                  borderWidth: d.seconds > 0 && !isToday ? 1 : 0,
                  borderColor: p.accent,
                }}
              />
            </View>
          );
        })}
      </View>

      {/* Labels only where they can be read. */}
      {!compact ? (
        <Row gap={6} style={{ marginTop: space.sm }}>
          {days.map(d => (
            <View key={d.date} style={{ flex: 1, alignItems: 'center' }}>
              <Text
                variant="caption"
                tone={d.date === today ? 'accent' : 'faint'}
                style={{ fontSize: 11 }}
              >
                {new Date(`${d.date}T00:00:00`)
                  .toLocaleDateString(undefined, { weekday: 'narrow' })}
              </Text>
            </View>
          ))}
        </Row>
      ) : (
        <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
          <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
            {niceDate(days[0]?.date)}
          </Text>
          <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>today</Text>
        </Row>
      )}
    </View>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const p = useTheme();
  return (
    <View style={{
      flex: 1,
      padding: space.md,
      borderRadius: radius.md,
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.line,
    }}>
      <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{label}</Text>
      <Text variant="title" style={{ marginTop: 2 }}>{value}</Text>
      {hint ? (
        <Text variant="caption" tone="faint" style={{ fontSize: 11, marginTop: 1 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function niceDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(`${date}T00:00:00`)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
     ) ;  
 }  
 