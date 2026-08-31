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
import { Reminders } from './src/screens/Reminders';
import { Prayers } from './src/screens/Prayers';
import { Search } from './src/screens/Search';
import { Notifications } from './src/screens/Notifications';
import { QuickAdd } from './src/screens/QuickAdd';
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

/**
 * The bell, joined to the planner.
 *
 * The screen itself takes only props on purpose: it asks a question about a
 * list and reports what was decided, and knows nothing about stores or sync.
 * This is the ten lines that connect the two, kept here rather than inside the
 * screen so the screen stays testable as a pure view.
 */
function NotificationsScreen({ onClose, onOpenSettings, onOpenDate }: {
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenDate: (date: string) => void;
}) {
  const {
    notifyCentre, snoozeOptions, alarmSummary, timeFormat, data,
    notifyRead, notifyUnread, notifyDismiss, notifySnooze,
    notifyComplete, notifyClear, notifyMarkAllRead,
  } = usePlanner();

  return (
    <Notifications
      view={notifyCentre}
      now={Date.now()}
      snoozeOptions={snoozeOptions}
      alarmSummary={alarmSummary}
      timeFormat={timeFormat}
      deviceId={data.deviceId}
      onClose={onClose}
      onRead={notifyRead}
      onUnread={notifyUnread}
      onDismiss={notifyDismiss}
      onSnooze={notifySnooze}
      onComplete={notifyComplete}
      onClear={notifyClear}
      onMarkAllRead={notifyMarkAllRead}
      onOpen={entry => { if (entry.occDate) onOpenDate(entry.occDate); }}
      onOpenSettings={onOpenSettings}
    />
  );
}

function Shell() {
  const p = useTheme();
  const { ready, signedIn, conflicts } = usePlanner();
  const [tab, setTab] = useState<TabId>('calendar');
  const [showConflicts, setShowConflicts] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showPrayers, setShowPrayers] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  /** A result tapped in search, handed to the calendar to open. */
  const [pendingOpen, setPendingOpen] = useState<{ date: string } | null>(null);

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
      ) : showReminders ? (
        <Reminders onClose={() => setShowReminders(false)} />
      ) : showPrayers ? (
        <Prayers onClose={() => setShowPrayers(false)} />
      ) : showSearch ? (
        <Search
          onClose={() => setShowSearch(false)}
          onOpenItem={target => {
            setShowSearch(false);
            setPendingOpen({ date: target.date });
          }}
          onOpenDate={date => {
            setShowSearch(false);
            setPendingOpen({ date });
          }}
        />
      ) : showNotifications ? (
        <NotificationsScreen
          onClose={() => setShowNotifications(false)}
          onOpenSettings={() => { setShowNotifications(false); setShowReminders(true); }}
          onOpenDate={date => {
            setShowNotifications(false);
            setPendingOpen({ date });
          }}
        />
      ) : (
        <>
          <View style={{ flex: 1 }}>
            {tab === 'calendar' ? (
              <Today
                onOpenConflicts={() => setShowConflicts(true)}
                onOpenSearch={() => setShowSearch(true)}
                onOpenNotifications={() => setShowNotifications(true)}
                onOpenQuickAdd={() => setShowQuickAdd(true)}
                goToDate={pendingOpen?.date}
                onWentToDate={() => setPendingOpen(null)}
              />
            ) : tab === 'tasks' ? (
              <Tasks />
            ) : tab === 'focus' ? (
              <Focus />
            ) : (
              <Settings
                onClose={() => setTab('calendar')}
                onOpenCategories={() => setShowCategories(true)}
                onOpenReminders={() => setShowReminders(true)}
                onOpenPrayers={() => setShowPrayers(true)}
              />
            )}
          </View>

          {/* Over whatever is on screen, not instead of it: typing one line
              is a thing you do in passing, and losing your place to do it is
              the reason people stop bothering. */}
          {showQuickAdd ? <QuickAdd onClose={() => setShowQuickAdd(false)} /> : null}

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
