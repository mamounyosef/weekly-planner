// ─── First run: point the app at your planner ────────────────────────────────
// Three fields and one button. The address is the only thing people get wrong,
// so it explains itself, accepts whatever form they paste, and says plainly what
// went wrong when it fails.

import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Row, Spacer, Text, useTheme } from '../ui/kit';
import { radius, space, type as typeScale, HIT } from '../theme';
import { usePlanner } from '../state/planner';
import { normaliseBaseUrl, TransportError } from '../lib/syncTransport';

export function Connect() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { connect, serverUrl } = usePlanner();

  const [address, setAddress] = useState(serverUrl ?? '');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = normaliseBaseUrl(address);

  const submit = async () => {
    setError(null);
    if (!preview) {
      setError('That address does not look like a link. Try the one you open the planner with.');
      return;
    }
    if (user.trim().length === 0) {
      setError('Enter the username you use on the PC.');
      return;
    }
    setBusy(true);
    try {
      await connect(preview, user.trim(), password);
    } catch (err) {
      setError(
        err instanceof TransportError
          ? err.message
          : 'Something went wrong signing in. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const field = {
    minHeight: HIT,
    backgroundColor: p.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: p.line,
    paddingHorizontal: space.lg,
    color: p.ink,
    ...typeScale.body,
  } as const;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: p.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          padding: space.xl,
          paddingTop: insets.top + space.xxl,
          paddingBottom: insets.bottom + space.xxl,
          flexGrow: 1,
          justifyContent: 'center',
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space.xs }}>
          <Text variant="label" tone="accent">Daily Planner</Text>
          <Text variant="display">Connect to your planner</Text>
          <Text variant="body" tone="soft" style={{ marginTop: space.sm }}>
            Sign in once. After that the app works with your PC switched off. Everything
            lives on this phone and syncs when the two can see each other.
          </Text>
        </View>

        <Spacer size={space.xxl} />

        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">Planner address</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="planner.your-tailnet.ts.net"
            placeholderTextColor={p.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            style={field}
          />
          {address.length > 0 ? (
            <Text variant="caption" tone={preview ? 'faint' : 'danger'}>
              {preview ? `Will connect to ${preview}` : 'That is not a usable address'}
            </Text>
          ) : (
            <Text variant="caption" tone="faint">
              The same link you open the planner with in a browser.
            </Text>
          )}
        </View>

        <Spacer />

        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">Username</Text>
          <TextInput
            value={user}
            onChangeText={setUser}
            placeholder="your username"
            placeholderTextColor={p.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            style={field}
          />
        </View>

        <Spacer />

        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="faint">Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={p.inkFaint}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            onSubmitEditing={submit}
            returnKeyType="go"
            style={field}
          />
        </View>

        {error ? (
          <View style={{
            marginTop: space.lg,
            padding: space.lg,
            borderRadius: radius.md,
            backgroundColor: p.surface,
            borderLeftWidth: 3,
            borderLeftColor: p.danger,
          }}>
            <Text variant="body" tone="danger">{error}</Text>
          </View>
        ) : null}

        <Spacer size={space.xl} />

        <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={submit} busy={busy} />

        <Spacer size={space.xl} />
        <Row gap={space.sm} align="flex-start">
          <Text variant="caption" tone="faint" style={{ flex: 1 }}>
            Your password is sent once and never stored. The app keeps only a session for
            this device, in the phone's secure keystore.
          </Text>
        </Row>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
