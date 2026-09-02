// ─── The planner's own settings ──────────────────────────────────────────────
// The handful of choices that describe the PLANNER rather than the phone.
//
// WHY THESE ARE HERE AND NOT UNDER "THIS DEVICE"
// The settings screen already has a device section: the view, the snap interval,
// the visible hours, the theme. Those are properties of the screen in your hand,
// and the desk must never be able to push its answer into them. Everything on
// this screen is the opposite kind of thing. A phone whose weeks began on Sunday
// while the desk's began on Monday would not be two preferences, it would be two
// different calendars, and every repeat expanded against the week start would
// land on a different day on each machine. So these travel, and the screen says
// so plainly on every one of them rather than leaving it to be discovered.
//
// The clock is the one people look for first, which is why it is at the top: it
// changes every time written anywhere in the planner, on both machines.
//
// WRITING IS PER FIELD, DELIBERATELY. `displayPatch` returns only what actually
// moved, because the sync layer stamps every field it is handed: sending all six
// on every tap would out-rank five settings the desk may have changed a second
// earlier for the sake of the one that did change. That is not a visible error.
// It is a setting quietly reverting on the other machine an hour later.

import React, { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, Divider, Row, Spacer, Text, useTheme } from '../ui/kit';
import { Field, Segment } from '../ui/Fields';
import { HIT, PRESSED, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import {
  TIME_FORMATS,
  WEEK_START_LABELS,
  coerceDisplaySettings,
  displayPatch,
  type DisplaySettings,
} from '../lib/displaySettings';

export function Planner({ onClose }: { onClose?: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { shared, edit } = usePlanner();

  /**
   * Read straight from the shared settings, not from a copy held here.
   *
   * A local copy would show the phone's last tap while the desk's own change was
   * landing underneath it, and the screen would sit there disagreeing with the
   * planner it is configuring.
   */
  const s: DisplaySettings = useMemo(
    () => coerceDisplaySettings(shared as unknown),
    [shared],
  );

  const set = (patch: Partial<DisplaySettings>) => {
    const changed = displayPatch(shared as unknown, patch);
    // An empty patch is a genuine no-op. A redundant write is a sync op that can
    // lose a race against a real one.
    if (Object.keys(changed).length === 0) return;
    void edit('settings', SETTINGS_ENTITY, changed);
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Row gap={space.md} style={{ alignItems: 'center' }}>
          {onClose ? (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={space.sm}
              style={({ pressed }) => [{ minWidth: HIT / 2, justifyContent: 'center' }, pressed ? PRESSED : null]}
            >
              <Text variant="title" tone="accent">‹</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text variant="heading">The planner</Text>
            <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
              Shared with your PC. Changing one here changes it there.
            </Text>
          </View>
        </Row>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: insets.bottom + space.xxl,
          gap: space.lg,
        }}
      >
        {/* ── The clock ──
            First, because it is the one people come looking for, and because it
            changes every time written anywhere in the planner. */}
        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">TIME</Text>
          <Card style={{ gap: space.lg }}>
            <Field
              label="Clock"
              hint={TIME_FORMATS.find(f => f.id === s.timeFormat)?.hint}
            >
              <Segment
                options={TIME_FORMATS.map(f => ({ key: f.id, label: f.label }))}
                value={s.timeFormat}
                onChange={k => set({ timeFormat: k as DisplaySettings['timeFormat'] })}
              />
            </Field>

            <Field
              label="Weeks start on"
              hint="Repeats are worked out from this, so both machines have to agree."
            >
              <Row gap={4} style={{ flexWrap: 'wrap' }}>
                {WEEK_START_LABELS.map(day => {
                  const on = day.id === s.weekStartsOn;
                  return (
                    <Pressable
                      key={day.id}
                      onPress={() => set({ weekStartsOn: day.id })}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={day.label}
                      style={({ pressed }) => [{
                        paddingHorizontal: space.md,
                        paddingVertical: 7,
                        borderRadius: radius.sm,
                        borderWidth: 1,
                        borderColor: on ? p.accent : p.line,
                        backgroundColor: on ? p.accentSoft : 'transparent',
                      }, pressed ? PRESSED : null]}
                    >
                      <Text
                        variant="caption"
                        tone={on ? 'accent' : 'soft'}
                        style={{ fontWeight: on ? '700' : '400' }}
                      >
                        {day.short}
                      </Text>
                    </Pressable>
                  );
                })}
              </Row>
            </Field>
          </Card>
        </View>

        <Divider />
        <Text variant="caption" tone="faint">
          Everything on this screen is shared. The view, the snap interval, the visible hours
          and the theme are kept on this phone alone, back in Settings, along with task lists,
          categories and the colour tasks are drawn in.
        </Text>
        <Spacer size={space.md} />
      </ScrollView>
    </View>
  );
}
