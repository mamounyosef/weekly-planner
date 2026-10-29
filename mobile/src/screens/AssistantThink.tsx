// How hard the model thinks, on the phone: the chip in the chat box opens a
// sheet with exactly the levels the current model takes on its service, a
// token budget where the service offers one, and a clear "always thinks"
// state for models that cannot switch reasoning off. The model sheet's cards
// show the same levels as pills (one tap picks the model and that level).
// The same control, colours and wording as the PC and the Notes app.

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '../ui/kit';
import { space } from '../theme';
import type { Palette } from '../theme';
import {
  PROVIDER_LABEL, THINK_BUDGETS, THINK_HINT, THINK_LABEL, THINK_SHORT,
  canStopThinking, fmtBudget, modelInfo, thinkDepth,
  type ThinkLevel, type ThinkSetting, type ThinkSpec,
} from '../lib/agent/agentModels';
import { useThinkBook } from '../lib/agent/thinkPrefs';

const VIOLET = '#c678dd';
const AMBER = '#d19a66';

/** a blended toward b by t (0..1), for #rrggbb colours; anything else stays a. */
export function mix(a: string, b: string, t: number): string {
  const hex = (s: string) => (/^#[0-9a-f]{6}$/i.test(s) ? [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) : null);
  const x = hex(a);
  const y = hex(b);
  if (!x || !y) return a;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** How hard it thinks, as a colour: grey when off, the accent at the usual depth, warming to violet at the top. */
export function depthColor(p: Palette, depth: number): string {
  if (depth <= 0) return p.inkFaint;
  if (depth === 1) return mix(p.accent, p.inkSoft, 0.3);
  if (depth === 2) return p.accent;
  if (depth === 3) return mix(p.accent, VIOLET, 0.4);
  return mix(p.accent, VIOLET, 0.75);
}

const warm = (p: Palette) => mix(AMBER, p.ink, 0.25);
const alpha = (c: string, a: number) => (/^#[0-9a-f]{6}$/i.test(c) ? `${c}${Math.round(a * 255).toString(16).padStart(2, '0')}` : c);

/** Four rising bars, lit up to the level's depth. */
export function ThinkBars({ depth, size = 12, color, dim }: { depth: number; size?: number; color: string; dim: string }) {
  const w = size / 5.2;
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', alignItems: 'flex-end', gap: size * 0.07 }}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={{ width: w, height: size * (0.3 + i * 0.2), borderRadius: w / 2.4, backgroundColor: i < depth ? color : dim, opacity: i < depth ? 1 : 0.32 }} />
      ))}
    </View>
  );
}

const alwaysHint = (provider: string) =>
  `Always thinks on ${provider}: the service does not let this model skip reasoning, so the lightest level is the fastest it goes.`;

