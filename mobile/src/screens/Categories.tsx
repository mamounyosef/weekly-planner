// ─── Categories ──────────────────────────────────────────────────────────────
// The colours and the habits behind every item, in one place.
//
// A CATEGORY IS A SHARED SETTING, not a phone thing. It lives in the same synced
// settings record the PC writes, so renaming one here renames it on the desk and
// recolours every item that uses it in both places. That is why the whole list
// is written back as one value on every change: the sync layer merges per FIELD,
// and `categories` is a single field. Two devices editing different categories
// at the same moment would still collide on that field, so the write is kept as
// short-lived and as whole as possible rather than being built up in pieces.
//
// NOTHING IS EDITED IN PLACE. The array in the context is the same object the
// merge layer is holding; mutating it would change the value the next diff is
// compared against, and the edit would be silently dropped as "no change".
//
// NO NATIVE PICKERS. Same delivery rule as the editor: a native module means
// this app can only reach the phone as a whole new APK instead of over the air.

import React, { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Row, Text, useTheme } from '../ui/kit';
import { ColourPicker, Field, Stepper, TextField, Toggle } from '../ui/Fields';
import { PRESSED, PRESS_DELAY, clearNav, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import { SWATCH_BASE_HEX } from '../lib/gcalColor';
import type { EventCategory } from '../lib/categories';

/**
 * The palette, keyed by its own hex.
 *
 * A category stores a hex code, not a swatch name, because the PC resolves a
 * category's colour straight to CSS without a name table in between. Keying each
 * swatch by its hex makes the picker hand back exactly what gets stored.
 */
const SWATCHES = Object.values(SWATCH_BASE_HEX).map(hex => ({ key: hex, hex }));

const FALLBACK_COLOUR = SWATCHES[0].hex;

/** Steps a duration can take. Matches the granularity the PC's own form offers. */
const DURATION_STEP = 5;

export function Categories({ onClose }: { onClose?: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { categories, edit } = usePlanner();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useMemo<EventCategory[]>(
    () => (categories as EventCategory[]).filter(c => c && typeof c === 'object'),
    [categories],
  );

  const editing = editingId === null ? null : list.find(c => c.id === editingId) ?? null;

  /**
   * Write the list back.
   *
   * One call, one whole array. Anything the phone does not understand about a
   * category (the PC's notification specs, the widget flag) rides along inside
   * the objects untouched, so an older phone build can never strip a newer PC
   * field just by renaming something.
   */
  const write = (next: EventCategory[]) => {
    void edit('settings', SETTINGS_ENTITY, { categories: next });
  };

  const save = (draft: EventCategory) => {
    const exists = list.some(c => c.id === draft.id);
    let next = exists
      ? list.map(c => (c.id === draft.id ? draft : c))
      : [...list, draft];

    // "Default for new items" is a property of the LIST, not of one category:
    // two of them claiming it would make which one wins depend on array order,
    // which nothing in the UI ever shows.
    if (draft.isDefault) {
      next = next.map(c => (c.id === draft.id ? c : { ...c, isDefault: false }));
    }

    write(next);
    setEditingId(null);
    setCreating(false);
  };

  const confirmDelete = (cat: EventCategory) => {
    Alert.alert(
      `Delete "${cat.name || 'Untitled'}"?`,
      'Items in this category keep their name and their time, but they lose this colour and fall back to plain. Nothing else is removed, on this phone or on your PC.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            write(list.filter(c => c.id !== cat.id));
            setEditingId(null);
            setCreating(false);
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Text variant="caption" tone="faint">
          {list.length === 0
            ? 'NONE YET'
            : `${list.length} ${list.length === 1 ? 'CATEGORY' : 'CATEGORIES'}`}
        </Text>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="display">Categories</Text>
          {onClose ? (
            <Pressable
        unstable_pressDelay={PRESS_DELAY}
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

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + 120,
          gap: space.sm,
        }}
      >
        {list.length === 0 ? (
          <View style={{ paddingTop: space.xxl, alignItems: 'center', gap: space.sm }}>
            <Text variant="heading" tone="soft">No categories yet</Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 260 }}>
              Make one with the button below. Categories colour your items and set
              what a new one starts out as.
            </Text>
          </View>
        ) : null}

        {list.map(cat => (
          <CategoryRow key={cat.id} cat={cat} onOpen={() => setEditingId(cat.id)} />
        ))}
      </ScrollView>

      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => { setEditingId(null); setCreating(true); }}
        accessibilityRole="button"
        accessibilityLabel="Add a category"
        android_ripple={{ color: p.accentSoft, radius: 34 }}
        style={({ pressed }) => ({
          position: 'absolute',
          right: space.xl,
          bottom: insets.bottom + space.xl,
          width: 60, height: 60, borderRadius: 30,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: p.accent,
          transform: [{ scale: pressed ? 0.94 : 1 }],
          elevation: 8,
          shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
        })}
      >
        <Text variant="display" style={{ color: p.accentInk, fontSize: 32, lineHeight: 36 }}>+</Text>
      </Pressable>

      <Modal
        visible={creating || editing !== null}
        animationType="slide"
        transparent
        statusBarTranslucent
        // Under the navigation bar as well, not just the status bar.
        //
        // THE STRIP AT THE BOTTOM OF EVERY SHEET. Without this the modal's
        // window stops above the system navigation area, so the sheet ended
        // short and the app behind it -- the tab bar -- showed through in the
        // band below, looking like the sheet had been cropped. Each sheet
        // already pads itself by `insets.bottom`, so covering that area is what
        // makes the padding mean something instead of being doubled by a gap.
        //
        // React Native requires `statusBarTranslucent` alongside it and warns in
        // dev if it is missing, which is why the two always appear together.
        navigationBarTranslucent
        onRequestClose={() => { setEditingId(null); setCreating(false); }}
      >
        {creating || editing ? (
          <Sheet
            // Remounts when the target changes, so the draft state below never
            // carries one category's half-typed name onto another.
            key={editing?.id ?? 'new'}
            existing={editing}
            takenNames={list.filter(c => c.id !== editing?.id).map(c => c.name)}
            onSave={save}
            onDelete={editing ? () => confirmDelete(editing) : undefined}
            onClose={() => { setEditingId(null); setCreating(false); }}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function CategoryRow({ cat, onOpen }: { cat: EventCategory; onOpen: () => void }) {
  const p = useTheme();
  const colour = cat.color || FALLBACK_COLOUR;

  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onOpen}
      android_ripple={{ color: p.accentSoft }}
      accessibilityRole="button"
      accessibilityLabel={`Edit ${cat.name || 'Untitled'}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: p.surface,
        borderWidth: 1,
        borderColor: p.line,
        overflow: 'hidden',
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colour,
      }} />

      <View style={{
        width: 22, height: 22, borderRadius: 11, backgroundColor: colour,
        marginLeft: space.xs,
      }} />

      <View style={{ flex: 1 }}>
        <Row gap={space.sm} style={{ alignItems: 'center' }}>
          <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {cat.name || 'Untitled'}
          </Text>
          {cat.isDefault ? (
            <Text variant="caption" tone="accent" style={{ fontSize: 12 }}>default</Text>
          ) : null}
        </Row>
        <Text variant="caption" tone="faint" numberOfLines={1} style={{ marginTop: 3, fontSize: 12 }}>
          {summarise(cat)}
        </Text>
      </View>

      <Text variant="body" tone="faint">›</Text>
    </Pressable>
  );
}

/**
 * One line describing what a new item in this category starts out as.
 *
 * Written as the settings themselves rather than as a count, because "All day,
 * no checkbox" answers the question the row is actually being scanned for.
 */
function summarise(cat: EventCategory): string {
  const bits: string[] = [];
  if (cat.defaultAllDay) bits.push('All day');
  else if (cat.defaultNoDuration) bits.push('No duration');
  else bits.push(formatDuration(cat.defaultDurationMin ?? 30));
  if (cat.defaultNoCheckbox) bits.push('no checkbox');
  const line = bits.join(', ');
  const note = (cat.description ?? '').trim();
  return note ? `${line} · ${note}` : line;
}

function formatDuration(min: number): string {
  if (min <= 0) return 'No duration';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * A new category's id.
 *
 * Shaped like the v4 uuids both halves of the planner generate, from
 * Math.random rather than crypto.randomUUID, which is not present on every
 * Android runtime this ships to.
 */
function newId(): string {
  const hex = (n: number) => Array.from(
    { length: n }, () => Math.floor(Math.random() * 16).toString(16),
  ).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function Sheet({ existing, takenNames, onSave, onDelete, onClose }: {
  existing: EventCategory | null;
  takenNames: string[];
  onSave: (cat: EventCategory) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();

  const [draft, setDraft] = useState<EventCategory>(() => existing ?? {
    id: newId(),
    name: '',
    color: FALLBACK_COLOUR,
    defaultDurationMin: 30,
    defaultNoDuration: false,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    isDefault: false,
    description: '',
  });
  const [touched, setTouched] = useState(false);

  const set = (patch: Partial<EventCategory>) => setDraft(d => ({ ...d, ...patch }));

  const name = draft.name.trim();
  const clash = takenNames.some(n => (n ?? '').trim().toLowerCase() === name.toLowerCase());
  // Two categories with the same name are indistinguishable in every picker on
  // both devices, so the clash is refused rather than merely warned about.
  const problem = name === ''
    ? 'Give it a name'
    : clash ? 'Another category already has this name' : null;

  const save = () => {
    setTouched(true);
    if (problem) return;
    onSave({
      ...draft,
      name,
      description: (draft.description ?? '').trim(),
      // A duration of zero is what "no duration" means to the PC, so the two
      // fields are made to agree here instead of leaving the reader to guess.
      defaultDurationMin: draft.defaultNoDuration ? 0 : (draft.defaultDurationMin || 30),
    });
  };

  // An all-day category has no length to set, so asking for one would be a
  // control whose value is never read.
  const showDuration = !draft.defaultAllDay && !draft.defaultNoDuration;

  return (
    <View style={{ flex: 1, backgroundColor: p.scrim }}>
      {/* Tapping anywhere off the sheet closes it. No pressed state: it is an
          invisible dismiss layer, and dimming the whole screen on touch would
          be a flash that means nothing. */}
      <Pressable
        unstable_pressDelay={PRESS_DELAY} style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />

      {/*
        THE SHEET IS NAILED TO THE BOTTOM, not merely the last thing in a column.

        It used to be `justifyContent: 'flex-end'` with a flexible spacer above
        it, and it did not sit flush: a band of scrim was left underneath, wide
        enough to read the tab bar through, which looked exactly like the sheet
        had been cropped.

        The cause was `maxHeight: '92%'`. A percentage resolves against the
        PARENT's height, and the parent here had no height of its own -- it was
        sized by this very view. Against an indefinite parent the percentage is
        undefined, so the cap did nothing and the column's arithmetic came out
        wrong.

        Positioning it absolutely settles both halves at once: `bottom: 0` is
        not an opinion about leftover space, and the cap now resolves against
        the modal's own full-screen root, which is definite.
      */}
      <View style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '92%',
        backgroundColor: p.surface,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderTopWidth: 1,
        borderColor: p.line,
      }}>
        <View style={{ alignItems: 'center', paddingTop: space.sm }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.line }} />
        </View>

        {/* Shrinkable: a ScrollView has no height of its own, so inside a
            capped sheet it would claim the whole form's height and overflow
            the cap rather than scrolling within it. See `Editor.tsx`. */}
        <ScrollView
          style={{ flexShrink: 1 }}
          contentContainerStyle={{
            padding: space.lg,
            paddingBottom: clearNav(insets.bottom) + space.xl,
            gap: space.lg,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="display">{existing ? 'Edit' : 'New'}</Text>
            <View style={{
              width: 18, height: 18, borderRadius: 9, backgroundColor: draft.color,
            }} />
          </Row>

          <Field label="Name">
            <TextField
              value={draft.name}
              onChange={t => set({ name: t })}
              placeholder="University"
              autoFocus={!existing}
              invalid={touched && Boolean(problem)}
            />
            {touched && problem ? (
              <Text variant="caption" tone="danger">{problem}</Text>
            ) : null}
          </Field>

          <Field label="Colour" hint="Shown on every item in it">
            <ColourPicker
              value={draft.color}
              swatches={SWATCHES}
              // Tapping the chosen swatch again clears the value in the shared
              // picker. A category with no colour has nothing to draw, so that
              // press keeps the current one instead.
              onChange={next => set({ color: next ?? draft.color })}
            />
          </Field>

          <Field label="Notes" hint="Optional">
            <TextField
              value={draft.description ?? ''}
              onChange={t => set({ description: t })}
              placeholder="Lectures, labs and deadlines"
              multiline
            />
          </Field>

          <Field label="New items start as">
            <Toggle
              label="All day"
              hint="No particular time"
              value={Boolean(draft.defaultAllDay)}
              onChange={v => set({ defaultAllDay: v })}
            />
            <Toggle
              label="No duration"
              hint="A moment or a deadline, with no length"
              value={Boolean(draft.defaultNoDuration)}
              onChange={v => set({
                defaultNoDuration: v,
                defaultDurationMin: v ? 0 : (draft.defaultDurationMin || 30),
              })}
            />
            <Toggle
              label="Hide the checkbox"
              hint="For things that happen rather than get done"
              value={Boolean(draft.defaultNoCheckbox)}
              onChange={v => set({ defaultNoCheckbox: v })}
            />

            {showDuration ? (
              <Row style={{ alignItems: 'center', gap: space.md, marginTop: space.sm }}>
                <Text variant="body" tone="soft" style={{ flex: 1 }}>Lasts</Text>
                <Stepper
                  value={draft.defaultDurationMin || 30}
                  min={DURATION_STEP}
                  max={480}
                  step={DURATION_STEP}
                  onChange={n => set({ defaultDurationMin: n })}
                  format={formatDuration}
                />
              </Row>
            ) : null}
          </Field>

          <Field label="Default">
            <Toggle
              label="Pick this for new items"
              hint="Only one category can hold this"
              value={Boolean(draft.isDefault)}
              onChange={v => set({ isDefault: v })}
            />
          </Field>

          <Row gap={space.sm}>
            <Button label="Cancel" variant="quiet" onPress={onClose} />
            <Button label="Save" onPress={save} style={{ flex: 1 }} />
          </Row>

          {onDelete ? (
            <Button label="Delete category" variant="danger" onPress={onDelete} />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
