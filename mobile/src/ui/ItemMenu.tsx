// ─── The long-press menu ─────────────────────────────────────────────────────
// Everything you can do to one item, without opening it.
//
// WHY A SHEET AND NOT A POPOVER. The PC anchors its menu to the item because a
// mouse is precise and a 1440p screen has room beside anything. A thumb has
// neither. So this is a bottom sheet in the reachable third of the screen, and
// the item it acts on is reprinted at the top: a long-press has no cursor, the
// finger is covering the row it started on, and "which one did I just hold?" is
// the question that makes a destructive menu frightening to use.
//
// WHY THE SCOPE QUESTION IS A SECOND PAGE. A repeating item cannot be edited or
// deleted until you say whether you mean one day or all of them, and that answer
// is worth a whole screen. Folding the three choices in as sub-rows of a menu is
// how you end up tapping "Delete" and losing a year of Tuesdays, because the row
// you meant was two pixels below. The second page also lets each choice carry a
// sentence saying what happens to the OTHER days, which is the part people are
// actually anxious about. The wording lives in `occurrence.ts` next to the code
// that carries it out, so a promise and its implementation cannot drift apart.
//
// NO NATIVE MODULES, and that is a delivery decision rather than a stylistic
// one: a native module means this app can only reach the phone as a whole new
// APK, never over the air. So the sheet is `Modal` + `Pressable` + `Animated`,
// the pickers are the app's own (`ColourPicker`, `CategoryPicker`, the same ones
// the editor uses so a colour means the same thing in both places), and the
// glyphs are text.
//
// This component knows nothing about the planner. It takes an item description
// and calls back; it never reads a store, never writes one, and never imports a
// screen. That is what lets the Today list, the week view and the task list all
// long-press into the same menu.

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from './kit';
import { CategoryPicker, ColourPicker, type Swatch } from './Fields';
import { HIT, PRESSED, radius, space } from '../theme';
import { scopeChoices, type OccurrenceScope } from '../lib/occurrence';

/**
 * Everything the menu needs to know about the thing it was opened on.
 *
 * It is a DESCRIPTION, not a record: the caller has already resolved the
 * occurrence, worked out its colour and written its subtitle. Passing the raw
 * record instead would drag the recurrence model, the category list and the time
 * formatter into a component whose only job is to ask a question.
 */
export interface ItemMenuTarget {
  /** The occurrence id the caller acts on. Handed straight back to callbacks. */
  id: string;
  title: string;
  /** One quiet line under the title: the time, the day, the list. */
  subtitle?: string;
  /** True for a repeating item, which is what turns on the scope question. */
  repeats?: boolean;
  /** "Every 2 weeks on Mon, Wed", from `describeRecur`. Shown as a chip. */
  repeatLabel?: string;
  /**
   * A locked series keeps every occurrence identical, so there is no scope left
   * to choose. The menu says so rather than silently doing something else.
   */
  locked?: boolean;
  done?: boolean;
  /** Swatch key or hex, whichever the record holds. */
  colour?: string;
  categoryId?: string;
  /** Resolved colour for the stripe and the dot. */
  accent?: string;
  /** Changes two labels: a task is "done", an event "happened". */
  kind?: 'event' | 'task';
}

export interface ItemMenuProps {
  /** The open item, or null when the menu is closed. */
  target: ItemMenuTarget | null;
  onClose: () => void;

  /** Open the full editor. `scope` is what the user chose for a repeating item. */
  onEdit: (id: string, scope: OccurrenceScope) => void;
  onDelete: (id: string, scope: OccurrenceScope) => void;

  /** Scope-free actions. Each one closes the menu. */
  onToggleDone: (id: string, next: boolean) => void;
  onDuplicate: (id: string) => void;
  onColour: (id: string, colour: string | undefined) => void;
  onCategory: (id: string, categoryId: string | undefined) => void;

  categories: { id: string; name: string; color: string }[];
  swatches: Swatch[];
  /** Optional extra rows, for whatever the calling screen alone can offer. */
  extra?: { key: string; glyph: string; label: string; hint?: string; onPress: (id: string) => void }[];
}

type Step =
  | { page: 'actions' }
  | { page: 'scope'; action: 'edit' | 'delete' };

export function ItemMenu(props: ItemMenuProps) {
  // The step lives out here for one reason: Android's back gesture arrives at
  // the Modal, not at the sheet, and on the scope page back has to mean "back to
  // the menu" rather than "forget the whole thing". Answering it from inside the
  // sheet would need the parent to already know which page is showing.
  const [step, setStep] = useState<Step>({ page: 'actions' });

  // The sheet unmounts between openings on purpose, so its expanded sections and
  // its scope page reset. A menu that reopens still showing the colour row from
  // last time reads as a bug the first three times you see it.
  const key = props.target?.id ?? 'none';

  return (
    <Modal
      visible={props.target !== null}
      animationType="none"
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
      onRequestClose={() => {
        if (step.page === 'scope') setStep({ page: 'actions' });
        else props.onClose();
      }}
    >
      {props.target ? (
        <Sheet
          {...props}
          key={key}
          target={props.target}
          step={step}
          setStep={setStep}
          onClose={() => { setStep({ page: 'actions' }); props.onClose(); }}
        />
      ) : null}
    </Modal>
  );
}

