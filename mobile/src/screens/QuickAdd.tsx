// ─── Quick Add Screen ────────────────────────────────────────────────────────
// Lets the user type a full item in natural language and parses it instantly.
//
// WHY A SEPARATE SCREEN?
// The main Editor form is great for precise adjustments, but terrible when you
// are walking and just want to remember to call someone tomorrow. A single text
// box is as fast as it gets.
//
// NO DASHES
// UI text here strictly avoids em dashes and en dashes as requested.

import React, { useState, useMemo } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Row, Text, useTheme, Spacer } from '../ui/kit';
import { HIT, PRESSED, radius, space, type as typeScale } from '../theme';
import { usePlanner } from '../state/planner';
import { parseQuickAdd } from '../lib/quickAdd';
import { describeRecur, inferWeekStartsOn } from '../lib/draft';
import { GENERAL_LIST_ID } from '../lib/taskLists';

export function QuickAdd({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      visible
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Sheet onClose={onClose} />
    </Modal>
  );
}

function Sheet({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { categories, taskLists, saveDraft, events, tasks, edit } = usePlanner();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  // The parser needs to know what lists and categories exist so it can match !tags.
  const options = useMemo(() => {
    return {
      now: new Date(),
      categories: categories as { id: string; name: string }[],
      lists: (taskLists as any[])
        .filter(l => l && typeof l.id === 'string')
        .map(l => ({ id: l.id, name: String(l.name ?? '') })),
      weekStartsOn: inferWeekStartsOn(events(), tasks()),
    };
  }, [categories, taskLists, events, tasks]);

  const parsed = useMemo(() => parseQuickAdd(text, options), [text, options]);

  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const id = await saveDraft(parsed.store, parsed.draft);
      if (parsed.store === 'tasks' && parsed.listId) {
        // The DraftInput does not carry listId since lists are mobile-only concepts.
        // General is the ABSENCE of a list, so choosing it CLEARS the field
        await edit('tasks', id, { 
          listId: parsed.listId === GENERAL_LIST_ID ? undefined : parsed.listId 
        });
      }
      onClose();
    } catch (err) {
      console.error(err);
      setBusy(false);
    }
  };

  // The parsed result tells us exactly which substrings it understood.
  const renderHighlightedText = () => {
    if (!text) {
      return (
        <Text variant="body" tone="faint">
          e.g. gym tomorrow 6pm, buy milk, call dad friday 7:30
        </Text>
      );
    }

    const elements = [];
    let lastIndex = 0;

    for (const token of parsed.matchedTokens) {
      if (token.start > lastIndex) {
        elements.push(
          <Text key={`text-${lastIndex}`} variant="body">
            {text.slice(lastIndex, token.start)}
          </Text>
        );
      }
      elements.push(
        <Text key={`match-${token.start}`} variant="bodyStrong" tone="accent">
          {text.slice(token.start, token.end)}
        </Text>
      );
      lastIndex = token.end;
    }

    if (lastIndex < text.length) {
      elements.push(
        <Text key={`text-${lastIndex}`} variant="body">
          {text.slice(lastIndex)}
        </Text>
      );
    }

    return (
      <View style={{ backgroundColor: p.surfaceAlt, padding: space.lg, borderRadius: radius.md }}>
        <Text variant="caption" tone="soft" style={{ marginBottom: space.sm }}>
          UNDERSTOOD
        </Text>
        <Text>{elements}</Text>
      </View>
    );
  };

  const renderPreviewDetails = () => {
    if (!text.trim()) return null;

    const d = parsed.draft;
    const isTask = parsed.store === 'tasks';
    const typeStr = isTask ? 'Task' : 'Event';
    
    // A clean, readable sentence describing exactly what will happen.
    const dObj = new Date(d.date);
    const dateStr = dObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    
    const parts = [];
    if (d.title) {
      parts.push(`"${d.title}"`);
    } else {
      parts.push(`Untitled ${isTask ? 'task' : 'event'}`);
    }
    
    parts.push(`on ${dateStr}`);
    
    if (d.allDay) {
      parts.push('all day');
    } else if (d.startMin !== null) {
      const formatTime = (m: number) => {
        const h24 = Math.floor(m / 60) % 24;
        const mins = m % 60;
        const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
        const suffix = h24 < 12 ? 'am' : 'pm';
        return mins === 0 ? `${h12}${suffix}` : `${h12}:${mins.toString().padStart(2, '0')}${suffix}`;
      };
      
      parts.push(`at ${formatTime(d.startMin)}`);
      
      if (d.endMin !== null) {
        parts.push(`until ${formatTime(d.endMin)}`);
      }
    }
    
    if (d.recur) {
      const recurStr = describeRecur(d.recur).toLowerCase();
      parts.push(`(${recurStr})`);
    }
    
    if (parsed.listId) {
      const listName = options.lists.find(l => l.id === parsed.listId)?.name;
      if (listName) parts.push(`in list "${listName}"`);
    } else if (d.categoryId) {
      const catName = options.categories.find(c => c.id === d.categoryId)?.name;
      if (catName) parts.push(`in category "${catName}"`);
    }
    
    return (
      <View style={{ paddingHorizontal: space.xs }}>
        <Text variant="caption" tone="soft" style={{ marginBottom: space.xs }}>
          WILL CREATE
        </Text>
        <Text variant="bodyStrong" style={{ lineHeight: 22, color: p.ink }}>
          {typeStr}: {parts.join(' ')}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.scrim, justifyContent: 'flex-end' }}>
      <Pressable style={({ pressed }) => [{ flex: 1 }, pressed ? PRESSED : null]} onPress={onClose} accessibilityLabel="Close" />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
              <Text variant="display">Quick Add</Text>
            </Row>

            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="What do you want to add?"
              placeholderTextColor={p.inkFaint}
              autoFocus
              multiline
              style={{
                backgroundColor: p.surfaceAlt,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: p.line,
                color: p.ink,
                paddingHorizontal: space.md,
                paddingTop: space.md,
                minHeight: 88,
                textAlignVertical: 'top',
                ...typeScale.body,
              }}
            />

            {renderHighlightedText()}
            {renderPreviewDetails()}

            <Spacer size={space.xs} />

            <Row gap={space.sm}>
              <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
              <Button
                label="Add"
                onPress={() => void save()}
                busy={busy}
                disabled={!text.trim() || busy}
                style={{ flex: 2 }}
              />
            </Row>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
