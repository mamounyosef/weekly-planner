// ─── When a screen throws ────────────────────────────────────────────────────
// Until now a render error anywhere in this app produced a BLANK PAGE, and
// sometimes took the process with it. That is the worst possible outcome: the
// one moment the app knows exactly what went wrong is the moment it throws away
// the message and shows nothing. An evening has already been lost to this class
// of failure once, on launch, where the only evidence was an absent line in a
// server log.
//
// So the error is caught, named on screen, and the rest of the app is left
// standing. A crash in the focus chart should cost you the focus chart, not the
// planner, and certainly not silence.
//
// NO REPORTING SERVICE, deliberately. That would be a new native dependency and
// this app can only be updated over the air for as long as it has none. The
// message on screen is enough to act on, and the user can photograph it.

import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text } from './kit';
import { radius, space } from '../theme';

interface Props {
  children: React.ReactNode;
  /**
   * Change this to clear a caught error.
   *
   * Passing the current tab means walking away from a broken screen and coming
   * back retries it, which is what a person will try first anyway.
   */
  resetKey?: string | number;
  /** Named in the message, so the report says WHERE without any guessing. */
  where?: string;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // Kept on the instance rather than only logged: a release build has no
    // console anyone can read, so the stack has to reach the screen itself.
    this.setState({ error, info: (info?.componentStack ?? '').trim() });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: '' });
    }
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const where = this.props.where ? ` in ${this.props.where}` : '';
    // The stack is the useful half, but only the first few frames of it: the
    // rest is React's own machinery and pushes the real line off the screen.
    const stack = String(error.stack ?? '')
      .split('\n')
      .slice(0, 8)
      .join('\n');
    const tree = info.split('\n').slice(0, 6).join('\n').trim();

    return (
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.md }}>
        <Text variant="heading">Something broke{where}</Text>
        <Text variant="caption" tone="soft">
          The rest of the planner is fine, and nothing was lost. Your data lives on this
          phone and on your PC, not on this screen.
        </Text>

        <View style={{
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: 'rgba(255,0,0,0.06)',
          borderWidth: 1,
          borderColor: 'rgba(255,0,0,0.30)',
          gap: space.sm,
        }}>
          <Text variant="bodyStrong" tone="danger">
            {String(error.name || 'Error')}: {String(error.message || 'no message')}
          </Text>
          {stack ? (
            <Text variant="caption" tone="soft" style={{ fontSize: 11 }}>{stack}</Text>
          ) : null}
          {tree ? (
            <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{tree}</Text>
          ) : null}
        </View>

        <Pressable
          onPress={() => this.setState({ error: null, info: '' })}
          accessibilityRole="button"
          style={{
            paddingVertical: space.md,
            alignItems: 'center',
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: 'rgba(128,128,128,0.4)',
          }}
        >
          <Text variant="bodyStrong" tone="accent">Try this screen again</Text>
        </Pressable>

        <Text variant="caption" tone="faint">
          If it keeps happening, a photo of this message says exactly what went wrong.
        </Text>
      </ScrollView>
    );
  }
}
