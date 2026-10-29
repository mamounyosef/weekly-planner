// Settings > Assistant on the phone: the API keys of each service (Ollama,
// OpenRouter), the chat's model and its thinking. The keys live on the PC
// (the assistant runs there), so this screen needs the PC and only ever sees
// them masked. They are tried in order: when one runs out of credit, the next
// key of the SAME service answers and the reply says so. The model and
// thinking picks belong to this phone.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';

import { Text, useTheme } from '../ui/kit';
import { radius, space } from '../theme';
import type { Palette } from '../theme';
import { TAB_STACK_BOTTOM_INSET } from '../ui/TabBar';
import { agentKeysApi, readPhoneChatModel, setPhoneChatModel } from '../lib/agent/agentApi';
import {
  DEFAULT_MODEL, MODELS, PROVIDERS, PROVIDER_LABEL, canStopThinking, fmtCtx, isKnownModel, modelInfo, paramsLabel, type Provider,
} from '../lib/agent/agentModels';
import type { AgentKeyInfo, AgentKeysStatus } from '../lib/agent/agentTypes';
import { useThinkBook } from '../lib/agent/thinkPrefs';
import { ThinkLevels } from './AssistantThink';

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const HINT: Record<Provider, string> = {
  ollama: 'Create one at ollama.com, Settings, Keys.',
  openrouter: 'For the free OpenRouter models. Create one at openrouter.ai, Keys.',
};

function SmallButton({ p, label, onPress, disabled, danger }: { p: Palette; label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={4}
      style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: danger ? p.danger : p.line, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 })}>
      <Text variant="caption" style={{ fontWeight: '700', color: danger ? p.danger : p.ink }}>{label}</Text>
    </Pressable>
  );
}

