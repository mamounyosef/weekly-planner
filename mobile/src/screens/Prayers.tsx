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
import { radius, space, HIT } from '../theme';
import { usePlanner } from '../state/planner';
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
  const { shared, edit, data, isPrayerDone, togglePrayer, timeFormat } = usePlanner();

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
  const [methodsOpen, setMethodsOpen] = useState(false);

  // The location is committed on a button rather than on every keystroke: each
  // commit changes the cache key, and a key change is a network fetch.
  const [cityDraft, setCityDraft] = useState(s.city);
  const [countryDraft, setCountryDraft] = useState(s.country);
  useEffect(() => { setCityDraft(s.city); setCountryDraft(s.country); }, [s.city, s.country]);
  const locationChanged = cityDraft.trim() !== s.city || countryDraft.trim() !== s.country;
  const locationUsable = cityDraft.trim().length > 0 && countryDraft.trim().length > 0;

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
              onPress={onClose}
              accessibilityLabel="Back to settings"
              hitSlop={space.md}
              style={{ paddingHorizontal: space.sm }}
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
                  onPress={() => void refresh(true)}
                  disabled={busy}
                  hitSlop={space.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Fetch the times again"
                  style={{ paddingHorizontal: space.sm, paddingVertical: space.xs, opacity: busy ? 0.4 : 1 }}
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

            {/* ── Location ── */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">LOCATION</Text>
              <Card style={{ gap: space.lg }}>
                <Field label="City" hint="Spelling matters">
                  <TextField
                    value={cityDraft}
                    onChange={setCityDraft}
                    placeholder="Amman"
                    invalid={cityDraft.trim().length === 0}
                  />
                </Field>
                <Field label="Country">
                  <TextField
                    value={countryDraft}
                    onChange={setCountryDraft}
                    placeholder="Jordan"
                    invalid={countryDraft.trim().length === 0}
                  />
                </Field>
                <Text variant="caption" tone="faint">
                  The name is geocoded by the times service, so write it the way a map would.
                  Changing it fetches a fresh month for the new place.
                </Text>
                {locationChanged ? (
                  <Row gap={space.sm}>
                    <Button
                      label="Cancel"
                      variant="quiet"
                      onPress={() => { setCityDraft(s.city); setCountryDraft(s.country); }}
                    />
                    <Button
                      label="Use this location"
                      style={{ flex: 1 }}
                      disabled={!locationUsable}
                      onPress={() => patch({ city: cityDraft.trim(), country: countryDraft.trim() })}
                    />
                  </Row>
                ) : null}
              </Card>
            </View>

            {/* ── How they are calculated ── */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">CALCULATION</Text>
              <Card style={{ gap: space.lg }}>
                <View style={{ gap: space.sm }}>
                  <Pressable
                    onPress={() => setMethodsOpen(v => !v)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: methodsOpen }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text variant="body">Method</Text>
                      <Text variant="caption" tone="accent" numberOfLines={2} style={{ marginTop: 2 }}>
                        {PRAYER_METHODS.find(m => m.id === s.method)?.label ?? `Method ${s.method}`}
                      </Text>
                    </View>
                    <Text variant="title" tone="faint">{methodsOpen ? '⌃' : '⌄'}</Text>
                  </Pressable>
                  <Text variant="caption" tone="faint">
                    The authority whose angles are used. This is the single biggest reason two apps
                    disagree: the same city can differ by twenty minutes between methods.
                  </Text>

                  {methodsOpen ? (
                    <View style={{
                      borderWidth: 1, borderColor: p.line, borderRadius: radius.md,
                      backgroundColor: p.surfaceAlt, overflow: 'hidden',
                    }}>
                      {PRAYER_METHODS.map((m, i) => {
                        const on = m.id === s.method;
                        return (
                          <Pressable
                            key={m.id}
                            onPress={() => { patch({ method: m.id }); setMethodsOpen(false); }}
                            android_ripple={{ color: p.accentSoft }}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            style={{
                              flexDirection: 'row', alignItems: 'center', gap: space.sm,
                              paddingHorizontal: space.md, minHeight: HIT,
                              borderTopWidth: i === 0 ? 0 : 1, borderTopColor: p.line,
                              backgroundColor: on ? p.accentSoft : 'transparent',
                            }}
                          >
                            <Text variant={on ? 'bodyStrong' : 'body'} tone={on ? 'accent' : 'soft'} style={{ flex: 1 }}>
                              {m.label}
                            </Text>
                            {on ? <Text variant="body" tone="accent">✓</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>

                <Divider />

                <Field label="Asr madhab" hint={PRAYER_SCHOOLS.find(x => x.id === s.school)?.hint}>
                  <Segment
                    options={PRAYER_SCHOOLS.map(x => ({ key: String(x.id), label: x.label }))}
                    value={String(s.school)}
                    onChange={k => patch({ school: k === '1' ? 1 : 0 })}
                  />
                </Field>
              </Card>
            </View>

            {/* ── The PC's own drawing settings ── */}
            <View style={{ gap: space.sm }}>
              <Text variant="label" tone="faint">ON YOUR PC</Text>
              <Card style={{ gap: space.lg }}>
                <Text variant="caption" tone="faint">
                  These describe how the desk window draws a prayer. They are here because the
                  setting is shared, not because this phone uses them.
                </Text>

                <Field label="Drawn as" hint={PRAYER_STYLES.find(x => x.id === s.style)?.hint}>
                  <Segment
                    options={PRAYER_STYLES.map(x => ({ key: x.id, label: x.label }))}
                    value={s.style}
                    onChange={k => patch({ style: k })}
                  />
                </Field>

                <Field label="Colour">
                  <ColourPicker
                    value={s.color}
                    swatches={PRAYER_COLOURS.map(hex => ({ key: hex, hex }))}
                    // Tapping the chosen swatch again clears it in the shared
                    // picker. A prayer with no colour has nothing to draw, so
                    // that press keeps the current one instead.
                    onChange={next => patch({ color: next ?? s.color })}
                  />
                </Field>

                <Toggle
                  label="Show in the side window"
                  hint="Prayers appear on the widget's timeline and in its day list"
                  value={s.showInWidget}
                  onChange={v => patch({ showInWidget: v })}
                />

                <Row style={{ alignItems: 'center', gap: space.md }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="body">Draw up to</Text>
                    <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                      How far ahead they are drawn. Past days always keep theirs.
                    </Text>
                  </View>
                  <Stepper
                    value={s.horizonDays}
                    min={PRAYER_HORIZON_MIN}
                    max={PRAYER_HORIZON_MAX}
                    step={s.horizonDays >= 30 ? 5 : 1}
                    onChange={n => patch({ horizonDays: n })}
                    format={n => (n === 1 ? '1 day' : `${n} days`)}
                  />
                </Row>
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
          onPress={onToggleDone}
          disabled={!visible}
          hitSlop={space.sm}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done, disabled: !visible }}
          accessibilityLabel={`Mark ${label} as prayed`}
          style={{
            width: 24, height: 24, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: done ? p.ok : p.line,
            backgroundColor: done ? p.ok : 'transparent',
            opacity: visible ? 1 : 0.3,
          }}
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
