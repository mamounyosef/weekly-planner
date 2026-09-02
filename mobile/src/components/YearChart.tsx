import React from 'react';
import { View } from 'react-native';
import { Text, useTheme } from '../ui/kit';
import { space } from '../theme';
import { describeDuration } from '../lib/focusStats';

/** A month's short name, and never a thrown error. */
function monthName(month: Date): string {
  if (!(month instanceof Date) || Number.isNaN(month.getTime())) return '';
  try {
    return month.toLocaleString(undefined, { month: 'short' });
  } catch {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month.getMonth()] ?? '';
  }
}

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
        // NOT toLocaleString('default'): that is not a language tag, and
        // Hermes rejects an unusable one with a RangeError rather than
        // quietly falling back the way a browser does. `undefined` is the
        // spelled-out way to ask for the device's own locale.
        const name = monthName(m.month);
        
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
