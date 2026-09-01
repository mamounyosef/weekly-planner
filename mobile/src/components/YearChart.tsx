import React from 'react';
import { View } from 'react-native';
import { Text, useTheme } from '../ui/kit';
import { space } from '../theme';
import { describeDuration } from '../lib/focusStats';

export function YearChart({ 
  months, 
  yearMaxSeconds 
}: { 
  months: { month: Date; seconds: number; sessions: number; activeDays: number }[];
  yearMaxSeconds: number;
}) {
  const p = useTheme();
  
  return (
    <View style={{ marginTop: space.md, gap: space.md }}>
      {months.map((m, i) => {
        const h = m.seconds > 0 ? Math.max(5, (m.seconds / yearMaxSeconds) * 100) : 0;
        const name = m.month.toLocaleString('default', { month: 'short' });
        
        return (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text variant="caption" tone="faint" style={{ width: 45, textTransform: 'uppercase' }}>
              {name}
            </Text>
            <View style={{ flex: 1, height: 28, backgroundColor: p.line, borderRadius: 4, overflow: 'hidden' }}>
              <View style={{ 
                width: `${h}%`, 
                height: '100%', 
                backgroundColor: p.accent,
                opacity: m.seconds > 0 ? 1 : 0 
              }} />
            </View>
            <Text variant="caption" tone="faint" style={{ width: 55, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
              {m.seconds > 0 ? describeDuration(m.seconds) : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
