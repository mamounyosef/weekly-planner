// ─── Tasks ───────────────────────────────────────────────────────────────────
// The pages of the task board, and how a repeating task behaves when it is
// missed. Categories are next door and are a DIFFERENT thing: a category
// colours a calendar item, a list decides which page of the board a task sits
// on. Renaming one has never had anything to do with the other, which is why
// they are two screens rather than one with two halves.
//
// LISTS ARE A SHARED SETTING. They live in the same synced settings record the
// PC writes, so adding one here adds it on the desk. The whole array goes back
// as one value on every change because the merge layer works per FIELD and
// `taskLists` is a single field; building the write up in pieces would just
// give two devices more chances to collide on it.
//
// NOTHING IS EDITED IN PLACE. The array in the context is the same object the
// merge layer holds. Mutating it would change the value the next diff is
// compared against, and the edit would be dropped as "no change".
//
// DELETING A LIST CANNOT LOSE A TASK. This screen has no access to the task
// store, so tasks filed on a deleted list keep pointing at an id that is gone.
// `resolveListId` sends those back to General on every read, which is what
// makes deleting safe from here.

import React, { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Row, Spacer, Text, useTheme } from '../ui/kit';
import { ColourPicker, Field, TextField, Toggle } from '../ui/Fields';
import { HIT, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import {
  GENERAL_LIST_ID,
  TASK_LIST_COLORS,
  coerceTaskLists,
  makeListId,
  moveList,
  nextListColor,
  type TaskList,
} from '../lib/taskLists';
import {
  coerceDisplaySettings,
  displayPatch,
  type DisplaySettings,
} from '../lib/displaySettings';

const SWATCHES = TASK_LIST_COLORS.map(hex => ({ key: hex, hex }));

export function TaskSettings({ onClose }: { onClose?: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { taskLists, shared, edit } = usePlanner();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Read straight from the store rather than from a copy held here, so the desk
  // landing a change does not leave this screen disagreeing with the planner it
  // is configuring.
  const lists = useMemo<TaskList[]>(() => coerceTaskLists(taskLists), [taskLists]);
  const display: DisplaySettings = useMemo(
    () => coerceDisplaySettings(shared as unknown),
    [shared],
  );

  const editing = editingId === null ? null : lists.find(l => l.id === editingId) ?? null;

  const writeLists = (next: TaskList[]) => {
    void edit('settings', SETTINGS_ENTITY, { taskLists: next });
  };

  const setDisplay = (patch: Partial<DisplaySettings>) => {
    const changed = displayPatch(shared as unknown, patch);
    if (Object.keys(changed).length === 0) return;
    void edit('settings', SETTINGS_ENTITY, changed);
  };

  const save = (draft: TaskList) => {
    const exists = lists.some(l => l.id === draft.id);
    writeLists(exists ? lists.map(l => (l.id === draft.id ? draft : l)) : [...lists, draft]);
    setEditingId(null);
    setCreating(false);
  };

  const confirmDelete = (target: TaskList) => {
    Alert.alert(
      `Delete "${target.name}"?`,
      'The tasks on it are not deleted. They move to General, here and on your PC.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            writeLists(lists.filter(l => l.id !== target.id));
            setEditingId(null);
            setCreating(false);
          },
        },
      ],
    );
  };

  const addList = () => { setEditingId(null); setCreating(true); };

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
          {`${lists.length} ${lists.length === 1 ? 'LIST' : 'LISTS'}`}
        </Text>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="display">Tasks</Text>
          {onClose ? (
            <Pressable
              onPress={onClose}
              accessibilityLabel="Back to settings"
              hitSlop={space.md}
              style={{ paddingHorizontal: space.sm }}
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
          gap: space.lg,
        }}
      >
        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">LISTS</Text>
          <Text variant="caption" tone="faint">
            Separate boards inside the Tasks tab. Not the same thing as categories: a category
            colours a calendar item, a list decides which board a task sits on.
          </Text>
          <Spacer size={space.xs} />
          {lists.map((l, i) => (
            <ListRow
              key={l.id}
              list={l}
              canMoveUp={i > 0}
              canMoveDown={i < lists.length - 1}
              onMove={dir => writeLists(moveList(lists, l.id, dir))}
              onOpen={() => { setCreating(false); setEditingId(l.id); }}
            />
          ))}
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">WHEN ONE IS MISSED</Text>
          <Card style={{ gap: space.lg }}>
            <Toggle
              label="Roll repeating tasks forward"
              hint="An overdue repeating task moves itself to today rather than sitting in the past."
              value={display.autoRollRecurringTasks}
              onChange={v => setDisplay({ autoRollRecurringTasks: v })}
            />
          </Card>
        </View>

        <Text variant="caption" tone="faint">
          Lists and this setting are shared with your PC. How tasks are coloured on the grid is
          under Appearance.
        </Text>
      </ScrollView>

      <Pressable
        onPress={addList}
        accessibilityRole="button"
        accessibilityLabel="Add a list"
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
        onRequestClose={() => { setEditingId(null); setCreating(false); }}
      >
        {creating || editing ? (
          <Sheet
            // Remounts when the target changes, so a half-typed name is never
            // carried from one list onto another.
            key={editing?.id ?? 'new'}
            existing={editing}
            takenNames={lists.filter(l => l.id !== editing?.id).map(l => l.name)}
            suggestedColour={nextListColor(lists)}
            onSave={save}
            // General is structural: every task that has not been filed lives
            // there, so it can be renamed and recoloured but never removed.
            onDelete={editing && editing.id !== GENERAL_LIST_ID
              ? () => confirmDelete(editing)
              : undefined}
            onClose={() => { setEditingId(null); setCreating(false); }}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function ListRow({ list, canMoveUp, canMoveDown, onMove, onOpen }: {
  list: TaskList;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  onOpen: () => void;
}) {
  const p = useTheme();

  return (
    <Pressable
      onPress={onOpen}
      android_ripple={{ color: p.accentSoft }}
      accessibilityRole="button"
      accessibilityLabel={`Edit ${list.name}`}
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
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: list.color,
      }} />

      <View style={{
        width: 22, height: 22, borderRadius: 11, backgroundColor: list.color,
        marginLeft: space.xs,
      }} />

      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" numberOfLines={1}>{list.name}</Text>
        {list.id === GENERAL_LIST_ID ? (
          <Text variant="caption" tone="faint" style={{ marginTop: 3, fontSize: 12 }}>
            Holds every task you have not filed anywhere else
          </Text>
        ) : null}
      </View>

      {/* Arrows rather than a drag handle: a long press inside a scrolling list
          is the one gesture that reliably fights the scroll. */}
      <Arrow label={`Move ${list.name} up`} glyph="▲" enabled={canMoveUp} onPress={() => onMove(-1)} />
      <Arrow label={`Move ${list.name} down`} glyph="▼" enabled={canMoveDown} onPress={() => onMove(1)} />
    </Pressable>
  );
}

