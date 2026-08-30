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

import { Button, Card, Divider, Row, Spacer, Text, useTheme } from '../ui/kit';
import { space, HIT } from '../theme';
import { usePlanner } from '../state/planner';
import { checkPermissions, requestPermissions, type PermissionState } from '../lib/notify';

export function Settings({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    username, serverUrl, status, data, alarmSummary, lastError,
    signOut, syncNow, resetLocal, interval, setInterval,
  } = usePlanner();

  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateState, setUpdateState] = useState<string | null>(null);

  useEffect(() => { void checkPermissions().then(setPerm); }, []);

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
        <Section title="Reminders">
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
