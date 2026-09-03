// ─── Settings and diagnostics ────────────────────────────────────────────────
// Deliberately small. The PC owns configuration; this screen answers the three
// questions a phone actually raises: is it connected, are reminders allowed to
// fire, and what is waiting to sync.
//
// Desk Controller, Backups & Data and Keyboard Shortcuts are absent on purpose —
// they belong to the machine on the desk.

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, BackHandler, Linking, Pressable, ScrollView, View, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';

import { Button, Card, Divider, Row, Spacer, Text, useTheme, useThemeMode } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { Segment, Stepper, Toggle } from '../ui/Fields';
import { HIT, PRESSED, PRESS_DELAY, radius, space, type ThemeMode } from '../theme';
import { usePlanner } from '../state/planner';
import {
  describeRanges, hiddenHours, rangesFromHidden, type HourRange,
} from '../lib/dayWindows';
import { checkPermissions, requestPermissions, type PermissionState } from '../lib/notify';
import { prefs } from '../lib/prefs';
import { describeUpdate, updateStamp } from '../lib/updateLabel';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import {
  CHECKBOX_SHAPES,
  TASK_COLOURS,
  coerceDisplaySettings,
  displayPatch,
  type DisplaySettings,
} from '../lib/displaySettings';
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
  onClose, onOpenCategories, onOpenTasks, onOpenReminders, onOpenPrayers, onOpenPlanner,
  onOpenDiagnostics,
}: {
  onClose: () => void;
  onOpenCategories?: () => void;
  onOpenTasks?: () => void;
  onOpenReminders?: () => void;
  onOpenPrayers?: () => void;
  onOpenPlanner?: () => void;
  onOpenDiagnostics?: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    username, serverUrl, status, data, alarmSummary, lastError,
    signOut, syncNow, resetLocal, interval, setInterval,
    customWindow, setCustomWindow, timeFormat,
    visibleHours, setVisibleHours, swipeViewSwitch, setSwipeViewSwitch,
    dayWindow, setDayStart, setDayEnd,
    shared, edit,
  } = usePlanner();

  const { mode: themeMode, setMode: setThemeMode } = useThemeMode();

  // How a task LOOKS is answered here, beside the theme, because that is the
  // question being asked. It is still a shared setting rather than a device one,
  // so it is read straight from the store and written per field, exactly as the
  // planner screen does: a whole-object write would out-rank whatever the desk
  // changed a moment ago for the sake of the one field that actually moved.
  const display: DisplaySettings = useMemo(
    () => coerceDisplaySettings(shared as unknown),
    [shared],
  );

  const setDisplay = (patch: Partial<DisplaySettings>) => {
    const changed = displayPatch(shared as unknown, patch);
    if (Object.keys(changed).length === 0) return;
    void edit('settings', SETTINGS_ENTITY, changed);
  };

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


  const [section, setSection] = useState<string | null>(null);


  useEffect(() => {
    if (!section) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSection(null);
      return true; // prevent default behavior
    });
    return () => sub.remove();
  }, [section]);

  // "22 minutes ago" has to keep being true while the screen is open, so the
  // row is re-rendered on a timer rather than only when it is first drawn.
  //
  // `setInterval` is deliberately reached through globalThis: this component
  // destructures a `setInterval` of its own from the planner (the snap
  // interval), which shadows the timer function and would otherwise be called
  // with a callback where a number of minutes belongs.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (section !== 'data') return;
    setTick(Date.now());
    const id = globalThis.setInterval(() => setTick(Date.now()), 30_000);
    return () => globalThis.clearInterval(id);
  }, [section]);

  const age = useMemo(
    () => describeUpdate(Updates.createdAt, new Date(tick), clock),
    [tick, clock],
  );
  const stamp = useMemo(() => updateStamp(Updates.createdAt) ?? '', []);

  const renderSectionList = () => (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
      <Section title="Account & Data">
        <MenuRow label="User Account" hint="Server, sync, and sign out" iconName="user" onPress={() => setSection('account')} />
        <MenuRow label="App & Data" hint="Updates and local storage" iconName="hard-drive" onPress={() => setSection('data')} />
      </Section>
      <Section title="Preferences">
        <MenuRow label="Appearance" hint="Theme, and how tasks are drawn" iconName="palette" onPress={() => setSection('appearance')} />
        <MenuRow label="Calendar Grid" hint="Visible hours and gestures" iconName="calendar" onPress={() => setSection('calendar')} />
      </Section>
      <Section title="Configuration">
        <MenuRow label="Core Planner" hint="Clock format, week start" iconName="settings" onPress={onOpenPlanner} />
        <MenuRow label="Categories" hint="Colours, and what a new item starts as" iconName="tag" onPress={onOpenCategories} />
        <MenuRow label="Tasks" hint="Lists, and overdue repeats" iconName="check-square" onPress={onOpenTasks} />
        <MenuRow label="Notifications" hint="Alarms and permissions" iconName="bell" onPress={onOpenReminders} />
        <MenuRow label="Prayer Times" hint="Calculation methods and display" iconName="compass" onPress={onOpenPrayers} />
      </Section>
      <Section title="Support">
        <MenuRow
          label="Diagnostics"
          hint="Sync health, and when this phone last spoke to the PC"
          iconName="activity"
          onPress={onOpenDiagnostics}
        />
      </Section>
    </ScrollView>
  );

  const renderAccount = () => (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: insets.bottom + space.xxl, gap: space.lg }}>
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
    </ScrollView>
  );

  const renderData = () => (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: insets.bottom + space.xxl, gap: space.lg }}>
      <Section title="App">
        <KeyValue label="Update" value={age ? age.when : 'Built into the app'} />
        <Text variant="caption" tone="faint" style={{ marginTop: 2, textAlign: 'right' }}>
          {age ? `${age.ago}  ·  ${stamp}` : 'Running the bundle that shipped with the APK'}
        </Text>
        <Spacer size={space.xs} />
        <KeyValue label="Runtime" value={Updates.runtimeVersion ?? '1.0.0'} />
        <KeyValue label="Update channel" value={Updates.isEmbeddedLaunch ? 'Built in' : 'Downloaded from your PC'} />
        {Updates.isEmbeddedLaunch && (
          <Text variant="caption" tone="soft" style={{ marginTop: space.sm }}>Running the version built into the app, not the latest from your PC. Check for an update below.</Text>
        )}
        {updateState && <Text variant="caption" tone="soft" style={{ marginTop: space.sm }}>{updateState}</Text>}
        <Spacer size={space.md} />
        <Row gap={space.sm}>
          <Button label="Check for update" variant="secondary" onPress={checkForUpdate} style={{ flex: 1 }} />
          {updateState?.startsWith('Ready') && <Button label="Restart" onPress={() => void Updates.reloadAsync()} style={{ flex: 1 }} />}
        </Row>
      </Section>
      <Section title="Local data">
        <Text variant="caption" tone="soft">Your PC keeps the master copy and its own backups. Resetting only clears the copy on this phone.</Text>
        <Spacer size={space.md} />
        <Button label="Reset local data" variant="danger" onPress={confirmReset} />
      </Section>
    </ScrollView>
  );

  const renderAppearance = () => (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: insets.bottom + space.xxl, gap: space.lg }}>
      <Section title="Appearance">
        <Text variant="body">Theme</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>The app follows your phone by default.</Text>
        <Spacer size={space.sm} />
        <Row gap={space.xs}>
          {THEME_CHOICES.map(choice => {
            const on = choice.mode === themeMode;
            return (
              <Pressable
        unstable_pressDelay={PRESS_DELAY} key={choice.mode} onPress={() => setThemeMode(choice.mode)} accessibilityRole="button" accessibilityState={{ selected: on }} style={({ pressed }) => [{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: on ? p.accentSoft : p.surfaceAlt, borderWidth: 1, borderColor: on ? p.accent : p.line }, pressed ? PRESSED : null]}>
                <Text variant="bodyStrong" tone={on ? 'accent' : 'soft'}>{choice.label}</Text>
              </Pressable>
            );
          })}
        </Row>
      </Section>
      <Section title="Tasks">
        <Text variant="caption" tone="soft">
          How tasks are drawn on the grid. Shared with your PC, so changing it here changes it there.
        </Text>
        <Spacer size={space.md} />
        <Text variant="body">Colour on the grid</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
          Tasks drawn on the calendar all wear this one colour.
        </Text>
        <Spacer size={space.sm} />
        <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
          {TASK_COLOURS.map(hex => {
            const on = hex.toLowerCase() === display.taskColor.toLowerCase();
            return (
              <Pressable
        unstable_pressDelay={PRESS_DELAY}
                key={hex}
                onPress={() => setDisplay({ taskColor: hex })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Task colour ${hex}`}
                style={({ pressed }) => [{
                  width: 30, height: 30,
                  borderRadius: 15,
                  backgroundColor: hex,
                  borderWidth: on ? 3 : 1,
                  borderColor: on ? p.ink : p.line,
                }, pressed ? PRESSED : null]}
              />
            );
          })}
        </Row>
        <Spacer size={space.lg} />
        <Text variant="body">Tick box</Text>
        <Spacer size={space.sm} />
        <Segment
          options={CHECKBOX_SHAPES.map(c => ({ key: c.id, label: c.label }))}
          value={display.taskCheckboxShape}
          onChange={k => setDisplay({ taskCheckboxShape: k as DisplaySettings['taskCheckboxShape'] })}
        />
      </Section>
    </ScrollView>
  );

  const renderCalendar = () => (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: insets.bottom + space.xxl, gap: space.lg }}>
      <Section title="View">
        <Text variant="body">Visible Schedule Hours</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>{describeDayWindow(dayWindow, clock)}</Text>
        <Spacer size={space.sm} />
        <Row gap={space.sm}>
          <Text variant="caption" tone="soft" style={{ width: 85, textAlign: 'right' }}>Start Hour</Text>
          <Stepper
            value={dayWindow.start}
            min={DAY_HOUR_MIN}
            max={DAY_HOUR_MAX - 1}
            onChange={setDayStart}
            format={v => formatHour(v, clock)}
          />
        </Row>
        <Row gap={space.sm}>
          <Text variant="caption" tone="soft" style={{ width: 85, textAlign: 'right' }}>Span Duration</Text>
          <Stepper
            value={dayWindow.end - dayWindow.start}
            min={1}
            max={24}
            onChange={v => setDayEnd(dayWindow.start + v)}
            format={v => v === 24 ? '24 Hours (Full Day)' : `${v} Hours`}
          />
        </Row>
        <Spacer size={space.lg} />
        <Divider />
        <Spacer size={space.lg} />
        <Text variant="body">Visible hours within span</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>{describeRanges(visibleHours, clock)}</Text>
        <Spacer size={space.sm} />
        <HourStrip ranges={visibleHours} clock={clock} onToggle={h => {
          const on = !new Set(hiddenHours(visibleHours)).has(h);
          let hours = Array.from({ length: 24 }, (_, i) => i).filter(x => new Set(hiddenHours(visibleHours)).has(x) ? false : true);
          if (on) { hours = hours.filter(x => x !== h); } else { hours.push(h); hours.sort((a,b)=>a-b); }
          const off = Array.from({ length: 24 }, (_, i) => i).filter(x => !hours.includes(x));
          setVisibleHours(rangesFromHidden(off));
        }} />
        <Spacer size={space.xs} />
        <Text variant="body">Span view</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>How many days the Span view shows either side of the one you are on.</Text>
        <Spacer size={space.sm} />
        <Row gap={space.sm}>
          <Text variant="caption" tone="soft" style={{ width: 40, textAlign: 'right' }}>Before</Text>
          <DayCount value={customWindow.before} onChange={n => setCustomWindow(n, customWindow.after)} />
        </Row>
        <Row gap={space.sm}>
          <Text variant="caption" tone="soft" style={{ width: 40, textAlign: 'right' }}>After</Text>
          <DayCount value={customWindow.after} onChange={n => setCustomWindow(customWindow.before, n)} />
        </Row>
        <Spacer size={space.xs} />
        <Toggle label="Swipe between views" hint="Drag left or right across the grid to move to the next view. Turn off if it fights scrolling." value={swipeViewSwitch} onChange={setSwipeViewSwitch} />
      </Section>
      <Section title="This device">
        <Text variant="body">Time slot snap interval</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>How far each tap moves a time. Kept on this phone — your PC has its own.</Text>
        <Spacer size={space.sm} />
        <Row gap={space.xs}>
          {[5, 10, 15, 30, 60].map(mins => {
            const on = mins === interval;
            return (
              <Pressable
        unstable_pressDelay={PRESS_DELAY} key={mins} onPress={() => setInterval(mins)} accessibilityRole="button" accessibilityState={{ selected: on }} style={({ pressed }) => [{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: on ? p.accentSoft : p.surfaceAlt, borderWidth: 1, borderColor: on ? p.accent : p.line }, pressed ? PRESSED : null]}>
                <Text variant="bodyStrong" tone={on ? 'accent' : 'soft'}>{mins === 60 ? '1 hr' : `${mins}m`}</Text>
              </Pressable>
            );
          })}
        </Row>
      </Section>
    </ScrollView>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{ paddingTop: insets.top + space.md, paddingHorizontal: space.xl, paddingBottom: space.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={space.sm} style={{ alignItems: 'center' }}>
            {section && (
              <Pressable
        unstable_pressDelay={PRESS_DELAY} onPress={() => setSection(null)} accessibilityLabel="Back" style={({ pressed }) => [{ width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', marginLeft: -10 }, pressed ? PRESSED : null]}>
                <Text variant="title" tone="soft">‹</Text>
              </Pressable>
            )}
            <Text variant="title">{section === 'account' ? 'User Account' : section === 'data' ? 'App & Data' : section === 'appearance' ? 'Appearance' : section === 'calendar' ? 'Calendar Grid' : 'Settings'}</Text>
          </Row>
          <Pressable
        unstable_pressDelay={PRESS_DELAY} onPress={onClose} accessibilityLabel="Close" style={({ pressed }) => [{ width: HIT, height: HIT, alignItems: 'flex-end', justifyContent: 'center' }, pressed ? PRESSED : null]}>
            <Text variant="title" tone="soft">×</Text>
          </Pressable>
        </Row>
      </View>
      <Divider />

      {section === null ? renderSectionList() : section === 'account' ? renderAccount() : section === 'data' ? renderData() : section === 'appearance' ? renderAppearance() : section === 'calendar' ? renderCalendar() : null}
    </View>
  );
}

function MenuRow({ label, hint, iconName, onPress }: { label: string; hint: string; iconName?: string; onPress?: () => void }) {
  const p = useTheme();
  if (!onPress) return null;
  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', minHeight: HIT, gap: space.md, paddingVertical: space.xs }, pressed ? PRESSED : null]}
    >
      <View style={{ width: 32, alignItems: 'center' }}>
        {iconName && ICONS[iconName] ? (
          <Image source={{ uri: ICONS[iconName] }} style={{ width: 24, height: 24, tintColor: p.accent }} />
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>{hint}</Text>
      </View>
      <Text variant="title" tone="faint">›</Text>
    </Pressable>
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
        unstable_pressDelay={PRESS_DELAY}
            key={hour}
            onPress={() => onToggle(hour)}
            accessibilityRole="switch"
            accessibilityState={{ checked: shown }}
            accessibilityLabel={`${formatHour(hour, clock)}, ${shown ? 'shown' : 'hidden'}`}
            style={({ pressed }) => [{
              flex: 1,
              height: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: shown ? p.accent : p.line,
              backgroundColor: shown ? p.accentSoft : 'transparent',
            }, pressed ? PRESSED : null]}
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
        unstable_pressDelay={PRESS_DELAY}
            key={n}
            onPress={() => onChange(n)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [{
              flex: 1,
              height: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              backgroundColor: on ? p.accentSoft : p.surfaceAlt,
              borderWidth: 1,
              borderColor: on ? p.accent : p.line,
            }, pressed ? PRESSED : null]}
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