/** The model card's line: the levels it takes, the service default ringed. With onPick each level is a button. */
export function ThinkTag({ p, spec, current, onPick }: { p: Palette; spec: ThinkSpec; current?: ThinkLevel; onPick?: (l: ThinkLevel) => void }) {
  const always = !canStopThinking(spec);
  const c = always ? warm(p) : p.accent;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginVertical: 2 }}>
      <Text variant="caption" style={{ fontSize: 11, color: always ? c : p.inkFaint, marginRight: 2 }}>{always ? 'Always thinks' : 'Thinking'}</Text>
      {spec.levels.map(l => {
        const def = spec.default === l;
        const cur = current === l;
        return (
          <Pressable
            key={l}
            disabled={!onPick}
            onPress={onPick ? () => onPick(l) : undefined}
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            accessibilityLabel={onPick ? `Use this model with thinking ${THINK_LABEL[l]}${def ? ' (service default)' : ''}` : THINK_LABEL[l]}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 3, height: 20, paddingHorizontal: 6, borderRadius: 6,
              backgroundColor: cur ? alpha(c, 0.3) : pressed ? alpha(c, 0.22) : def ? alpha(c, 0.1) : p.surfaceAlt,
              borderWidth: cur || def ? 1 : 0, borderColor: cur ? c : alpha(c, 0.5),
            })}
          >
            <ThinkBars depth={thinkDepth(l)} size={9} color={c} dim={p.inkSoft} />
            <Text variant="caption" style={{ fontSize: 11, color: cur ? p.ink : def ? c : p.inkSoft, fontWeight: cur ? '700' : '400' }}>{THINK_SHORT[l]}</Text>
          </Pressable>
        );
      })}
      {spec.budget ? (
        <View style={{ height: 20, paddingHorizontal: 6, borderRadius: 6, justifyContent: 'center', backgroundColor: alpha(c, 0.1) }}>
          <Text variant="caption" style={{ fontSize: 11, color: c }}>token budget</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The segmented dial: one stop per level the model takes. */
export function ThinkLevels({ p, spec, value, onPick, muted }: { p: Palette; spec: ThinkSpec; value: ThinkLevel; onPick: (l: ThinkLevel) => void; muted?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: p.bg, borderWidth: 1, borderColor: p.line }}>
      {spec.levels.map(l => {
        const on = l === value;
        const c = depthColor(p, thinkDepth(l));
        return (
          <Pressable
            key={l}
            onPress={() => onPick(l)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${THINK_LABEL[l]}${spec.default === l ? ', the service default' : ''}`}
            style={{
              flex: 1, alignItems: 'center', gap: 4, paddingTop: 8, paddingBottom: 7, borderRadius: 9,
              backgroundColor: on ? alpha(c, muted ? 0.08 : 0.18) : 'transparent',
              borderWidth: on ? 1 : 0, borderColor: alpha(c, muted ? 0.25 : 0.5),
            }}
          >
            <ThinkBars depth={thinkDepth(l)} size={12} color={c} dim={p.inkSoft} />
            <Text variant="caption" style={{ fontSize: 12, color: on ? p.ink : p.inkFaint, fontWeight: on ? '700' : '400' }}>{THINK_SHORT[l]}</Text>
            {spec.default === l ? <View style={{ position: 'absolute', bottom: 2, width: 4, height: 4, borderRadius: 2, backgroundColor: p.inkFaint }} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Reasoning token cap, for models whose service takes one: Auto or one of the stops. */
function ThinkBudget({ p, value, disabled, onPick }: { p: Palette; value: number; disabled: boolean; onPick: (n: number) => void }) {
  const stops = [0, ...THINK_BUDGETS];
  const at = value ? (THINK_BUDGETS.find(b => b >= value) ?? THINK_BUDGETS[THINK_BUDGETS.length - 1]) : 0;
  return (
    <View style={{ marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: p.line, opacity: disabled ? 0.45 : 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text variant="caption" tone="soft">Token budget</Text>
        <Text variant="caption" style={{ fontWeight: '700' }}>{value ? `${fmtBudget(value)} tokens` : 'Auto'}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {stops.map(b => {
          const on = b === at;
          return (
            <Pressable key={b} disabled={disabled} onPress={() => onPick(b)}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8, backgroundColor: on ? p.accentSoft : p.surfaceAlt, borderWidth: on ? 1 : 0, borderColor: p.accent }}>
              <Text variant="caption" style={{ fontSize: 11, color: on ? p.accent : p.inkSoft, fontWeight: on ? '700' : '400' }}>{b ? fmtBudget(b) : 'Auto'}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text variant="caption" tone="faint" style={{ fontSize: 11, marginTop: 6 }}>
        {value > 0 && !disabled
          ? 'A budget replaces the level: OpenRouter takes one or the other.'
          : 'How many tokens it may spend reasoning. Auto follows the level.'}
      </Text>
    </View>
  );
}

/** The chat box chip and its sheet. */
export function ThinkChip({ p, model }: { p: Palette; model: string }) {
  const { book, setThink, settingOf } = useThinkBook();
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const setting = settingOf(model);
  const saved = book[model];
  const m = modelInfo(model);
  const spec = m.think;
  const always = !canStopThinking(spec);
  const provider = PROVIDER_LABEL[m.provider];
  const depth = thinkDepth(setting.level);
  const color = depthColor(p, depth);
  const pick = (s: ThinkSetting) => setThink(model, s);
  // A new level drops the budget; turning thinking off keeps it for when it comes back on.
  const pickLevel = (level: ThinkLevel) => pick({ level, budget: level === 'off' ? saved?.budget : 0 });
  const label = setting.budget ? fmtBudget(setting.budget) : setting.level === 'on' || setting.level === 'off' ? '' : THINK_SHORT[setting.level];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityLabel={`Thinking: ${setting.budget ? `up to ${fmtBudget(setting.budget)} tokens` : THINK_LABEL[setting.level]}. Change thinking`}
        hitSlop={6}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 7, borderRadius: 16, flexShrink: 0,
          backgroundColor: pressed ? p.surfaceAlt : 'transparent',
          borderWidth: depth >= 4 ? 1 : 0, borderColor: alpha(color, 0.35),
        })}
      >
        <ThinkBars depth={depth} size={12} color={color} dim={p.inkSoft} />
        {/* The phone's composer is narrow: the level stands in for the word when there is one. */}
        {!label ? <Text variant="caption" style={{ fontWeight: '600', color: depth ? p.inkSoft : p.inkFaint }}>Think</Text> : null}
        {label ? (
          <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, backgroundColor: alpha(color, 0.16) }}>
            <Text variant="caption" style={{ fontSize: 10.5, fontWeight: '700', color }}>{label}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={{ flex: 1, backgroundColor: p.scrim }} onPress={() => setOpen(false)} />
        <View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%',
          backgroundColor: p.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
          borderTopWidth: 1, borderColor: p.line, paddingBottom: insets.bottom + space.md,
        }}>
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: p.line }} />
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: space.md }}>
              <Text variant="label" tone="faint">THINKING</Text>
              <Text variant="caption" numberOfLines={1} style={{ flexShrink: 1, fontWeight: '700' }}>
                {m.name} <Text variant="caption" tone="faint" style={{ fontWeight: '400' }}>on {provider}</Text>
              </Text>
              {always ? (
                <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 8, backgroundColor: alpha(AMBER, 0.15) }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: warm(p) }} />
                  <Text variant="caption" style={{ fontSize: 11, color: warm(p) }}>Always thinks</Text>
                </View>
              ) : null}
            </View>
            <ThinkLevels p={p} spec={spec} value={setting.level} onPick={pickLevel} muted={Boolean(setting.budget)} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginHorizontal: 4 }}>
              <Text variant="caption" tone="faint" style={{ fontSize: 10, letterSpacing: 0.5 }}>FASTER</Text>
              <View style={{ flex: 1, height: 2, borderRadius: 1, flexDirection: 'row', overflow: 'hidden', opacity: 0.6 }}>
                <View style={{ flex: 1, backgroundColor: p.line }} />
                <View style={{ flex: 1, backgroundColor: p.accent }} />
                <View style={{ flex: 1, backgroundColor: VIOLET }} />
              </View>
              <Text variant="caption" tone="faint" style={{ fontSize: 10, letterSpacing: 0.5 }}>DEEPER</Text>
            </View>
            <View style={{ marginTop: space.md, gap: 2 }}>
              <Text variant="bodyStrong">{setting.budget ? `Up to ${fmtBudget(setting.budget)} reasoning tokens` : THINK_LABEL[setting.level]}</Text>
              <Text variant="caption" tone="soft">{setting.budget ? 'Reasons until it reaches the budget, then answers.' : THINK_HINT[setting.level]}</Text>
              {always ? <Text variant="caption" tone="faint" style={{ fontSize: 11, marginTop: 4 }}>{alwaysHint(provider)}</Text> : null}
            </View>
            {spec.budget ? <ThinkBudget p={p} value={setting.budget || 0} disabled={setting.level === 'off'} onPick={budget => pick({ level: setting.level, budget })} /> : null}
            <View style={{ marginTop: space.md, paddingTop: 6, borderTopWidth: 1, borderTopColor: p.line }}>
              <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
                Remembered for this model on this phone. {spec.default ? `Service default: ${THINK_LABEL[spec.default]}.` : `${provider} does not state a default.`}
              </Text>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
