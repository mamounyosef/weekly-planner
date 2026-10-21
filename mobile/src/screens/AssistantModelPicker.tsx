// The model chooser on the phone: the model's name in the composer, and a
// bottom sheet with every model's details (size, experts, context window,
// release date, architecture, price). The same catalogue as the PC and the
// Notes app's assistant, Ollama only. The pick belongs to this phone.

import React, { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { radius, space } from '../theme';
import type { Palette } from '../theme';
import {
  MODELS, VISION_MODEL, fmtCtx, fmtDate, fmtMoney, fmtTokens, modelInfo, paramsLabel, priceLabel,
} from '../lib/agent/agentModels';
import type { AgentUsage } from '../lib/agent/agentTypes';
import type { PhoneModelSpeed, PhoneModelSpeeds } from '../lib/voice/phoneVoiceEnv';

const VISION = '#56b6c2';
const FREE_GREEN = '#98c379';

function Icon({ name, size = 16, color }: { name: string; size?: number; color: string }) {
  const src = ICONS[name];
  if (!src) return null;
  return <Image source={{ uri: src }} style={{ width: size, height: size, tintColor: color }} />;
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** Voice mode's extra: how fast each model starts talking, measured on the PC. */
export interface PillSpeed {
  speeds: PhoneModelSpeeds;
  mode: 'quick' | 'thinking';
  testing: boolean;
  error?: string | null;
  onTest: () => void;
}

function SpeedBadge({ p, s, testing }: { p: Palette; s?: PhoneModelSpeed; testing: boolean }) {
  if (!s) return testing ? <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>timing...</Text> : null;
  if (s.error || s.firstWordMs == null) return <Text variant="caption" tone="warn" style={{ fontSize: 11 }}>no answer</Text>;
  const ms = s.firstWordMs;
  const color = ms < 2500 ? '#98c379' : ms < 5000 ? '#e5c07b' : '#e06c75';
  return (
    <View style={{ backgroundColor: `${color}26`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text variant="caption" style={{ fontSize: 11, color, fontWeight: '700' }}>{fmtSec(ms)}</Text>
    </View>
  );
}

export function ModelPill({ p, model, usage, chatCost, onPick, speed, label }: {
  p: Palette;
  model: string;
  usage?: AgentUsage | null;
  chatCost?: number | null;
  onPick: (id: string) => void;
  speed?: PillSpeed;
  /** Shown before the model name, e.g. "Voice". */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const cur = modelInfo(model);
  const ctxModel = usage ? modelInfo(usage.model) : cur;
  const ctxPct = usage && usage.contextTokens > 0 ? Math.min(100, (usage.contextTokens / ctxModel.context) * 100) : 0;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityLabel={`Model: ${cur.name}. Change model`}
        hitSlop={6}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 3, height: 32, paddingHorizontal: 10, borderRadius: 16,
          backgroundColor: pressed ? p.surfaceAlt : 'transparent', maxWidth: 150,
        })}
      >
        <Text variant="caption" tone="soft" numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>{label ? `${label}: ` : ''}{cur.name}</Text>
        {speed?.speeds[speed.mode]?.[cur.id]?.firstWordMs != null ? (
          <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{fmtSec(speed.speeds[speed.mode]![cur.id].firstWordMs!)}</Text>
        ) : null}
        <Icon name="chevron-down" size={12} color={p.inkFaint} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={{ flex: 1, backgroundColor: p.scrim }} onPress={() => setOpen(false)} />
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '86%',
          backgroundColor: p.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
          borderTopWidth: 1, borderColor: p.line, paddingBottom: insets.bottom + space.sm,
        }}>
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: p.line }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs }}>
            <Text variant="label" tone="faint">MODEL</Text>
            <Text variant="caption" tone="faint">strongest first</Text>
            {speed ? (
              <Pressable onPress={speed.onTest} disabled={speed.testing} style={{ marginLeft: 'auto', backgroundColor: p.accentSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, opacity: speed.testing ? 0.6 : 1 }}>
                <Text variant="caption" tone="accent" style={{ fontWeight: '700' }}>{speed.testing ? 'Testing...' : speed.speeds.testedAt ? 'Test again' : 'Test speed'}</Text>
              </Pressable>
            ) : null}
          </View>
          {speed ? (
            <Text variant="caption" tone={speed.error ? 'danger' : 'faint'} style={{ fontSize: 11, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
              {speed.error
                ?? (speed.speeds.testedAt
                  ? `Seconds until each model starts talking (${speed.mode === 'thinking' ? 'thinking first' : 'without thinking first'}), measured on the PC.`
                  : speed.testing ? 'Timing every model on the PC, with and without thinking. A few minutes.' : 'Not measured yet.')}
            </Text>
          ) : null}

          {usage && usage.contextTokens > 0 ? (
            <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>This chat: {fmtTokens(usage.contextTokens)} of {fmtCtx(ctxModel.context)} context</Text>
                {chatCost !== undefined ? (
                  <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{chatCost === null ? 'cost not listed' : `${fmtMoney(chatCost)} so far`}</Text>
                ) : null}
              </View>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: p.surfaceAlt, marginTop: 5, overflow: 'hidden' }}>
                <View style={{ height: 4, borderRadius: 2, width: `${Math.max(1.5, ctxPct)}%`, backgroundColor: ctxPct > 80 ? p.warn : '#7c9cff' }} />
              </View>
            </View>
          ) : null}

          <ScrollView contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.sm }}>
            {MODELS.map(m => {
              const sel = m.id === model;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => { onPick(m.id); setOpen(false); }}
                  style={({ pressed }) => ({
                    borderRadius: radius.md, padding: space.md, gap: 3,
                    backgroundColor: sel ? p.accentSoft : pressed ? p.surfaceAlt : 'transparent',
                  })}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text variant="bodyStrong">{m.name}</Text>
                    <View style={{ backgroundColor: p.surfaceAlt, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text variant="caption" tone="soft" style={{ fontSize: 10 }}>Ollama</Text>
                    </View>
                    {m.vision ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(86,182,194,0.16)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                        <Icon name="image" size={11} color={VISION} />
                        <Text variant="caption" style={{ fontSize: 10.5, color: VISION }}>vision</Text>
                      </View>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    {speed ? <SpeedBadge p={p} s={speed.speeds[speed.mode]?.[m.id]} testing={speed.testing} /> : null}
                    {sel ? <Icon name="check" size={15} color={p.accent} /> : null}
                  </View>
                  <Text variant="caption" tone="soft">{paramsLabel(m)}   {fmtCtx(m.context)} context   {fmtDate(m.released)}</Text>
                  {m.arch.length ? <Text variant="caption" tone="faint" style={{ fontSize: 11.5, lineHeight: 16 }}>{m.arch.join(' · ')}</Text> : null}
                  <Text variant="caption" tone="faint" style={{ fontSize: 11.5 }}>
                    <Text variant="caption" tone="soft" style={{ fontSize: 11.5, fontStyle: m.price ? 'normal' : 'italic' }}>{priceLabel(m)}</Text>
                    {m.note ? `   ${m.note}` : ''}
                    {!m.vision ? `   Images read by ${modelInfo(VISION_MODEL).name}.` : ''}
                  </Text>
                </Pressable>
              );
            })}
            <View style={{ paddingHorizontal: space.md, paddingTop: space.sm, marginTop: space.xs, borderTopWidth: 1, borderTopColor: p.line }}>
              <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
                Prices from ollama.com/pricing; your plan's monthly credits are used first.{' '}
                <Text variant="caption" style={{ fontSize: 11, color: FREE_GREEN }}>All of these run on your free usage credits.</Text>{' '}
                Your pick is remembered on this phone only.
              </Text>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
