// ─── Prayer times ────────────────────────────────────────────────────────────
// Everything about the five prayers, on the device they are actually checked on.
//
// WHY THIS SCREEN LEADS WITH TODAY'S TIMES
// A calculation method is an abstraction. "Asr, 16:18" is not. Every control on
// this screen changes a number in the list at the top of it, and the list is
// live, so switching from Standard to Hanafi visibly moves Asr rather than
// leaving you to go and look. The offset and the show or hide switch for each
// prayer live INSIDE that prayer's own row for the same reason: the thing you
// are correcting and the control that corrects it are never on two screens.
//
// THESE ARE SHARED SETTINGS. They live in the same synced settings record the PC
// writes, so a method chosen here is the method the desk uses too. The whole
// `prayer` object is written back as one value on every change, because the sync
// layer merges per FIELD and `prayer` is a single field. The raw record is
// spread back underneath every write, so a field the PC understands and this
// build does not survives a phone edit instead of being quietly dropped.
//
// WHERE THE TIMES COME FROM, AND WHY THE PHONE FETCHES THEM ITSELF
// The month calendar is a SHARED cache: `database/prayer-times.json` on the PC,
// the `prayerTimes` store here, keyed by city, country, method, school and
// month. Normally the PC fills it and the phone just reads it, offline and
// instantly. But changing the city or the method changes the key, and nothing
// has ever been fetched under the new one. Telling someone to go and open their
// PC before their own prayer times appear is not an answer on an offline first
// app, so the phone fetches the new month from Aladhan directly and writes it
// into the same shared cache, in the same shape, which then reaches the PC.
//
// The fetch is a best effort and never a gate:
//   • Nothing on screen waits for it. The cached month paints first.
//   • A failure never empties the list. The previous configuration's times are
//     shown, labelled as such, because prayer times from the town next door beat
//     a blank screen by a wide margin.
//   • It is attempted once per cache key per session, plus whenever the user
//     asks. A screen that refetched on every keystroke would hammer a free,
//     keyless API on someone else's behalf.
//
// NO NATIVE MODULES. No location picker, no date picker, no dependency. The city
// is typed, exactly as it is on the PC, because a native module would end this
// app's ability to update over the air.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Divider, Row, Spacer, Text, useTheme } from '../ui/kit';
import { ColourPicker, Field, Segment, Stepper, TextField, Toggle } from '../ui/Fields';
import { HIT, PRESSED, PRESS_DELAY, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import {
  DEFAULT_PRAYER_APPEARANCE, PRAYER_DRAW_STYLES, describePrayerAppearance,
} from '../lib/viewPrefs';
import { readClientStore } from '../lib/syncClient';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import { formatClock, ymd } from '../lib/agenda';
import {
  PRAYER_COLOURS,
  PRAYER_OFFSET_LIMIT,
  PRAYER_SCHOOLS,
  PRAYER_STYLES,
  aladhanCalendarUrl,
  applyPrayerPatch,
  describeOffset,
  describePrayerConfig,
  describePrayerFreshness,
  isPrayerVisible,
  lookupPrayerMonth,
  normalisePrayerSettings,
  parseAladhanCalendar,
  prayerMonthKey,
  withPrayerOffset,
  withPrayerVisible,
  writablePrayerRecord,
} from '../lib/prayerSettings';
import {
  PRAYER_ARABIC,
  PRAYER_HORIZON_MAX,
  PRAYER_HORIZON_MIN,
  PRAYER_KEYS,
  PRAYER_LABELS,
  PRAYER_METHODS,
  buildPrayerDay,
  prayerTimeToMinutes,
  type PrayerKey,
  type PrayerSettings,
} from '../lib/prayerTimes';

/**
 * Which cache keys this session has already tried to fill, and when.
 *
 * Module level rather than component state on purpose: leaving the screen and
 * coming back is not new information, and re-running the fetch every time would
 * turn a bit of fidgeting into a burst of calls against a free public API. A
 * failure is retried after the cooldown; a success needs no retry, because a
 * filled cache key stops asking on its own.
 */
const attempted = new Map<string, number>();
const RETRY_AFTER_MS = 10 * 60 * 1000;

/** How long to wait on Aladhan before deciding this phone has no useful signal. */
const FETCH_TIMEOUT_MS = 12_000;

export function Prayers({ onClose }: { onClose?: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    shared, edit, data, isPrayerDone, togglePrayer, timeFormat,
    prayerAppearance: appearance, setPrayerAppearance: setAppearance,
    prayerCacheSummary,
  } = usePlanner();

  const raw = (shared as { prayer?: unknown }).prayer;
  const s = useMemo(() => normalisePrayerSettings(raw), [raw]);

  const cache = useMemo(
    () => readClientStore(data, 'prayerTimes') as Record<string, unknown>,
    [data],
  );

  // The day, and the month it belongs to. Recomputed on every render rather than
  // held, so a screen left open overnight rolls onto the new day by itself.
  const now = new Date();
  const today = ymd(now);
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const lookup = useMemo(
    () => lookupPrayerMonth(cache, s, year, month, now),
    // `now` is deliberately not a dependency: it is a fresh object every render
    // and would defeat the memo entirely. The date it stands for is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, s, year, month, today],
  );

  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /** Write the whole prayer record back, unknown fields and all. */
  const write = useCallback((next: PrayerSettings) => {
    void edit('settings', SETTINGS_ENTITY, { prayer: writablePrayerRecord(raw, next) });
  }, [edit, raw]);

  const patch = useCallback((change: Partial<PrayerSettings>) => {
    write(applyPrayerPatch(raw, change));
  }, [raw, write]);

  /**
   * Fill a month of the shared cache from Aladhan.
   *
   * Writes exactly what the dev server writes, into the same store, so a month
   * this phone fetched and a month the PC fetched are indistinguishable
   * afterwards and neither device refetches the other's work.
   */
  const fillMonth = useCallback(async (settings: PrayerSettings, y: number, m: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(aladhanCalendarUrl(settings, y, m), { signal: controller.signal });
      if (!res.ok) throw new Error(`Aladhan answered ${res.status}`);
      const days = parseAladhanCalendar(await res.json());
      if (Object.keys(days).length === 0) {
        // A geocode that found nothing comes back as a valid, empty reply, which
        // is almost always a misspelt city rather than a broken API.
        throw new Error(`No times for "${settings.city}, ${settings.country}"`);
      }
      await edit('prayerTimes', prayerMonthKey(settings, y, m), { fetchedAt: Date.now(), days });
      return true;
    } finally {
      clearTimeout(timer);
    }
  }, [edit]);

  /**
   * Bring this configuration's months up to date.
   *
   * This month and the next one, because a week that straddles the end of the
   * month would otherwise be half empty on the calendar for days.
   */
  const refresh = useCallback(async (force: boolean) => {
    const key = prayerMonthKey(s, year, month);
    const last = attempted.get(key) ?? 0;
    if (!force && Date.now() - last < RETRY_AFTER_MS) return;
    attempted.set(key, Date.now());

    setBusy(true);
    setFetchError(null);
    const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    try {
      await fillMonth(s, year, month);
      // The month after is a convenience, so its failure is not the user's
      // problem and is never reported.
      try { await fillMonth(s, next.y, next.m); } catch { /* not worth a word */ }
      if (alive.current) setFetchError(null);
    } catch (err) {
      if (alive.current) {
        setFetchError(String((err as Error)?.message ?? err));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [fillMonth, s, year, month]);

  // Fetch only when the cache cannot answer: a fresh month is left alone.
  useEffect(() => {
    if (!s.enabled) return;
    if (lookup.state === 'fresh') return;
    void refresh(false);
  }, [s.enabled, lookup.state, lookup.key, refresh]);

  /**
   * Today's rows, with nothing filtered out.
   *
   * Hidden prayers are drawn here too, greyed, because this is the screen where
   * you turn them back on and a control you cannot see is one you cannot use.
   * The offsets ARE applied, so the number next to the stepper is the number the
   * calendar will show.
   */
  const rows = useMemo(() => {
    const everything: PrayerSettings = { ...s, hidden: [], showSunrise: true };
    const built = buildPrayerDay(today, lookup.days[today], everything);
    if (built.length > 0) return built;
    // No times for today at all. The rows still appear, without a clock, so the
    // settings underneath them remain reachable with no signal and no cache.
    return PRAYER_KEYS.map(key => ({
      key, label: PRAYER_LABELS[key], arabic: PRAYER_ARABIC[key],
      time: '', minutes: -1, dateStr: today, id: `${today}::${key}`,
    }));
  }, [s, today, lookup.days]);

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  /** The next prayer still to come today, so the card has a focal point. */
  const nextKey = useMemo(() => {
    const upcoming = rows
      .filter(r => r.minutes >= 0 && r.minutes >= nowMinutes && isPrayerVisible(s, r.key))
      .sort((a, b) => a.minutes - b.minutes);
    return upcoming[0]?.key ?? null;
    // Recomputed per minute is unnecessary; per render is plenty here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, s, Math.floor(nowMinutes / 5)]);

  const [openRow, setOpenRow] = useState<PrayerKey | null>(null);

  // The location is committed on a button rather than on every keystroke: each
  // commit changes the cache key, and a key change is a network fetch.

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Text variant="caption" tone="faint">SHARED WITH YOUR PC</Text>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="display">Prayer times</Text>
          {onClose ? (
            <Pressable
        unstable_pressDelay={PRESS_DELAY}
              onPress={onClose}
              accessibilityLabel="Back to settings"
              hitSlop={space.md}
              style={({ pressed }) => [{ paddingHorizontal: space.sm }, pressed ? PRESSED : null]}
            >
              <Text variant="title" tone="soft">✕</Text>
            </Pressable>
          ) : null}
        </Row>
        <Text variant="caption" tone="faint" numberOfLines={2} style={{ marginTop: 2 }}>
          {describePrayerConfig(s)}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.xxl,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── The master switch ── */}
        <Card>
          <Toggle
            label="Show prayer times"
            hint="On the calendar here and on your PC. A prayer has a start time and no length, so it never takes room from an event."
            value={s.enabled}
            onChange={v => patch({ enabled: v })}
          />
        </Card>

        {s.enabled ? (
          <>
            {/* ── Today, live ── */}
            <View style={{ gap: space.sm }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Text variant="label" tone="faint">TODAY IN {s.city.toUpperCase()}</Text>
                {busy ? <ActivityIndicator size="small" color={p.accent} /> : null}
              </Row>

              <Card style={{ padding: 0, overflow: 'hidden' }}>
                {rows.map((row, i) => (
                  <PrayerRow
                    key={row.key}
                    prayerKey={row.key}
                    label={row.label}
                    arabic={row.arabic}
                    minutes={row.minutes}
                    first={i === 0}
                    settings={s}
                    timeFormat={timeFormat}
                    isNext={row.key === nextKey}
                    done={isPrayerDone(today, row.key)}
                    onToggleDone={() => void togglePrayer(today, row.key)}
                    open={openRow === row.key}
                    onOpen={() => setOpenRow(openRow === row.key ? null : row.key)}
                    onOffset={mins => write(withPrayerOffset(s, row.key, mins))}
                    onVisible={v => write(withPrayerVisible(s, row.key, v))}
                  />
                ))}
              </Card>

              {/* Where these numbers came from, said calmly. */}
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text variant="caption" tone={lookup.source === 'exact' ? 'faint' : 'warn'} style={{ flex: 1 }}>
                  {fetchError
                    ? `Could not reach the prayer times service. ${describePrayerFreshness(lookup, now)}`
                    : describePrayerFreshness(lookup, now)}
                </Text>
                <Pressable
        unstable_pressDelay={PRESS_DELAY}
                  onPress={() => void refresh(true)}
                  disabled={busy}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Fetch the times again"
                  style={({ pressed }) => [{ paddingHorizontal: space.sm, paddingVertical: space.xs, opacity: busy ? 0.4 : 1 }, pressed ? PRESSED : null]}
                >
                  <Text variant="caption" tone="accent">Refresh</Text>
                </Pressable>
              </Row>
              {fetchError ? (
                <Text variant="caption" tone="faint">
                  {fetchError}. Check the spelling of your city and country, or try again once you have signal.
                </Text>
              ) : null}
            </View>

            {/* ── What this phone actually holds ──
                The one question worth answering when prayers do not appear on
                the calendar, and the one nobody can answer from outside the
                device: does the phone HAVE the times. Guessing at this from the
                server's own files has been wrong before, so the phone says it
                itself. */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">ON THIS DEVICE</Text>
              <Card style={{ gap: space.xs }}>
                <Text variant="body">
                  {prayerCacheSummary.hasToday
                    ? "Today's times are saved on this phone."
                    : prayerCacheSummary.months > 0
                      ? 'This phone has some months saved, but not today.'
                      : 'No times are saved on this phone yet.'}
                </Text>
                <Text variant="caption" tone="faint">
                  {prayerCacheSummary.months} {prayerCacheSummary.months === 1 ? 'month' : 'months'} cached.
                  Looking for {prayerCacheSummary.key}.
                </Text>
              </Card>
            </View>

            {/* ── Where the times come from ──
                A calculation method is chosen once and then never again, so the
                controls for it are not worth the room on a phone. The city, the
                country, the method and the madhab all live on the PC and arrive
                here through the shared settings. This says so plainly, because a
                screen showing a value with no way to change it and no
                explanation reads as broken rather than as deliberate. */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">HOW THESE ARE WORKED OUT</Text>
              <Card style={{ gap: space.xs }}>
                <Text variant="body">{describePrayerConfig(s)}</Text>
                <Text variant="caption" tone="faint">
                  Set on your PC, in Settings then Prayer. Changes there reach this phone on
                  the next sync.
                </Text>
              </Card>
            </View>

            {/* ── How THIS phone draws them ──
                Appearance is a property of the screen in your hand, not of the
                planner. A prayer drawn as a green line across a phone grid and
                the same prayer drawn as a pill on a wide desk monitor are the
                right answer in both places, so these are kept per device
                alongside the theme and the snap interval, and the PC can never
                push its choice here. The TIMES are shared; only the drawing is
                not. */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">ON THIS PHONE</Text>
              <Card style={{ gap: space.lg }}>
                <Toggle
                  label="Show on the time grid"
                  hint="Draws each prayer on the day, week and custom grids. The List view always shows them, since that is where you tick one off."
                  value={appearance.showOnCalendar}
                  onChange={v => setAppearance({ ...appearance, showOnCalendar: v })}
                />

                <Field
                  label="How they are drawn"
                  hint={PRAYER_DRAW_STYLES.find(x => x.id === appearance.style)?.hint}
                >
                  <Segment
                    options={PRAYER_DRAW_STYLES.map(x => ({ key: x.id, label: x.label }))}
                    value={appearance.style}
                    onChange={k => setAppearance({ ...appearance, style: k as any })}
                  />
                </Field>

                <Field label="Colour">
                  <ColourPicker
                    value={appearance.colour}
                    // Clearing a swatch means "back to the default", not "no
                    // colour": a line has to be drawn in something.
                    onChange={hex => setAppearance({
                      ...appearance,
                      colour: hex ?? DEFAULT_PRAYER_APPEARANCE.colour,
                    })}
                    swatches={PRAYER_COLOURS.map(hex => ({ key: hex, hex }))}
                  />
                </Field>

                {/* A row has no line to label, so the switch would be a
                    control that does nothing. It is hidden rather than
                    disabled: there is nothing to explain. */}
                {appearance.style === 'row' ? null : (
                  <Field
                    label="Labels on the grid"
                    hint="Off keeps the mark and drops the name, which is easier to read on a busy week."
                  >
                    <Toggle
                      label="Show the name"
                      value={appearance.showLabels}
                      onChange={v => setAppearance({ ...appearance, showLabels: v })}
                    />
                  </Field>
                )}

                <Field label="Language" hint="The language used to display the prayer names on the calendar.">
                  <Segment
                    options={[
                      { key: 'english', label: 'English' },
                      { key: 'arabic', label: 'Arabic' },
                    ]}
                    value={appearance.language ?? 'english'}
                    onChange={k => setAppearance({ ...appearance, language: k as 'english' | 'arabic' })}
                  />
                </Field>

                <Text variant="caption" tone="faint">
                  {describePrayerAppearance(appearance)}
                </Text>
              </Card>
            </View>

            {/* ── Where the rest of it lives ── */}
            <Card>
              <Text variant="caption" tone="faint">
                Reminders for prayers are set with every other reminder, under Notifications.
                A prayer you have already ticked off is never reminded about.
              </Text>
            </Card>
          </>
        ) : (
          <Card>
            <Text variant="caption" tone="faint">
              Prayer times are switched off, so nothing is drawn on the calendar and nothing is
              fetched. Everything you had set is kept, and comes back when you switch them on.
            </Text>
          </Card>
        )}

        <Spacer size={space.lg} />
      </ScrollView>
    </View>
  );
}

/**
 * One prayer, with the two things you would want to change about it.
 *
 * Collapsed it is a time you can tick off. Expanded it is a correction and a
 * show or hide switch, in place, so the number moves under the control that
 * moved it. A hidden prayer keeps its time on screen here and only here: this is
 * where you turn it back on.
 */
function PrayerRow({
  prayerKey, label, arabic, minutes, first, settings, timeFormat, isNext, done,
  onToggleDone, open, onOpen, onOffset, onVisible,
}: {
  prayerKey: PrayerKey;
  label: string;
  arabic: string;
  /** Minutes into the day, or -1 when no times are known at all. */
  minutes: number;
  first: boolean;
  settings: PrayerSettings;
  timeFormat: string | undefined;
  isNext: boolean;
  done: boolean;
  onToggleDone: () => void;
  open: boolean;
  onOpen: () => void;
  onOffset: (minutes: number) => void;
  onVisible: (visible: boolean) => void;
}) {
  const p = useTheme();
  const visible = isPrayerVisible(settings, prayerKey);
  const offset = settings.offsets[prayerKey] ?? 0;
  const known = minutes >= 0;

  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: p.line }}>
      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={onOpen}
        android_ripple={{ color: p.accentSoft }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}, ${known ? formatClock(minutes, timeFormat) : 'time not known'}`}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: space.md,
          paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: HIT,
          backgroundColor: isNext ? p.accentSoft : 'transparent',
        }}
      >
        {/* The tick, which is the reason to open this screen when not changing
            anything: the times are right here, so ticking one off is one tap. */}
        <Pressable
        unstable_pressDelay={PRESS_DELAY}
          onPress={onToggleDone}
          disabled={!visible}
          hitSlop={space.sm}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done, disabled: !visible }}
          accessibilityLabel={`Mark ${label} as prayed`}
          style={({ pressed }) => [{
            width: 24, height: 24, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: done ? p.ok : p.line,
            backgroundColor: done ? p.ok : 'transparent',
            opacity: visible ? 1 : 0.3,
          }, pressed ? PRESSED : null]}
        >
          {done ? <Text style={{ color: p.bg, fontSize: 13, fontWeight: '900' }}>✓</Text> : null}
        </Pressable>

        <View style={{ flex: 1, opacity: visible ? 1 : 0.45 }}>
          <Row gap={space.sm} style={{ alignItems: 'baseline' }}>
            <Text variant="bodyStrong">{label}</Text>
            <Text variant="caption" tone="faint">{arabic}</Text>
          </Row>
          <Text variant="caption" tone={offset === 0 ? 'faint' : 'accent'} style={{ marginTop: 2 }}>
            {!visible ? 'Hidden' : offset === 0 ? (isNext ? 'Next today' : describeOffset(0)) : describeOffset(offset)}
          </Text>
        </View>

        <Text
          variant="title"
          tone={visible ? (isNext ? 'accent' : 'ink') : 'faint'}
          style={{ opacity: visible ? 1 : 0.45 }}
        >
          {known ? formatClock(minutes, timeFormat) : '· ·'}
        </Text>
        <Text variant="body" tone="faint">{open ? '⌃' : '⌄'}</Text>
      </Pressable>

      {open ? (
        <View style={{
          paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md,
          backgroundColor: p.surfaceAlt,
        }}>
          <Toggle
            label={prayerKey === 'sunrise' ? 'Show Sunrise' : `Show ${label}`}
            hint={prayerKey === 'sunrise'
              ? 'Sunrise is not a prayer, so it is off unless you want it'
              : 'On the calendar, on both devices'}
            value={visible}
            onChange={onVisible}
          />
          <Row style={{ alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <Text variant="body">Correction</Text>
              <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                {describeOffset(offset)}
                {known && offset !== 0
                  ? `, so ${formatClock(prayerTimeToMinutes(pad(minutes - offset)), timeFormat)} becomes ${formatClock(minutes, timeFormat)}`
                  : ''}
              </Text>
            </View>
            <Stepper
              value={offset}
              min={-PRAYER_OFFSET_LIMIT}
              max={PRAYER_OFFSET_LIMIT}
              onChange={onOffset}
              format={n => (n > 0 ? `+${n}` : String(n))}
            />
          </Row>
          <Text variant="caption" tone="faint">
            Only if your mosque differs from the calculated time. Up to an hour either way.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Minutes back into 'HH:MM', wrapped inside the day like the model does. */
function pad(mins: number): string {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
