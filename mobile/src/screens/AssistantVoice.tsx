// Voice mode on the phone: the orb, what is being said right now, and the few
// controls a conversation needs. It takes the composer's place; the chat
// above keeps the whole back-and-forth in text with the same change reports,
// Undo and Approve cards. The same design as the PC's VoiceDock.

import React, { useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';

import { Text } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { VoiceOrb } from '../ui/VoiceOrb';
import { space } from '../theme';
import type { Palette } from '../theme';
import type { VoiceConversation } from '../lib/voice/useVoiceConversation';
import { ModelPill, type PillSpeed } from './AssistantModelPicker';

export const PHASE_LABEL: Record<string, string> = {
  connecting: 'Connecting to your PC',
  loading: 'Waking up the voice engine',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Something went wrong',
  ended: 'Voice mode ended',
};

const PHASE_TINT: Record<string, string> = {
  listening: '#60a5fa', hearing: '#38bdf8', thinking: '#a78bfa', speaking: '#fb923c',
  connecting: '#94a3b8', loading: '#94a3b8', error: '#f87171', ended: '#94a3b8',
};

function Icon({ name, size = 20, color }: { name: string; size?: number; color: string }) {
  const src = ICONS[name];
  if (!src) return null;
  return <Image source={{ uri: src }} style={{ width: size, height: size, tintColor: color }} />;
}

export function AssistantVoice({ p, voice, model, onPickModel, speed, think, onThink, compact }: {
  p: Palette;
  voice: VoiceConversation;
  model: string;
  onPickModel: (id: string) => void;
  speed: PillSpeed;
  think: boolean;
  onThink: (on: boolean) => void;
  compact?: boolean;
}) {
  const { phase, muted } = voice;
  const busy = phase === 'connecting' || phase === 'loading' || phase === 'thinking';
  const tint = muted && phase !== 'speaking' ? '#9ca3af' : PHASE_TINT[phase] ?? p.inkSoft;
  const label = muted && (phase === 'listening' || phase === 'hearing') ? 'Muted' : PHASE_LABEL[phase] ?? '';
  const orbSize = compact ? 170 : 220;

  // The last thing said stays readable for a moment after it is done.
  const [caption, setCaption] = useState<{ who: 'you' | 'ai'; text: string; live: boolean } | null>(null);
  useEffect(() => {
    if (voice.saying) setCaption({ who: 'ai', text: voice.saying, live: true });
    else if (voice.heard) setCaption({ who: 'you', text: voice.heard, live: !voice.heardFinal });
  }, [voice.saying, voice.heard, voice.heardFinal]);
  useEffect(() => {
    if (voice.saying || voice.heard) return;
    const t = setTimeout(() => setCaption(null), 2500);
    return () => clearTimeout(t);
  }, [voice.saying, voice.heard]);

  // Dots after "Thinking", "Connecting"...
  const [dots, setDots] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setDots(d => (d + 1) % 4), 380);
    return () => clearInterval(id);
  }, [busy]);

  const onOrb = () => {
    if (phase === 'speaking') voice.interrupt();
    else if (phase === 'hearing') voice.finishTurn();
    else voice.setMuted(!muted);
  };
  const orbHint = phase === 'speaking' ? 'Tap the orb to stop it talking'
    : phase === 'hearing' ? "Tap the orb when you're done"
      : muted ? 'Tap the orb to unmute' : '';

  return (
    <View style={{ margin: space.sm, marginTop: 0, borderRadius: 26, borderWidth: 1, borderColor: p.line, backgroundColor: p.surface, overflow: 'hidden', elevation: 6 }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: tint, opacity: 0.07 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingTop: space.sm }}>
        <ModelPill p={p} model={model} onPick={onPickModel} speed={speed} label="Voice" />
        <Pressable
          onPress={() => onThink(!think)}
          accessibilityLabel={think ? 'Thinks before answering. Tap for quick answers.' : 'Quick answers. Tap to let it think first.'}
          style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', borderWidth: 1, borderColor: think ? 'rgba(167,139,250,0.45)' : p.line, backgroundColor: think ? 'rgba(167,139,250,0.14)' : 'transparent' }}
        >
          <Text variant="caption" style={{ fontWeight: '700', color: think ? '#a78bfa' : p.inkSoft }}>{think ? 'Thinks first' : 'Quick'}</Text>
        </Pressable>
      </View>

      <View style={{ alignItems: 'center' }}>
        <VoiceOrb size={orbSize} phase={phase} muted={muted} levels={voice.levels} onPress={onOrb} label={orbHint || label} />
        <Text variant="bodyStrong" style={{ color: tint, marginTop: -4 }}>
          {label}{busy ? '.'.repeat(dots) : ''}
        </Text>
        <View style={{ minHeight: 46, paddingHorizontal: space.lg, paddingTop: 6, alignItems: 'center', justifyContent: 'flex-start', alignSelf: 'stretch' }}>
          {voice.error ? (
            <Text variant="caption" tone="danger" style={{ textAlign: 'center' }}>{voice.error}</Text>
          ) : caption ? (
            <Text variant="body" numberOfLines={2} style={{ textAlign: 'center', opacity: caption.live ? 1 : 0.75, fontStyle: caption.who === 'you' && caption.live ? 'italic' : 'normal' }}>
              <Text variant="bodyStrong" style={{ color: caption.who === 'you' ? '#60a5fa' : '#fb923c' }}>{caption.who === 'you' ? 'You  ' : 'Assistant  '}</Text>
              {caption.text}
            </Text>
          ) : (
            <Text variant="caption" tone="faint" style={{ textAlign: 'center' }}>
              {phase === 'loading' ? 'The first start takes a few seconds while the voice models load on your PC.'
                : orbHint || (phase === 'listening' ? 'Just talk. Pause when you are done.' : '')}
            </Text>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md, paddingBottom: space.md, paddingTop: space.xs }}>
        <RoundButton p={p} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={() => voice.setMuted(!muted)}>
          <Icon name="mic" size={20} color={muted ? '#ffffff' : p.ink} />
          {muted ? <View style={{ position: 'absolute', width: 26, height: 2.5, borderRadius: 2, backgroundColor: '#ffffff', transform: [{ rotate: '-45deg' }] }} /> : null}
        </RoundButton>
        {phase === 'speaking' ? (
          <RoundButton p={p} label="Stop talking" onPress={voice.interrupt}>
            <Icon name="square" size={17} color={p.ink} />
          </RoundButton>
        ) : (
          <RoundButton p={p} label="I'm done talking" onPress={voice.finishTurn} disabled={phase !== 'hearing'}>
            <Icon name="check" size={20} color={p.ink} />
          </RoundButton>
        )}
        <Pressable
          onPress={voice.stop}
          accessibilityLabel="End voice mode"
          style={({ pressed }) => ({
            height: 50, paddingHorizontal: 22, borderRadius: 25, flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: '#e11d48', transform: [{ scale: pressed ? 0.95 : 1 }], elevation: 4,
          })}
        >
          <Icon name="x" size={18} color="#ffffff" />
          <Text variant="bodyStrong" style={{ color: '#ffffff' }}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RoundButton({ p, label, onPress, active, disabled, children }: {
  p: Palette; label: string; onPress: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center',
        backgroundColor: active ? '#64748b' : p.surfaceAlt, borderWidth: 1, borderColor: p.line,
        opacity: disabled ? 0.4 : 1, transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {children}
    </Pressable>
  );
}
