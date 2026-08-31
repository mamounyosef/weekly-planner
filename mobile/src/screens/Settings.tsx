// ─── Settings and diagnostics ────────────────────────────────────────────────
// Deliberately small. The PC owns configuration; this screen answers the three
// questions a phone actually raises: is it connected, are reminders allowed to
// fire, and what is waiting to sync.
//
// Desk Controller, Backups & Data and Keyboard Shortcuts are absent on purpose —
// they belong to the machine on the desk.

import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';

import { Button, Card, Divider, Row, Spacer, Text, useTheme, useThemeMode } from '../ui/kit';
import { Stepper, Toggle } from '../ui/Fields';
import { HIT, radius, space, type ThemeMode } from '../theme';
import { usePlanner } from '../state/planner';
import {
  describeRanges, hiddenHours, rangesFromHidden, type HourRange,
} from '../lib/dayWindows';
import { checkPermissions, requestPermissions, type PermissionState } from '../lib/notify';
import { prefs } from '../lib/prefs';
import {
  DAY_HOUR_MAX,
  DAY_HOUR_MIN,
  DEFAULT_DAY_WINDOW,
  DEFAULT_SWIPE_VIEW_SWITCH,
  describeDayWindow,
  formatHour,
  withDayEnd,
  withDayStart,
  type ClockFormat,
  type DayWindow,
} from '../lib/viewPrefs';

