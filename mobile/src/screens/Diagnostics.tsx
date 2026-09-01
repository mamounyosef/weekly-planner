import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text, useTheme, Card } from '../ui/kit';
import { space } from '../theme';
import { usePlanner } from '../state/planner';
import { assessSyncHealth, formatTimeSince } from '../lib/syncHealth';

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const { status, serverUrl } = usePlanner();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  const health = assessSyncHealth(status, now);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      <Text variant="heading">Diagnostics</Text>
      
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

      <Text variant="caption" tone="faint" style={{ marginTop: space.lg, textAlign: 'center' }}>
        This page shows the raw transport layer details. If you see items pending for a long time while connected, check the server logs on your PC.
      </Text>
    </ScrollView>
  );
}
