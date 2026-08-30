// ─── Daily Planner ───────────────────────────────────────────────────────────
// A native Android planner that holds the whole thing locally, fires its own
// reminders with the PC switched off, and reconciles with the PC whenever the
// two can see each other.
//
// NAVIGATION
// Four places along the bottom, matching the shell the PC already uses for its
// own mobile view: the calendar, the tasks, how the time actually went, and the
// settings. Still no navigation library — the tabs are peers with no history
// between them, which is exactly the case a stack navigator is not for. It would
// add a dependency, a startup cost and a transition budget to model something
// simpler than itself.
//
// Conflicts stay off the bar. They are not a place you go; they are something
// that has happened, so they surface as a badge on the calendar and open over
// it. On a good day the screen does not exist.

import React, { useState } from 'react';
import { ActivityIndicator, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PlannerProvider, usePlanner } from './src/state/planner';
import { ThemeProvider, Text, useTheme } from './src/ui/kit';
import { TabBar, type TabId } from './src/ui/TabBar';
import { Connect } from './src/screens/Connect';
import { Today } from './src/screens/Today';
import { Tasks } from './src/screens/Tasks';
import { Focus } from './src/screens/Focus';
import { Conflicts } from './src/screens/Conflicts';
import { Settings } from './src/screens/Settings';
import { Categories } from './src/screens/Categories';
import { space } from './src/theme';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <PlannerProvider>
          <Shell />
        </PlannerProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const p = useTheme();
  const { ready, signedIn, conflicts } = usePlanner();
  const [tab, setTab] = useState<TabId>('calendar');
  const [showConflicts, setShowConflicts] = useState(false);
  const [showCategories, setShowCategories] = useState(false);

  // The splash lasts only as long as opening SQLite; there is no network in this
  // path, so it is over before it registers even on a slow phone.
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg, alignItems: 'center', justifyContent: 'center', gap: space.lg }}>
        <StatusBar barStyle="light-content" backgroundColor={p.bg} />
        <ActivityIndicator color={p.accent} />
        <Text variant="caption" tone="faint">Opening your planner…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar
        barStyle={p.bg === '#0D0D14' ? 'light-content' : 'dark-content'}
        backgroundColor={p.bg}
      />

      {!signedIn ? (
        <Connect />
      ) : showConflicts ? (
        <Conflicts onClose={() => setShowConflicts(false)} />
      ) : showCategories ? (
        // Over the settings tab rather than a tab of its own: categories are
        // configuration you visit occasionally, not a place you live in.
        <Categories onClose={() => setShowCategories(false)} />
      ) : (
        <>
          <View style={{ flex: 1 }}>
            {tab === 'calendar' ? (
              <Today onOpenConflicts={() => setShowConflicts(true)} />
            ) : tab === 'tasks' ? (
              <Tasks />
            ) : tab === 'focus' ? (
              <Focus />
            ) : (
              <Settings
                onClose={() => setTab('calendar')}
                onOpenCategories={() => setShowCategories(true)}
              />
            )}
          </View>

          <TabBar
            active={tab}
            onChange={setTab}
            badges={{ calendar: conflicts.length > 0 ? conflicts.length : undefined }}
          />
        </>
      )}
    </View>
  );
}