function Sheet({
  target, onClose, onEdit, onDelete, onToggleDone, onDuplicate, onColour, onCategory,
  categories, swatches, extra, step, setStep,
}: ItemMenuProps & {
  target: ItemMenuTarget;
  step: Step;
  setStep: (next: Step) => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<'none' | 'colour' | 'category'>('none');

  // One driver for both the scrim and the sheet, so they can never disagree
  // about how far through the animation they are. `useNativeDriver` keeps it off
  // the JS thread, which matters here more than anywhere: the menu opens while
  // the finger is still down and the list underneath may still be settling.
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [t]);

  const slide = t.interpolate({ inputRange: [0, 1], outputRange: [340, 0] });

  const isTask = target.kind === 'task';
  const repeats = Boolean(target.repeats);

  /** Run an action and get out of the way. Nothing here is worth staying open for. */
  const fire = (fn: () => void) => { fn(); onClose(); };

  /**
   * Edit and delete are the only two that can mean different things on a
   * repeating item, so they are the only two that ask. A non-repeating item is
   * always 'all', and asking anyway would be a question with one answer.
   */
  const begin = (action: 'edit' | 'delete') => {
    if (!repeats) {
      fire(() => (action === 'edit' ? onEdit(target.id, 'all') : onDelete(target.id, 'all')));
      return;
    }
    setOpen('none');
    setStep({ page: 'scope', action });
  };

  const choose = (action: 'edit' | 'delete', scope: OccurrenceScope) =>
    fire(() => (action === 'edit' ? onEdit(target.id, scope) : onDelete(target.id, scope)));

  const back = () => setStep({ page: 'actions' });

  return (
    <View style={{ flex: 1 }}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim, opacity: t }]} />
      {/* The whole area above the sheet dismisses it. On a phone the quickest
          way out of a menu you opened by accident is a tap anywhere else. No
          pressed state on it: it is invisible, and dimming the screen on touch
          would be a flash that means nothing. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />

      {/* Pinned rather than flexed to the bottom, for the reason written out in
          full in `Editor.tsx`: the percentage cap below resolves against the
          parent, and a parent sized BY its child has no height to resolve
          against, so the cap did nothing and the sheet sat short of the bottom
          with a band of scrim under it. */}
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          transform: [{ translateY: slide }],
          backgroundColor: p.surface,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          borderTopWidth: 1,
          borderColor: p.line,
          maxHeight: '88%',
          paddingBottom: insets.bottom,
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: space.sm }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: p.line }} />
        </View>

        {/* The item, reprinted. The finger that opened this is covering the row
            it came from, so the menu has to say what it is about. */}
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md }}>
          <Row gap={space.md} align="flex-start">
            <View style={{
              width: 4, alignSelf: 'stretch', minHeight: 34, borderRadius: 2,
              backgroundColor: target.accent || p.accent,
            }} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text
                variant="heading"
                numberOfLines={2}
                style={target.done ? { textDecorationLine: 'line-through', opacity: 0.6 } : undefined}
              >
                {target.title || 'Untitled'}
              </Text>
              {target.subtitle ? (
                <Text variant="caption" tone="soft" numberOfLines={1}>{target.subtitle}</Text>
              ) : null}
              {repeats ? (
                <Row gap={space.xs} style={{ marginTop: 2 }}>
                  <Text variant="caption" tone="faint">↻</Text>
                  <Text variant="caption" tone="faint" numberOfLines={1}>
                    {target.repeatLabel || 'Repeats'}
                    {target.locked ? ' · locked together' : ''}
                  </Text>
                </Row>
              ) : null}
            </View>
          </Row>
        </View>

        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line }} />

        {step.page === 'scope' ? (
          <ScopePage
            action={step.action}
            locked={Boolean(target.locked)}
            onBack={back}
            onChoose={scope => choose(step.action, scope)}
          />
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingVertical: space.sm, paddingBottom: space.lg }}
            keyboardShouldPersistTaps="handled"
          >
            <ActionRow
              glyph="✎"
              label="Open and edit"
              hint={repeats ? 'Asks which days it should change' : undefined}
              onPress={() => begin('edit')}
            />
            <ActionRow
              glyph={target.done ? '↺' : '✓'}
              label={target.done
                ? (isTask ? 'Mark as not done' : 'Mark as not happened')
                : (isTask ? 'Mark as done' : 'Mark as happened')}
              onPress={() => fire(() => onToggleDone(target.id, !target.done))}
            />
            <ActionRow
              glyph="⧉"
              label="Duplicate"
              hint="A separate copy on the same day"
              onPress={() => fire(() => onDuplicate(target.id))}
            />

            {/* Colour and category open in place rather than pushing a page.
                Both are a single tap on a strip of choices, and a whole screen
                for one tap is a screen you have to find your way back out of. */}
            <ActionRow
              glyph="●"
              glyphColour={target.accent}
              label="Change colour"
              expanded={open === 'colour'}
              onPress={() => setOpen(open === 'colour' ? 'none' : 'colour')}
            />
            {open === 'colour' ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
                {target.categoryId ? (
                  <Text variant="caption" tone="faint">
                    The colour comes from this item's category. Set the category to None to pick a colour here.
                  </Text>
                ) : (
                  <ColourPicker
                    value={target.colour}
                    onChange={next => fire(() => onColour(target.id, next))}
                    swatches={swatches}
                  />
                )}
              </View>
            ) : null}

            <ActionRow
              glyph="◆"
              label="Change category"
              expanded={open === 'category'}
              onPress={() => setOpen(open === 'category' ? 'none' : 'category')}
            />
            {open === 'category' ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
                <CategoryPicker
                  value={target.categoryId}
                  onChange={id => fire(() => onCategory(target.id, id))}
                  categories={categories}
                />
              </View>
            ) : null}

            {extra?.map(x => (
              <ActionRow
                key={x.key}
                glyph={x.glyph}
                label={x.label}
                hint={x.hint}
                onPress={() => fire(() => x.onPress(target.id))}
              />
            ))}

            {/* Set apart, in the danger colour, at the bottom. A destructive row
                that looks like every other row is a destructive row you hit by
                muscle memory. */}
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginVertical: space.sm }} />
            <ActionRow
              glyph="🗑"
              label="Delete"
              hint={repeats ? 'Asks which days it should remove' : undefined}
              danger
              onPress={() => begin('delete')}
            />
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

