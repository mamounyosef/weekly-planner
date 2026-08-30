// ─── The bottom bar ──────────────────────────────────────────────────────────
// Four places, always visible, always in the same order. The planner is used
// one-handed and in a hurry, so the way between its parts has to be a single
// thumb movement rather than a back gesture and a menu.
//
// DELIBERATELY SHORT. The bar costs vertical space on every screen it appears
// on, and vertical space is what a day view is made of. So it is a single
// compact row — glyph and label on one line each, no oversized icons, no
// floating pill — and it sits directly on the system inset rather than padding
// itself away from it.
//
// The badge on Calendar carries conflicts, because a conflict is the one thing
// in this app that will not resolve itself and needs a person.

import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useTheme } from './kit';
import { space } from '../theme';

export type TabId = 'calendar' | 'tasks' | 'focus' | 'settings';

export interface TabDef {
  id: TabId;
  label: string;
  glyph: string;
  badge?: number;
}

/**
 * The order is fixed and matches the PC's own mobile shell: what is on, what to
 * do, how the time went, and how it all behaves.
 */
export const TABS: readonly TabDef[] = [
  { id: 'calendar', label: 'Calendar', glyph: '▦' },
  { id: 'tasks', label: 'Tasks', glyph: '✓' },
  { id: 'focus', label: 'Focus', glyph: '◐' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

export function TabBar({ active, onChange, badges }: {
  active: TabId;
  onChange: (id: TabId) => void;
  badges?: Partial<Record<TabId, number>>;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: p.surface,
        borderTopWidth: 1,
        borderTopColor: p.line,
        paddingTop: 6,
        // Sits ON the system inset rather than above it, so the bar itself stays
        // short on phones with a gesture bar.
        paddingBottom: Math.max(insets.bottom, 6),
      }}
    >
      {TABS.map(tab => {
        const on = tab.id === active;
        const badge = badges?.[tab.id];
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge ? `${tab.label}, ${badge} needing attention` : tab.label}
            android_ripple={{ color: p.accentSoft, borderless: false }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 4,
              gap: 1,
            }}
          >
            <View>
              <Text
                style={{
                  fontSize: 17,
                  lineHeight: 20,
                  color: on ? p.accent : p.inkFaint,
                }}
              >
                {tab.glyph}
              </Text>
              {badge ? (
                <View style={{
                  position: 'absolute',
                  top: -3,
                  right: -9,
                  minWidth: 15,
                  height: 15,
                  paddingHorizontal: 3,
                  borderRadius: 8,
                  backgroundColor: p.warn,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Text style={{
                    color: p.accentInk, fontSize: 9, lineHeight: 11, fontWeight: '800',
                  }}>
                    {badge > 9 ? '9+' : badge}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text
              style={{
                fontSize: 10,
                lineHeight: 13,
                fontWeight: on ? '700' : '500',
                color: on ? p.accent : p.inkFaint,
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
