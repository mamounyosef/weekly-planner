// Settings > Voice Assistant on the phone: which voice speaks, how fast, how
// long a pause ends your turn, whether you can talk over it, and whether it
// thinks before answering. All of it belongs to this phone; the PC keeps its
// own. The voices themselves are the PC's (Kokoro on its graphics card), so
// the list and the previews need the PC to be reachable.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { Spacer, Text, useTheme } from '../ui/kit';
import { Segment, Stepper, Toggle } from '../ui/Fields';
import { radius, space } from '../theme';
import { TAB_STACK_BOTTOM_INSET } from '../ui/TabBar';
import { usePhoneVoicePrefs } from '../lib/voice/phoneVoicePrefs';
import { fetchPhoneVoices, previewPhoneVoice, type PhoneVoiceInfo } from '../lib/voice/phoneVoiceEnv';
import type { PauseLength } from '../lib/voice/speechText';

export function VoiceSettings() {
  const p = useTheme();
  const [prefs, update] = usePhoneVoicePrefs();
  const [voices, setVoices] = useState<PhoneVoiceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetchPhoneVoices().then(setVoices).catch(e => setError(String(e?.message ?? e)));
  }, []);

  const play = async (v: PhoneVoiceInfo) => {
    if (playing) return;
    setPlaying(v.id);
    try {
      await previewPhoneVoice(v.id, prefs.speed, prefs.volume, `Hi, I'm ${v.name}. Your gym session is moved to Thursday at 6 PM, and you're free after that.`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setPlaying(null);
    }
  };

  const groups: Array<{ title: string; items: PhoneVoiceInfo[] }> = [];
  for (const accent of ['American', 'British']) {
    for (const gender of ['female', 'male']) {
      const items = (voices ?? []).filter(v => v.accent === accent && v.gender === gender);
      if (items.length) groups.push({ title: `${accent} ${gender === 'female' ? 'women' : 'men'}`, items });
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: TAB_STACK_BOTTOM_INSET + space.xxl, gap: space.lg }}>
      <Text variant="caption" tone="soft">
        Talk with the assistant from its tab (the orb button, or "Talk instead"). Your PC hears and speaks for the phone, free, so the PC has to be on.
      </Text>

      <View style={{ gap: space.sm }}>
        <Text variant="label" tone="faint">VOICE</Text>
        {error ? <Text variant="caption" tone="danger">{error}</Text> : null}
        {!voices && !error ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <ActivityIndicator color={p.accent} />
            <Text variant="caption" tone="soft">Loading voices from your PC...</Text>
          </View>
        ) : null}
        {groups.map(g => (
          <View key={g.title} style={{ gap: 6 }}>
            <Text variant="caption" tone="faint" style={{ fontWeight: '700' }}>{g.title}</Text>
            {g.items.map(v => {
              const sel = prefs.voice === v.id;
              return (
                <Pressable
                  key={v.id}
                  onPress={() => update({ voice: v.id })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: sel ? p.accent : p.line, backgroundColor: sel ? p.accentSoft : p.surface }}
                >
                  <Pressable
                    onPress={() => void play(v)}
                    disabled={!!playing && playing !== v.id}
                    accessibilityLabel={`Listen to ${v.name}`}
                    hitSlop={6}
                    style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: v.gender === 'female' ? '#f97316' : '#6366f1', opacity: playing && playing !== v.id ? 0.4 : 1 }}
                  >
                    {playing === v.id ? <ActivityIndicator color="#fff" size="small" /> : <Text variant="bodyStrong" style={{ color: '#fff' }}>▶</Text>}
                  </Pressable>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{v.name}{v.id === 'af_heart' ? '   BEST' : ''}</Text>
                    <Text variant="caption" tone="soft">{v.note}</Text>
                  </View>
                  {sel ? <Text variant="bodyStrong" tone="accent">✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      <View style={{ gap: space.sm }}>
        <Text variant="label" tone="faint">SPEAKING SPEED</Text>
        <Stepper value={Math.round(prefs.speed * 100)} min={80} max={130} step={5} onChange={v => update({ speed: v / 100 })} format={v => `${(v / 100).toFixed(2)}x`} />
        <Spacer size={space.xs} />
        <Text variant="label" tone="faint">VOLUME</Text>
        <Stepper value={Math.round(prefs.volume * 100)} min={10} max={100} step={10} onChange={v => update({ volume: v / 100 })} format={v => `${v}%`} />
      </View>

      <View style={{ gap: space.sm }}>
        <Text variant="label" tone="faint">PAUSE BEFORE IT ANSWERS</Text>
        <Segment<PauseLength>
          options={[{ key: 'quick', label: 'Quick' }, { key: 'balanced', label: 'Balanced' }, { key: 'patient', label: 'Patient' }]}
          value={prefs.pause}
          onChange={k => update({ pause: k })}
        />
        <Text variant="caption" tone="faint">
          {prefs.pause === 'quick' ? 'Answers half a second after you stop. Snappy, may cut in.'
            : prefs.pause === 'patient' ? 'Waits over a second. For thinking out loud.'
              : 'Three quarters of a second. Right for most people.'} It waits longer by itself when you trail off on "and" or "um".
        </Text>
      </View>

      <View style={{ gap: space.xs }}>
        <Toggle label="Think before answering" hint="More careful answers, but a much longer silence before it speaks. The model menu in voice mode shows the seconds for each model." value={prefs.think} onChange={v => update({ think: v })} />
        <Toggle label="Let me talk over it" hint="Start talking while it speaks and it stops to listen. A quick 'mm-hm' does not stop it." value={prefs.interrupt} onChange={v => update({ interrupt: v })} />
        <Toggle label="Soft sounds" hint="A gentle tone when voice mode starts, when it has heard you, and when it ends." value={prefs.sounds} onChange={v => update({ sounds: v })} />
      </View>
    </ScrollView>
  );
}