function Arrow({ label, glyph, enabled, onPress }: {
  label: string; glyph: string; enabled: boolean; onPress: () => void;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={enabled ? onPress : undefined}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      hitSlop={4}
      style={{
        width: HIT - 8, height: HIT - 8,
        alignItems: 'center', justifyContent: 'center',
        borderRadius: radius.sm,
        opacity: enabled ? 1 : 0.25,
      }}
    >
      <Text variant="caption" tone="soft" style={{ color: p.inkSoft }}>{glyph}</Text>
    </Pressable>
  );
}

function Sheet({ existing, takenNames, suggestedColour, onSave, onDelete, onClose }: {
  existing: TaskList | null;
  takenNames: string[];
  suggestedColour: string;
  onSave: (list: TaskList) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();

  const [draft, setDraft] = useState<TaskList>(() => existing ?? {
    id: '',
    name: '',
    color: suggestedColour,
  });
  const [touched, setTouched] = useState(false);

  const set = (patch: Partial<TaskList>) => setDraft(d => ({ ...d, ...patch }));

  const name = draft.name.trim();
  const clash = takenNames.some(n => n.trim().toLowerCase() === name.toLowerCase());
  // Two boards with the same name are indistinguishable on every tab strip and
  // in every picker on both machines, so the clash is refused, not warned about.
  const problem = name === ''
    ? 'Give it a name'
    : clash ? 'Another list already has this name' : null;

  const save = () => {
    setTouched(true);
    if (problem) return;
    // The id is minted from the FIRST accepted name and never again: it is what
    // every task filed here points at, so renaming must not re-file anything.
    onSave({ ...draft, id: draft.id || makeListId(name), name });
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.scrim, justifyContent: 'flex-end' }}>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />

      <View style={{
        backgroundColor: p.surface,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
        borderTopWidth: 1,
        borderColor: p.line,
        maxHeight: '92%',
      }}>
        <View style={{ alignItems: 'center', paddingTop: space.sm }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.line }} />
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: space.lg,
            paddingBottom: insets.bottom + space.xl,
            gap: space.lg,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="display">{existing ? 'Edit list' : 'New list'}</Text>
            <View style={{
              width: 18, height: 18, borderRadius: 9, backgroundColor: draft.color,
            }} />
          </Row>

          <Field label="Name">
            <TextField
              value={draft.name}
              onChange={t => set({ name: t })}
              placeholder="Errands"
              autoFocus={!existing}
              invalid={touched && Boolean(problem)}
            />
            {touched && problem ? (
              <Text variant="caption" tone="danger">{problem}</Text>
            ) : null}
          </Field>

          <Field label="Colour" hint="Used on the tab and on this list's tasks">
            <ColourPicker
              value={draft.color}
              swatches={SWATCHES}
              // Tapping the chosen swatch again clears the value in the shared
              // picker. A list with no colour has nothing to draw its tab with,
              // so that press keeps the current one.
              onChange={next => set({ color: next ?? draft.color })}
            />
          </Field>

          <Row gap={space.sm}>
            <Button label="Cancel" variant="quiet" onPress={onClose} />
            <Button label="Save" onPress={save} style={{ flex: 1 }} />
          </Row>

          {onDelete ? (
            <Button label="Delete list" variant="danger" onPress={onDelete} />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