export function Settings({
  onClose, onOpenCategories, onOpenReminders, onOpenPrayers, onOpenPlanner,
}: {
  onClose: () => void;
  onOpenCategories?: () => void;
  onOpenReminders?: () => void;
  onOpenPrayers?: () => void;
  onOpenPlanner?: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    username, serverUrl, status, data, alarmSummary, lastError,
    signOut, syncNow, resetLocal, interval, setInterval,
    customWindow, setCustomWindow, timeFormat,
    visibleHours, setVisibleHours, swipeViewSwitch, setSwipeViewSwitch,
  } = usePlanner();

  const { mode: themeMode, setMode: setThemeMode } = useThemeMode();

  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateState, setUpdateState] = useState<string | null>(null);

  useEffect(() => { void checkPermissions().then(setPerm); }, []);

  /** The clock the planner is set to, which the preview and the sentence follow. */
  const clock: ClockFormat = timeFormat === '24h' ? '24h' : '12h';

  // The grid's own window and the swipe live on the planner context, not here:
  // Today.tsx draws the grid from them, so a stepper on this screen and the grid
  // behind it must be reading the same value rather than two copies of it. The
  // repair (moving one end can drag the other) happens in viewPrefs, so the
  // number on screen is always the one that was actually stored.

  const askForPermissions = async () => {
    setChecking(true);
    try {
      const next = await requestPermissions();
      setPerm(next);
      if (!next.granted) {
        // Once refused, Android will not ask again — the only route left is the
        // system settings page, so say that instead of showing the same button.
        Alert.alert(
          'Reminders are blocked',
          'Android will not ask again from inside the app. Open the app settings and turn on notifications.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => void Linking.openSettings() },
          ],
        );
      }
    } finally {
      setChecking(false);
    }
  };

  const checkForUpdate = async () => {
    setUpdateState('Checking…');
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateState('You are on the latest version.');
        return;
      }
      setUpdateState('Downloading…');
      await Updates.fetchUpdateAsync();
      setUpdateState('Ready. Restart to apply.');
    } catch (err) {
      // THE REAL REASON, not a guess at it. This used to report "no update
      // server reachable" for every possible failure, which sent an evening
      // chasing a network problem that did not exist while the server was
      // answering perfectly. Whatever went wrong, say what it was.
      const why = err instanceof Error ? err.message : String(err);
      setUpdateState(`Update check failed: ${why}`);
    }
  };

  const confirmReset = () => {
    Alert.alert(
      'Reset local data?',
      data.outbox.length > 0
        ? `${data.outbox.length} change${data.outbox.length === 1 ? '' : 's'} have not reached your PC yet. Resetting will lose them.`
        : 'This clears the copy on this phone and downloads everything again from your PC.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => void resetLocal() },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.md,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
      }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text variant="title">Settings</Text>
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close"
            style={{ width: HIT, height: HIT, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Text variant="title" tone="soft">✕</Text>
          </Pressable>
        </Row>
      </View>
      <Divider />

      <ScrollView contentContainerStyle={{
        padding: space.xl,
        paddingBottom: insets.bottom + space.xxl,
        gap: space.lg,
      }}>
        {/* ── Connection ── */}
        <Section title="Your planner">
          <KeyValue label="Signed in as" value={username ?? 'Not signed in'} />
          <KeyValue label="Server" value={serverUrl ?? 'Not set'} />
          <KeyValue label="This device" value={data.deviceId} />
          <Spacer size={space.md} />
          <Row gap={space.sm}>
            <Button label="Sync now" onPress={() => void syncNow()} variant="secondary" style={{ flex: 1 }} />
            <Button label="Sign out" onPress={() => void signOut()} variant="quiet" style={{ flex: 1 }} />
          </Row>
        </Section>

        {/* ── Sync ── */}
        <Section title="Sync">
          <KeyValue label="Status" value={status.label} />
          <KeyValue label="Waiting to send" value={String(data.outbox.length)} />
          <KeyValue label="Open conflicts" value={String(data.conflicts.length)} />
          <KeyValue
            label="Last synced"
            value={data.lastSyncedAt === null ? 'Never' : new Date(data.lastSyncedAt).toLocaleString()}
          />
          {lastError ? (
            <Text variant="caption" tone="danger" style={{ marginTop: space.sm }}>{lastError}</Text>
          ) : null}
        </Section>

        {/* ── Reminders ── */}
        <Section title="Notifications">
          <Text variant="body" tone="soft">
            Reminders are scheduled on this phone, so they fire with your PC switched off
            and with no internet connection.
          </Text>
          <Spacer size={space.md} />
          <KeyValue label="On this phone" value={alarmSummary} />
          <KeyValue
            label="Permission"
            value={perm === null ? 'Checking…' : perm.granted ? 'Allowed' : 'Not allowed'}
          />
          {perm && !perm.granted ? (
            <>
              <Spacer size={space.md} />
              <Button
                label="Allow reminders"
                onPress={askForPermissions}
                busy={checking}
              />
            </>
          ) : null}
          {perm && perm.granted && !perm.exactAlarms ? (
            <>
              <Spacer size={space.md} />
              <Text variant="caption" tone="warn">
                Android is allowed to delay these reminders to save battery. For exact
                timing, turn on "Alarms & reminders" for this app in system settings.
              </Text>
              <Spacer size={space.sm} />
              <Button label="Open system settings" variant="secondary" onPress={() => void Linking.openSettings()} />
            </>
          ) : null}
        </Section>

        {/* ── Appearance ── */}
        <Section title="Appearance">
          <Text variant="body">Theme</Text>
          <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
            Kept on this phone only. Your PC keeps its own.
          </Text>
          <Spacer size={space.sm} />
          <Row gap={space.xs}>
            {THEME_CHOICES.map(choice => {
              const on = choice.mode === themeMode;
              return (
                <Pressable
                  key={choice.mode}
                  onPress={() => setThemeMode(choice.mode)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={{
                    flex: 1,
                    height: 40,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 10,
                    backgroundColor: on ? p.accentSoft : p.surfaceAlt,
                    borderWidth: 1,
                    borderColor: on ? p.accent : p.line,
                  }}
                >
                  <Text variant="bodyStrong" tone={on ? 'accent' : 'soft'}>{choice.label}</Text>
                </Pressable>
              );
            })}
          </Row>
        </Section>

        {/* ── View ── */}
        {/* Everything here describes the piece of glass in your hand, not the
            plan. It is a section of its own rather than more rows under "This
            device" because these are the settings someone actually comes here
            to change, and burying the visible day under a snap interval made
            the screen look like it had nothing in it. */}
        <Section title="View">
          <Text variant="body">Visible hours</Text>
          <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
            Tap an hour to stop drawing it. They do not have to join up, so you can hide
            the middle of the night and keep both ends. Kept on this phone only.
          </Text>

          <Spacer size={space.md} />
          <HourStrip
            ranges={visibleHours}
            clock={clock}
            onToggle={hour => setVisibleHours(rangesFromHidden(
              hiddenHours(visibleHours).includes(hour)
                ? hiddenHours(visibleHours).filter((h: number) => h !== hour)
                : [...hiddenHours(visibleHours), hour],
            ))}
          />

          <Spacer size={space.sm} />
          <Text variant="caption" tone="soft">{describeRanges(visibleHours, clock)}</Text>

          <Spacer size={space.md} />
          <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
            {([
              ['Whole day', () => [{ from: 0, to: 24 }]],
              ['Waking hours', () => [{ from: 6, to: 24 }]],
              ['Working day', () => [{ from: 8, to: 18 }]],
              ['Hide 2am to 6am', () => rangesFromHidden([2, 3, 4, 5])],
            ] as [string, () => HourRange[]][]).map(([label, make]) => (
              <Pressable
                key={label}
                onPress={() => setVisibleHours(make())}
                accessibilityRole="button"
                style={{
                  paddingHorizontal: space.md, paddingVertical: 6,
                  borderRadius: 999,
                  borderWidth: 1, borderColor: p.line,
                }}
              >
                <Text variant="caption" tone="soft">{label}</Text>
              </Pressable>
            ))}
          </Row>

          <Spacer size={space.lg} />
          <Divider />
          <Spacer size={space.xs} />

          <Toggle
            label="Swipe between views"
            hint="Drag left or right across the grid to move to the next view. Turn off if it fights scrolling."
            value={swipeViewSwitch}
            onChange={setSwipeViewSwitch}
          />
        </Section>

        {/* ── This device ── */}
        <Section title="This device">
          <Text variant="body">Time slot snap interval</Text>
          <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
            How far each tap moves a time. Kept on this phone — your PC has its own.
          </Text>
          <Spacer size={space.sm} />
          <Row gap={space.xs}>
            {[5, 10, 15, 30, 60].map(mins => {
              const on = mins === interval;
              return (
                <Pressable
                  key={mins}
                  onPress={() => setInterval(mins)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={{
                    flex: 1,
                    height: 40,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 10,
                    backgroundColor: on ? p.accentSoft : p.surfaceAlt,
                    borderWidth: 1,
                    borderColor: on ? p.accent : p.line,
                  }}
                >
                  <Text variant="bodyStrong" tone={on ? 'accent' : 'soft'}>
                    {mins === 60 ? '1 hr' : `${mins}m`}
                  </Text>
                </Pressable>
              );
            })}
          </Row>

          <Spacer size={space.lg} />
          <Divider />
          <Spacer size={space.lg} />

          <Text variant="body">Span view</Text>
          <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
            How many days the Span view shows either side of the one you are on.
          </Text>
          <Spacer size={space.sm} />
          <Row gap={space.md} style={{ alignItems: 'center' }}>
            <Text variant="caption" tone="soft" style={{ width: 52 }}>Before</Text>
            <DayCount
              value={customWindow.before}
              onChange={n => setCustomWindow(n, customWindow.after)}
            />
          </Row>
          <Spacer size={space.sm} />
          <Row gap={space.md} style={{ alignItems: 'center' }}>
            <Text variant="caption" tone="soft" style={{ width: 52 }}>After</Text>
            <DayCount
              value={customWindow.after}
              onChange={n => setCustomWindow(customWindow.before, n)}
            />
          </Row>
          <Spacer size={space.sm} />
          <Text variant="caption" tone="faint">
            {customWindow.before + customWindow.after + 1} columns in total.
          </Text>
        </Section>

        {/* ── Your planner's own settings ── */}
        <Section title="Planner">
          <Pressable
            onPress={onOpenCategories}
            accessibilityRole="button"
            style={{
              flexDirection: 'row', alignItems: 'center',
              minHeight: HIT, gap: space.md,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body">Categories</Text>
              <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                Names, colours and the defaults new items start with. Shared with your PC.
              </Text>
            </View>
            <Text variant="title" tone="faint">›</Text>
          </Pressable>

          <Divider />

          <Pressable
            onPress={onOpenReminders}
            accessibilityRole="button"
            style={{
              flexDirection: 'row', alignItems: 'center',
              minHeight: HIT, gap: space.md,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body">Notifications</Text>
              <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                How early things alert, quiet hours and snoozing. Shared with your PC.
              </Text>
            </View>
            <Text variant="title" tone="faint">›</Text>
          </Pressable>

          <Divider />

          <Pressable
            onPress={onOpenPlanner}
            accessibilityRole="button"
            style={{
              flexDirection: 'row', alignItems: 'center',
              minHeight: HIT, gap: space.md,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body">The planner</Text>
              <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                Clock, week start, task colour and the focus day. Shared with your PC.
              </Text>
            </View>
            <Text variant="title" tone="faint">›</Text>
          </Pressable>

          <Divider />

          <Pressable
            onPress={onOpenPrayers}
            accessibilityRole="button"
            style={{
              flexDirection: 'row', alignItems: 'center',
              minHeight: HIT, gap: space.md,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant="body">Prayer times</Text>
              <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
                City, method, corrections and which ones show. Shared with your PC.
              </Text>
            </View>
            <Text variant="title" tone="faint">›</Text>
          </Pressable>
        </Section>

        {/* ── App ── */}
        <Section title="App">
          <KeyValue label="Version" value={Updates.runtimeVersion ?? '1.0.0'} />
          <KeyValue
            label="Update channel"
            value={Updates.isEmbeddedLaunch ? 'Built in' : 'Downloaded from your PC'}
          />
          {Updates.isEmbeddedLaunch ? (
            // Worth saying out loud. "Built in" means this is the bundle baked
            // into the APK, which is what you fall back to after clearing the
            // app data -- and it can be months behind the PC. Anyone hunting a
            // bug that was already fixed needs to see this before anything else.
            <Text variant="caption" tone="soft" style={{ marginTop: space.sm }}>
              Running the version built into the app, not the latest from your PC.
              Check for an update below.
            </Text>
          ) : null}
          {updateState ? (
            <Text variant="caption" tone="soft" style={{ marginTop: space.sm }}>{updateState}</Text>
          ) : null}
          <Spacer size={space.md} />
          <Row gap={space.sm}>
            <Button label="Check for update" variant="secondary" onPress={checkForUpdate} style={{ flex: 1 }} />
            {updateState?.startsWith('Ready') ? (
              <Button label="Restart" onPress={() => void Updates.reloadAsync()} style={{ flex: 1 }} />
            ) : null}
          </Row>
        </Section>

        {/* ── Danger ── */}
        <Section title="Local data">
          <Text variant="caption" tone="soft">
            Your PC keeps the master copy and its own backups. Resetting only clears the
            copy on this phone.
          </Text>
          <Spacer size={space.md} />
          <Button label="Reset local data" variant="danger" onPress={confirmReset} />
        </Section>
      </ScrollView>
    </View>
  );
}

/**
 * The whole day as a bar, with the chosen window lit up inside it.
 *
 * Two numbers and a sentence still ask you to picture the result. This does not:
 * the twenty-four hours are always drawn, the visible ones are filled, and the
 * hidden ones stay as faint outlines, so how much of the day you have cut away
 * is obvious at a glance and before leaving the screen. Ticks at midnight, 6,
 * noon and 6 give the eye something to measure against.
 *
 * Built from plain Views on purpose. There is no chart library here and there
 * must never be one: a native dependency would end over-the-air updates for this
 * app, and a preview strip is not worth that.
 */
/**
 * The day as twenty four cells, one per hour, tapped on and off.
 *
 * A START AND AN END COULD NOT SAY WHAT PEOPLE MEAN. "Everything except the
 * middle of the night" needs two stretches, and no pair of numbers expresses
 * two stretches. Twenty four switches express every possible answer, take one
 * tap each, and show the shape of the day at a glance rather than describing it.
 *
 * Laid out as two rows of twelve. One row of twenty four cells on a phone gives
 * each about fourteen points, which is under any reasonable touch target.
 */
function HourStrip({ ranges, clock, onToggle }: {
  ranges: HourRange[];
  clock: ClockFormat;
  onToggle: (hour: number) => void;
}) {
  const p = useTheme();
  const off = new Set(hiddenHours(ranges));

  const row = (from: number) => (
    <Row gap={2}>
      {Array.from({ length: 12 }, (_, i) => {
        const hour = from + i;
        const shown = !off.has(hour);
        return (
          <Pressable
            key={hour}
            onPress={() => onToggle(hour)}
            accessibilityRole="switch"
            accessibilityState={{ checked: shown }}
            accessibilityLabel={`${formatHour(hour, clock)}, ${shown ? 'shown' : 'hidden'}`}
            style={{
              flex: 1,
              height: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: shown ? p.accent : p.line,
              backgroundColor: shown ? p.accentSoft : 'transparent',
            }}
          >
            <Text
              variant="caption"
              tone={shown ? 'accent' : 'faint'}
              style={{ fontSize: 10, fontWeight: shown ? '700' : '400' }}
            >
              {hour === 0 ? '12a' : hour === 12 ? '12p' : hour < 12 ? `${hour}a` : `${hour - 12}p`}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );

  return (
    <View accessible={false} style={{ gap: 3 }}>
      {row(0)}
      {row(12)}
    </View>
  );
}

/** "System" first, because it is the default and the one most people leave on. */
const THEME_CHOICES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

/**
 * A small count of days.
 *
 * Buttons rather than a slider or a text field: the useful range is nought to
 * six, every value is one tap away, and nothing has to be typed on a phone
 * keyboard to change a number by one.
 */
function DayCount({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const p = useTheme();
  return (
    <Row gap={space.xs} style={{ flex: 1 }}>
      {[0, 1, 2, 3, 4, 5, 6].map(n => {
        const on = n === value;
        return (
          <Pressable
            key={n}
            onPress={() => onChange(n)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              height: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              backgroundColor: on ? p.accentSoft : p.surfaceAlt,
              borderWidth: 1,
              borderColor: on ? p.accent : p.line,
            }}
          >
            <Text variant="caption" tone={on ? 'accent' : 'soft'}>{n}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label" tone="faint">{title}</Text>
      <Card>{children}</Card>
    </View>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }} align="flex-start">
      <Text variant="caption" tone="faint" style={{ flex: 1 }}>{label}</Text>
      <Text variant="caption" style={{ flex: 1.6, textAlign: 'right' }} numberOfLines={2}>
        {value}
      </Text>
    </Row>
  );
}
