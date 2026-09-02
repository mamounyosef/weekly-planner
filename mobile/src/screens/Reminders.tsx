// ─── Reminders ───────────────────────────────────────────────────────────────
// What alerts, how early, and how loudly. The global half of the notification
// model, in the one place a phone can reach it.
//
// THESE ARE SHARED SETTINGS, not phone ones. They live in the same synced
// settings record the PC writes, so raising the all-day hour here raises it on
// the desk too. That is why the whole `notifications` object is written back as
// one value on every change: the sync layer merges per FIELD, and
// `notifications` is a single field, so the write is kept whole and short-lived
// rather than being assembled in pieces.
//
// WHAT THIS SCREEN IS ALLOWED TO TOUCH. Only the GLOBAL defaults. An item's own
// reminder and a category's are the two levels above these, and there the
// difference between an absent spec and an explicit `{ enabled: false }` is the
// entire inheritance rule: absent means "ask the level below me", off means
// "stay silent". Nothing here ever writes into those levels, and turning a
// default off writes `enabled: false` into the GLOBAL spec, which is the last
// level and therefore has nothing left to inherit from.
//
// UNKNOWN FIELDS RIDE ALONG. The raw record is spread back out underneath every
// write, so a setting the PC understands and this build does not (a newer
// transport switch, say) survives a phone edit instead of being quietly dropped.
//
// SIGN CONVENTION. An offset is signed minutes from the anchor and NEGATIVE
// MEANS BEFORE, because the scheduler fires at `anchor + offsetMin`. The wording
// therefore comes from `offsetLabel` in the model itself rather than from the
// editor's own helper, which reads the sign the other way round.
//
// NO NATIVE PICKERS. Same delivery rule as the rest of the app: a native module
// means this app can only reach the phone as a whole new APK instead of over
// the air.

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, Divider, Row, Spacer, Text, useTheme } from '../ui/kit';
import { Field, Stepper, Toggle } from '../ui/Fields';
import { HIT, PRESSED, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import { formatClock } from '../lib/agenda';
import {
  OFFSET_PRESETS_ALL_DAY,
  OFFSET_PRESETS_TIMED,
  coerceNotificationSettings,
  offsetLabel,
  type NotificationSettings,
  type NotifyRule,
  type NotifySpec,
} from '../lib/notifications';

/** Earliest first, so the chips read as a timeline rather than as a preset list. */
const TIMED_OFFSETS = [...OFFSET_PRESETS_TIMED].sort((a, b) => a - b);
const ALL_DAY_OFFSETS = [...OFFSET_PRESETS_ALL_DAY].sort((a, b) => a - b);

/** Snooze lengths worth a tap. The model keeps at most five of them. */
const SNOOZE_CHOICES = [5, 10, 15, 20, 30, 45, 60, 120];
const MAX_SNOOZE = 5;

/** Five reminders is plenty on a phone; the PC's editor allows ten. */
const MAX_RULES = 5;

export function Reminders({ onClose }: { onClose?: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { shared, edit, timeFormat } = usePlanner();

  const raw = (shared.notifications ?? {}) as Record<string, unknown>;
  const s = useMemo(() => coerceNotificationSettings(raw), [raw]);

  /**
   * Write the settings back.
   *
   * `raw` first so anything this build does not model survives, then the
   * coerced view so a half-written record from an older device is completed
   * rather than left missing fields the scheduler reads without checking, then
   * the change itself. Nothing is mutated: the object in the context is the
   * same one the next diff is compared against, so editing it in place would
   * make the change look like no change at all and drop it.
   */
  const write = (patch: Partial<NotificationSettings>) => {
    void edit('settings', SETTINGS_ENTITY, { notifications: { ...raw, ...s, ...patch } });
  };

  const clock = (hour: number) => formatClock(hour * 60, timeFormat);

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
          <Text variant="display">Reminders</Text>
          {onClose ? (
            <Pressable
              onPress={onClose}
              accessibilityLabel="Back to settings"
              hitSlop={space.md}
              style={({ pressed }) => [{ paddingHorizontal: space.sm }, pressed ? PRESSED : null]}
            >
              <Text variant="title" tone="soft">✕</Text>
            </Pressable>
          ) : null}
        </Row>
      </View>

      <ScrollView contentContainerStyle={{
        padding: space.xl,
        paddingBottom: insets.bottom + space.xxl,
        gap: space.lg,
      }}>
        <Card>
          <Toggle
            label="Reminders"
            hint={s.enabled
              ? 'Everything below decides when.'
              : 'Nothing alerts, on this phone or on your PC.'}
            value={s.enabled}
            onChange={v => write({ enabled: v })}
          />
        </Card>

        {/* Dimmed rather than hidden while the master switch is off: the settings
            are still true, they are simply not being acted on, and a section that
            vanishes reads as one that was lost. */}
        <View
          pointerEvents={s.enabled ? 'auto' : 'none'}
          style={{ opacity: s.enabled ? 1 : 0.4, gap: space.lg }}
        >
          <Group title="What alerts, and when">
            <SpecCard
              title="Timed items"
              subject="Anything with a start time"
              spec={s.defaultTimed}
              offsets={TIMED_OFFSETS}
              onChange={next => write({ defaultTimed: next })}
            />

            <SpecCard
              title="All-day items"
              subject="Anything without a time"
              spec={s.defaultAllDay}
              offsets={ALL_DAY_OFFSETS}
              onChange={next => write({ defaultAllDay: next })}
              anchorNote={`Counted from ${clock(s.allDayHour)} on the day itself, so one day before lands the morning before.`}
              anchor={(
                <HourRow
                  label="Their day starts at"
                  hour={s.allDayHour}
                  clock={clock}
                  onChange={h => write({ allDayHour: h })}
                />
              )}
            />

            <SpecCard
              title="Tasks with a date"
              subject="A task still open on its day"
              spec={s.defaultTask}
              offsets={TIMED_OFFSETS}
              onChange={next => write({ defaultTask: next })}
              anchorNote={`Tasks with no time of their own are gathered into one reminder at ${clock(s.taskCutoffHour)}, and only if they are still open.`}
              anchor={(
                <HourRow
                  label="Gathered up at"
                  hour={s.taskCutoffHour}
                  clock={clock}
                  onChange={h => write({ taskCutoffHour: h })}
                />
              )}
            />

            <SpecCard
              title="Prayer times"
              subject="Each prayer"
              spec={s.prayer}
              offsets={TIMED_OFFSETS}
              onChange={next => write({ prayer: next })}
            />
          </Group>

          <Group title="Quiet hours">
            <Card>
              <Toggle
                label="Hold reminders overnight"
                hint={s.quietHoursEnabled
                  ? `Normal ones wait and arrive at ${clock(s.quietToH)}. Urgent ones still come through.`
                  : 'Reminders arrive whenever they are due.'}
                value={s.quietHoursEnabled}
                onChange={v => write({ quietHoursEnabled: v })}
              />
              {s.quietHoursEnabled ? (
                <>
                  <Spacer size={space.sm} />
                  <Divider />
                  <Spacer size={space.md} />
                  <HourRow
                    label="From"
                    hour={s.quietFromH}
                    clock={clock}
                    onChange={h => write({ quietFromH: h })}
                  />
                  <Spacer size={space.sm} />
                  <HourRow
                    label="Until"
                    hour={s.quietToH}
                    clock={clock}
                    onChange={h => write({ quietToH: h })}
                  />
                </>
              ) : null}
            </Card>
          </Group>

          <Group title="When one arrives">
            <Card>
              <Field label="Snooze for" hint="Offered on the reminder">
                <Text variant="caption" tone="faint">
                  {describeList(s.snoozeOptions.map(m => minutesLabel(m)))}, whichever you tap.
                </Text>
                <Spacer size={space.xs} />
                <ChipRow
                  choices={SNOOZE_CHOICES}
                  selected={s.snoozeOptions}
                  label={minutesLabel}
                  max={MAX_SNOOZE}
                  onToggle={next => write({ snoozeOptions: next })}
                />
              </Field>

              <Spacer size={space.lg} />
              <Divider />
              <Spacer size={space.lg} />

              <Field label="Urgent reminders" hint="Marked urgent only">
                <Text variant="caption" tone="faint">
                  {s.escalateTimes === 0
                    ? 'They arrive once and then wait for you in the list.'
                    : `They come back every ${minutesLabel(s.escalateEveryMin)}, up to ${s.escalateTimes} ${s.escalateTimes === 1 ? 'time' : 'times'}, until you deal with them.`}
                </Text>
                <Spacer size={space.xs} />
                <LabelledStepper
                  label="Every"
                  value={s.escalateEveryMin}
                  min={1}
                  max={60}
                  format={minutesLabel}
                  onChange={n => write({ escalateEveryMin: n })}
                />
                <Spacer size={space.sm} />
                <LabelledStepper
                  label="At most"
                  value={s.escalateTimes}
                  min={0}
                  max={60}
                  format={n => (n === 0 ? 'Never repeat' : `${n} ${n === 1 ? 'time' : 'times'}`)}
                  onChange={n => write({ escalateTimes: n })}
                />
              </Field>
            </Card>
          </Group>

          <Group title="After a gap">
            <Card>
              <Field label="Catch up on missed reminders">
                <Text variant="caption" tone="faint">
                  {s.catchUpHours === 0
                    ? 'Anything missed while everything was off stays in the list and never arrives late.'
                    : `Anything that came due in the last ${hoursLabel(s.catchUpHours)} still arrives. Older ones wait quietly in the list instead of turning up in a burst.`}
                </Text>
                <Spacer size={space.xs} />
                <LabelledStepper
                  label="Go back"
                  value={s.catchUpHours}
                  min={0}
                  max={72}
                  format={n => (n === 0 ? 'Not at all' : hoursLabel(n))}
                  onChange={n => write({ catchUpHours: n })}
                />
              </Field>
            </Card>
          </Group>
        </View>

        <Text variant="caption" tone="faint" style={{ textAlign: 'center' }}>
          Windows toasts, browser push, the in-app banner and how much history is
          kept are set on your PC.
        </Text>
      </ScrollView>
    </View>
  );
}

// ─── One default reminder ────────────────────────────────────────────────────

/**
 * A whole spec as a sentence, with the controls folded away under it.
 *
 * Collapsed by default and summarised in words, because four of these stacked
 * open is a wall of chips. "All-day items alerts 1 day before, then at the time"
 * is something a person can check on the way past; a row of selected pills is a
 * data structure with a font.
 */
function SpecCard({ title, subject, spec, offsets, onChange, anchor, anchorNote }: {
  title: string;
  subject: string;
  spec: NotifySpec;
  offsets: number[];
  onChange: (next: NotifySpec) => void;
  /** The control for this kind's anchor hour, if it has one. */
  anchor?: React.ReactNode;
  anchorNote?: string;
}) {
  const p = useTheme();
  const [open, setOpen] = useState(false);

  const chosen = useMemo(
    () => [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin),
    [spec.rules],
  );

  // Any offset the PC set that is not one of the presets still gets a chip of
  // its own, so a phone tap can never be the thing that silently loses it.
  const choices = useMemo(() => {
    const extra = chosen.map(r => r.offsetMin).filter(o => !offsets.includes(o));
    return [...new Set([...offsets, ...extra])].sort((a, b) => a - b);
  }, [offsets, chosen]);

  const toggleOffset = (offsetMin: number) => {
    const has = chosen.some(r => r.offsetMin === offsetMin);
    // An enabled spec with no rules is silent but still looks on, so the last
    // one cannot be taken away. Turning the whole card off is how to silence it.
    if (has && chosen.length === 1) return;
    if (!has && chosen.length >= MAX_RULES) return;

    const next: NotifyRule[] = has
      ? chosen.filter(r => r.offsetMin !== offsetMin)
      : [...chosen, { id: `o${offsetMin}`, offsetMin }].sort((a, b) => a.offsetMin - b.offsetMin);

    onChange({ ...spec, rules: next });
  };

  return (
    <Card style={{ padding: space.md }}>
      <Pressable
        onPress={() => setOpen(v => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT }, pressed ? PRESSED : null]}
      >
        <View style={{ flex: 1 }}>
          <Row gap={space.sm} style={{ alignItems: 'center' }}>
            <Text variant="bodyStrong">{title}</Text>
            {spec.enabled && spec.priority === 'critical' ? (
              <Text variant="caption" tone="warn" style={{ fontSize: 12 }}>urgent</Text>
            ) : null}
          </Row>
          <Text variant="caption" tone={spec.enabled ? 'soft' : 'faint'} style={{ marginTop: 3 }}>
            {sentence(spec, subject)}
          </Text>
        </View>
        <Text variant="title" tone="faint">{open ? '⌄' : '›'}</Text>
      </Pressable>

      {open ? (
        <View style={{ marginTop: space.sm }}>
          <Divider />
          <Spacer size={space.md} />

          <Toggle
            label="Remind me"
            value={spec.enabled}
            onChange={v => onChange({ ...spec, enabled: v })}
          />

          {spec.enabled ? (
            <>
              <Spacer size={space.sm} />
              <Text variant="label" tone="faint" style={{ letterSpacing: 1 }}>HOW EARLY</Text>
              <Spacer size={space.sm} />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: space.xs, paddingRight: space.lg }}
              >
                {choices.map(off => {
                  const on = chosen.some(r => r.offsetMin === off);
                  const full = !on && chosen.length >= MAX_RULES;
                  return (
                    <Pressable
                      key={off}
                      onPress={() => toggleOffset(off)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: full }}
                      accessibilityLabel={offsetLabel(off)}
                      style={({ pressed }) => [{
                        paddingHorizontal: space.md,
                        height: 36,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: radius.pill,
                        backgroundColor: on ? p.accentSoft : p.surfaceAlt,
                        borderWidth: 1,
                        borderColor: on ? p.accent : p.line,
                        opacity: full ? 0.4 : 1,
                      }, pressed ? PRESSED : null]}
                    >
                      <Text variant="caption" tone={on ? 'accent' : 'soft'}>
                        {offsetLabel(off)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Spacer size={space.xs} />
              <Text variant="caption" tone="faint">
                {chosen.length >= MAX_RULES
                  ? `${MAX_RULES} is as many as one item gets. Turn one off to add another.`
                  : anchorNote ?? 'Tap as many as you want. Tap one again to drop it.'}
              </Text>

              <Spacer size={space.sm} />
              <Toggle
                label="Urgent"
                hint="Keeps coming back until you deal with it, and ignores quiet hours"
                value={spec.priority === 'critical'}
                onChange={v => onChange({ ...spec, priority: v ? 'critical' : 'normal' })}
              />
            </>
          ) : null}

          {anchor ? (
            <>
              <Spacer size={space.sm} />
              <Divider />
              <Spacer size={space.md} />
              {anchor}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label" tone="faint">{title}</Text>
      {children}
    </View>
  );
}

function HourRow({ label, hour, clock, onChange }: {
  label: string;
  hour: number;
  clock: (hour: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <LabelledStepper
      label={label}
      value={hour}
      min={0}
      max={23}
      format={clock}
      onChange={onChange}
    />
  );
}

function LabelledStepper({ label, value, min, max, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  format: (n: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <Row style={{ alignItems: 'center', gap: space.md }}>
      <Text variant="body" tone="soft" style={{ flex: 1 }}>{label}</Text>
      <Stepper value={value} min={min} max={max} onChange={onChange} format={format} />
    </Row>
  );
}

/** A bounded multiple choice, kept as a sorted list of numbers. */
function ChipRow({ choices, selected, label, max, onToggle }: {
  choices: number[];
  selected: number[];
  label: (n: number) => string;
  max: number;
  onToggle: (next: number[]) => void;
}) {
  const p = useTheme();

  const tap = (n: number) => {
    const on = selected.includes(n);
    // One option has to survive, or the reminder arrives with nothing to tap.
    if (on && selected.length === 1) return;
    if (!on && selected.length >= max) return;
    const next = on ? selected.filter(v => v !== n) : [...selected, n];
    onToggle(next.sort((a, b) => a - b));
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: space.xs, paddingRight: space.lg }}
    >
      {choices.map(n => {
        const on = selected.includes(n);
        const full = !on && selected.length >= max;
        return (
          <Pressable
            key={n}
            onPress={() => tap(n)}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: full }}
            style={({ pressed }) => [{
              paddingHorizontal: space.md,
              height: 36,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.pill,
              backgroundColor: on ? p.accentSoft : p.surfaceAlt,
              borderWidth: 1,
              borderColor: on ? p.accent : p.line,
              opacity: full ? 0.4 : 1,
            }, pressed ? PRESSED : null]}
          >
            <Text variant="caption" tone={on ? 'accent' : 'soft'}>{label(n)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ─── Wording ─────────────────────────────────────────────────────────────────

/**
 * A whole spec as one readable line.
 *
 * The offsets are sorted before they are read out, because the order they were
 * tapped in says nothing, and "1 day before, then at the time" is the order they
 * will actually happen in.
 */
function sentence(spec: NotifySpec, subject: string): string {
  if (!spec.enabled) return `${subject} stays silent.`;
  if (!spec.rules.length) return `${subject} alerts on time.`;

  const times = [...spec.rules]
    .sort((a, b) => a.offsetMin - b.offsetMin)
    .map(r => lowerFirst(offsetLabel(r.offsetMin)));

  return `${subject} alerts ${describeList(times)}.`;
}

/** "a", "a, then b", "a, b, then c". */
function describeList(parts: string[]): string {
  if (parts.length === 0) return 'never';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function minutesLabel(min: number): string {
  if (min % 60 === 0 && min >= 60) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${min} min`;
}

function hoursLabel(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) {
    const d = hours / 24;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