// ─── The scope question ──────────────────────────────────────────────────────
// Three big targets, each with the sentence that says what it does to the days
// you did not pick. "The whole series" is last and, for a delete, is the only
// one drawn in the danger colour, because it is the only one that can lose
// something you cannot get back by tapping again.

function ScopePage({ action, locked, onBack, onChoose }: {
  action: 'edit' | 'delete';
  locked: boolean;
  onBack: () => void;
  onChoose: (scope: OccurrenceScope) => void;
}) {
  const p = useTheme();
  const verb = action === 'edit' ? 'change' : 'remove';

  // A locked series has no scope to choose: it exists precisely so that every
  // occurrence stays identical. Deleting one is still allowed, because locking
  // says the days must match, not that they must all survive.
  const forced = locked && action === 'edit';

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}>
      <Text variant="caption" tone="soft">
        {forced
          ? 'This series is locked, so every day it repeats on stays identical.'
          : `This repeats. Which days should it ${verb}?`}
      </Text>

      {(forced ? scopeChoices(action).filter(c => c.scope === 'all') : scopeChoices(action)).map(choice => {
        const risky = action === 'delete' && choice.scope !== 'one';
        return (
          <Pressable
            key={choice.scope}
            onPress={() => onChoose(choice.scope)}
            android_ripple={{ color: risky ? 'rgba(240,121,138,0.18)' : p.accentSoft }}
            accessibilityRole="button"
            accessibilityLabel={`${choice.label}. ${choice.hint}`}
            style={({ pressed }) => [{
              minHeight: HIT + 12,
              justifyContent: 'center',
              gap: 3,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: risky ? p.danger : p.line,
              backgroundColor: pressed ? p.surfaceAlt : 'transparent',
            }]}
          >
            <Text variant="bodyStrong" tone={risky ? 'danger' : 'ink'}>{choice.label}</Text>
            <Text variant="caption" tone="soft">{choice.hint}</Text>
          </Pressable>
        );
      })}

      <Pressable
        onPress={onBack}
        android_ripple={{ color: p.accentSoft }}
        accessibilityRole="button"
        style={{ minHeight: HIT, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text variant="bodyStrong" tone="soft">Go back</Text>
      </Pressable>
    </ScrollView>
  );
}

// ─── One row ─────────────────────────────────────────────────────────────────
// A fixed-width glyph column so the labels line up. Icons would be a font file
// or a native module; a character costs nothing and cannot fail to load.

function ActionRow({ glyph, glyphColour, label, hint, danger, expanded, onPress }: {
  glyph: string;
  glyphColour?: string;
  label: string;
  hint?: string;
  danger?: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: danger ? 'rgba(240,121,138,0.18)' : p.accentSoft }}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      style={({ pressed }) => [{
        minHeight: HIT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        backgroundColor: pressed ? p.surfaceAlt : 'transparent',
      }]}
    >
      <Text
        variant="body"
        tone={danger ? 'danger' : 'soft'}
        style={{ width: 22, textAlign: 'center', ...(glyphColour ? { color: glyphColour } : null) }}
      >
        {glyph}
      </Text>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" tone={danger ? 'danger' : 'ink'}>{label}</Text>
        {hint ? <Text variant="caption" tone="faint">{hint}</Text> : null}
      </View>
      {expanded !== undefined ? (
        <Text variant="caption" tone="faint">{expanded ? '▴' : '▾'}</Text>
      ) : null}
    </Pressable>
  );
}

export default ItemMenu;
