import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Row, Text, useTheme, Card } from '../ui/kit';
import { PRESSED, PRESS_DELAY, clearNav, space } from '../theme';
import { usePlanner } from '../state/planner';
import { assessSyncHealth, formatTimeSince } from '../lib/syncHealth';

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { status, serverUrl, syncNow } = usePlanner();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  const health = assessSyncHealth(status, now);

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Text variant="caption" tone="faint">THIS PHONE</Text>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="display">Diagnostics</Text>
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            onPress={onClose}
            accessibilityLabel="Back to settings"
            hitSlop={space.md}
            style={({ pressed }) => [{ paddingHorizontal: space.sm }, pressed ? PRESSED : null]}
          >
            <Text variant="title" tone="soft">✕</Text>
          </Pressable>
        </Row>
      </View>

    <ScrollView contentContainerStyle={{
      padding: space.lg,
      paddingBottom: clearNav(insets.bottom) + space.xxl,
      gap: space.md,
    }}>
      
      <Card style={{ gap: space.sm }}>
        <Text variant="label" tone="faint">SYNC HEALTH</Text>
        
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm }}>
          <Text variant="body">Status</Text>
          <Text variant="body" tone={health.isHealthy ? 'accent' : 'danger'}>
            {health.isHealthy ? 'Healthy' : 'Needs Attention'}
          </Text>
        </View>
        
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm }}>
          <Text variant="body">Phase</Text>
          <Text variant="body">{status.phase}</Text>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm }}>
          <Text variant="body">Last Synced</Text>
          <Text variant="body">{formatTimeSince(health.timeSinceLastSyncMs)}</Text>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm }}>
          <Text variant="body">Pending Changes</Text>
          <Text variant="body">{status.pending}</Text>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm }}>
          <Text variant="body">Server</Text>
          <Text variant="body" tone="soft">{serverUrl || 'Not connected'}</Text>
        </View>
      </Card>

      {health.issues.length > 0 && (
        <Card style={{ gap: space.sm, borderColor: p.danger }}>
          <Text variant="label" tone="danger">ISSUES</Text>
          {health.issues.map((issue, i) => (
            <Text key={i} variant="body" tone="danger">• {issue}</Text>
          ))}
        </Card>
      )}

      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => { void syncNow(); }}
        style={({ pressed }) => [{
          alignSelf: 'flex-start',
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: p.line,
        }, pressed ? PRESSED : null]}
      >
        <Text variant="caption" tone="accent">Sync now</Text>
      </Pressable>

      <Text variant="caption" tone="faint" style={{ marginTop: space.lg, textAlign: 'center' }}>
        This page shows the raw transport layer details. If you see items pending for a long time while connected, check the server logs on your PC.
      </Text>
    </ScrollView>
    </View>
  );
}