function KeyRows({ p, provider, keys, onChanged }: { p: Palette; provider: Provider; keys: AgentKeyInfo[]; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [limits, setLimits] = useState<string[]>([]);
  const label = PROVIDER_LABEL[provider];

  const count = keys.length;
  useEffect(() => {
    if (provider !== 'openrouter' || !count) { setLimits([]); return; }
    let gone = false;
    Promise.all(Array.from({ length: count }, (_, i) => agentKeysApi.openrouterLimits(i)
      .then(l => (l.ok && l.freeLimit ? ` Free requests today: ${l.freeUsed ?? 0} of ${l.freeLimit} used.` : ''))))
      .then(v => { if (!gone) setLimits(v); });
    return () => { gone = true; };
  }, [provider, count]);

  const act = async (job: () => Promise<{ ok: boolean; error?: string; info?: string }>, done: (info?: string) => string) => {
    setBusy(true);
    setMsg(null);
    const r = await job();
    setBusy(false);
    setMsg(r.ok ? { text: done(r.info) } : { text: r.error || 'That did not work.', bad: true });
    onChanged();
  };
  const add = () => act(async () => {
    const r = await agentKeysApi.add(provider, key.trim());
    if (r.ok) setKey('');
    return r;
  }, () => `Key saved. It is used when the ${label} keys above it run out.`);

  return (
    <View style={{ gap: space.sm }}>
      <Text variant="bodyStrong">{label} API keys</Text>
      <Text variant="caption" tone="soft">
        {keys.length
          ? `Saved on the PC. Tried in order: when one runs out of credit, the next ${label} key is used, and the reply says so.`
          : `Not set. ${HINT[provider]}`}
      </Text>
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder={keys.length ? 'Add another key' : 'Paste key'}
          placeholderTextColor={p.inkFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={{ flex: 1, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: p.line, paddingHorizontal: space.md, color: p.ink }}
        />
        <Pressable onPress={() => void add()} disabled={!key.trim() || busy}
          style={{ height: 40, paddingHorizontal: 16, borderRadius: radius.md, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center', opacity: !key.trim() || busy ? 0.5 : 1 }}>
          {busy ? <ActivityIndicator size="small" color={p.accent} /> : <Text variant="caption" tone="accent" style={{ fontWeight: '700' }}>Add</Text>}
        </Pressable>
      </View>
      {keys.map((k, i) => {
        const state = k.inUse ? (k.outUntil ? (k.trouble === 'rejected' ? 'In use, but refused' : 'In use, but out of credit') : 'In use')
          : k.outUntil ? (k.trouble === 'rejected' ? 'Refused' : 'Out of credit') : 'Backup';
        const color = k.outUntil ? p.danger : k.inUse ? p.ok : p.inkSoft;
        return (
          <View key={`${k.masked}-${i}`} style={{ borderRadius: radius.md, borderWidth: 1, borderColor: k.inUse ? p.accent : p.line, padding: space.md, gap: 6 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <Text variant="caption" style={{ fontWeight: '700' }}>Key {i + 1}: {k.masked}</Text>
              {k.fromEnv ? (
                <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: p.accentSoft }}>
                  <Text variant="caption" tone="accent" style={{ fontSize: 10, fontWeight: '700' }}>.env</Text>
                </View>
              ) : null}
              <Text variant="caption" style={{ fontWeight: '700', color }}>{state}</Text>
            </View>
            <Text variant="caption" tone="soft" style={{ fontSize: 12 }}>
              {k.outUntil ? `Skipped until ${clock(k.outUntil)}, then tried again. ${k.detail}` : k.inUse ? 'Requests go to this key.' : 'Used if the keys above it run out.'}
              {limits[i] || ''}
              {k.fromEnv ? ' Read from the .env file on the PC.' : ''}
            </Text>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {!k.inUse ? <SmallButton p={p} label="Use" disabled={busy} onPress={() => void act(() => agentKeysApi.use(provider, i), () => `Key ${i + 1} is now in use.`)} /> : null}
              <SmallButton p={p} label="Test" disabled={busy} onPress={() => void act(
                async () => { const r = await agentKeysApi.test(provider, i); return r.ok ? r : { ...r, error: `Key ${i + 1}: ${r.error}` }; },
                info => `Key ${i + 1}: ${info || 'Works.'}`,
              )} />
              <SmallButton p={p} label="Remove" danger disabled={busy} onPress={() => Alert.alert(
                `Remove ${label} key ${i + 1}?`,
                `${k.masked}${k.fromEnv ? '\nThe .env file on the PC is not changed.' : ''}`,
                [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void act(() => agentKeysApi.remove(provider, i), () => 'Key removed.') }],
              )} />
            </View>
          </View>
        );
      })}
      {msg ? <Text variant="caption" tone={msg.bad ? 'danger' : 'soft'}>{msg.text}</Text> : null}
    </View>
  );
}

export function AssistantSettings() {
  const p = useTheme();
  const [status, setStatus] = useState<AgentKeysStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModelState] = useState(DEFAULT_MODEL);
  const think = useThinkBook();

  const refresh = useCallback(() => {
    agentKeysApi.status().then(s => { setStatus(s); setError(null); }).catch(e => setError(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    refresh();
    readPhoneChatModel().then(v => { if (v) setModelState(v); });
  }, [refresh]);
  const setModel = (id: string) => {
    setModelState(id);
    setPhoneChatModel(id);
  };

  const m = modelInfo(model);
  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, paddingBottom: TAB_STACK_BOTTOM_INSET + space.xxl, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Text variant="caption" tone="soft">
        The services the assistant runs on. The keys are kept on the PC, so the PC has to be reachable here. Each service only uses its own keys: a model never moves to the other service.
      </Text>
      {error ? <Text variant="caption" tone="danger">{error}</Text> : null}
      {!status && !error ? <ActivityIndicator color={p.accent} /> : null}
      {status ? PROVIDERS.map(prov => <KeyRows key={prov} p={p} provider={prov} keys={status[prov]} onChanged={refresh} />) : null}

      <View style={{ gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: p.line }}>
        <Text variant="label" tone="faint">MODEL</Text>
        <Text variant="caption" tone="soft">{paramsLabel(m)}, {fmtCtx(m.context)} context, on {PROVIDER_LABEL[m.provider]}. Remembered on this phone; also in the chat box.</Text>
        <View style={{ gap: 4 }}>
          {MODELS.map(x => {
            const sel = x.id === model;
            return (
              <Pressable key={x.id} onPress={() => setModel(x.id)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: sel ? p.accentSoft : pressed ? p.surfaceAlt : 'transparent' })}>
                <Text variant="body" style={{ flex: 1, fontWeight: sel ? '700' : '400' }}>{x.name}</Text>
                <Text variant="caption" style={{ fontSize: 11, color: x.provider === 'openrouter' ? '#c678dd' : p.inkSoft }}>{PROVIDER_LABEL[x.provider]}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ gap: space.sm }}>
        <Text variant="label" tone="faint">THINKING</Text>
        <Text variant="caption" tone="soft">
          {canStopThinking(m.think) ? 'Deeper is slower, but better at multi step plans.' : `${m.name} always thinks on ${PROVIDER_LABEL[m.provider]}.`} Kept per model. Voice mode has its own switch.
        </Text>
        <ThinkLevels p={p} spec={m.think} value={think.settingOf(model).level} onPick={level => think.setThink(model, { level })} />
      </View>
    </ScrollView>
  );
}
