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

import React, { useCallback, useEffect, useState, useTransition } from 'react';
import { ActivityIndicator, StatusBar, View, BackHandler } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PlannerProvider, usePlanner, useNotifyCentre } from './src/state/planner';
import { ThemeProvider, Text, useTheme } from './src/ui/kit';
import { TabBar, type TabId } from './src/ui/TabBar';
import { Connect } from './src/screens/Connect';
import { Today } from './src/screens/Today';
import { Tasks } from './src/screens/Tasks';
import { Focus } from './src/screens/Focus';
import { Conflicts } from './src/screens/Conflicts';
import { Settings } from './src/screens/Settings';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { KeepAlive } from './src/ui/KeepAlive';
import { Categories } from './src/screens/Categories';
import { TaskSettings } from './src/screens/TaskSettings';
import { Reminders } from './src/screens/Reminders';
import { Prayers } from './src/screens/Prayers';
import { Planner } from './src/screens/Planner';
import { Search } from './src/screens/Search';
import { Notifications } from './src/screens/Notifications';
import { QuickAdd } from './src/screens/QuickAdd';
import { Diagnostics } from './src/screens/Diagnostics';
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
  // The list itself comes from its own context: it is rebuilt every thirty
  // seconds so the wording stays true, and subscribing to it here rather than
  // through the planner value is what keeps that tick off every other screen.
  const notifyCentre = useNotifyCentre();
  const {
    snoozeOptions, alarmSummary, timeFormat, data,
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
  /**
   * Which tab the CONTENT is on, and which one the BAR is showing.
   *
   * Two states rather than one, on purpose. The bar has to answer the press in
   * the same frame it happens — that instant highlight is most of what makes an
   * app feel quick — while mounting a screen for the first time can take longer
   * than a frame. So the bar moves at once, and the screen follows in a
   * transition, which React is allowed to interrupt if the user changes their
   * mind and presses somewhere else.
   *
   * Once a tab has been visited it stays mounted (see `KeepAlive`), so from
   * then on the two land in the same frame anyway and the transition costs
   * nothing.
   */
  const [tab, setTab] = useState<TabId>('calendar');
  const [pressedTab, setPressedTab] = useState<TabId>('calendar');
  const [, startTransition] = useTransition();

  const goToTab = useCallback((id: TabId) => {
    setPressedTab(id);
    startTransition(() => setTab(id));
  }, []);
  const [showConflicts, setShowConflicts] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [showTaskSettings, setShowTaskSettings] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showPrayers, setShowPrayers] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  /** A result tapped in search, handed to the calendar to open. */
  const [pendingOpen, setPendingOpen] = useState<{ date: string } | null>(null);


  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showDiagnostics) { setShowDiagnostics(false); return true; }
      if (showQuickAdd) { setShowQuickAdd(false); return true; }
      if (showNotifications) { setShowNotifications(false); return true; }
      if (showSearch) { setShowSearch(false); return true; }
      if (showPlanner) { setShowPlanner(false); return true; }
      if (showPrayers) { setShowPrayers(false); return true; }
      if (showReminders) { setShowReminders(false); return true; }
      if (showCategories) { setShowCategories(false); return true; }
      if (showTaskSettings) { setShowTaskSettings(false); return true; }
      if (showConflicts) { setShowConflicts(false); return true; }
      
      if (pressedTab !== 'calendar') {
        goToTab('calendar');
        return true;
      }
      
      // If we are at the calendar tab and no modals are open, exit the app
      return false;
    });
    return () => sub.remove();
  }, [
    showDiagnostics, showQuickAdd, showNotifications, showSearch,
    showPlanner, showPrayers, showReminders, showCategories, showTaskSettings,
    showConflicts, pressedTab, goToTab,
  ]);

  // The splash lasts only as long as opening SQLite; there is no network in this
  // path, so it is over before it registers even on a slow phone.
  /**
   * Which screen is currently covering the tabs, if any.
   *
   * One value rather than eight nested ternaries, so the tabs can be rendered
   * unconditionally and simply hidden. The order below is the priority order
   * the chain of ternaries had, kept exactly: two of these can be open at once
   * (the bell can open reminders), and this is what decides which one wins.
   */
  const overlay =
    showConflicts ? 'conflicts'
      : showCategories ? 'categories'
        : showTaskSettings ? 'taskSettings'
          : showReminders ? 'reminders'
            : showPrayers ? 'prayers'
              : showPlanner ? 'planner'
                : showSearch ? 'search'
                  : showNotifications ? 'notifications'
                    : null;

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
      ) : (
        <>
          {/* THE TABS ARE HIDDEN BEHIND AN OVERLAY, NOT DESTROYED BY IT.
              This chain used to be `overlay ? <Overlay/> : <tabs/>`, which tore
              down every tab the moment you opened Categories and rebuilt them
              all when you closed it — losing the calendar's scroll position and
              chosen day to a visit to a settings page. Wrapping them keeps the
              same appearance (an overlay still fills the screen, tab bar and
              all) while leaving what is underneath intact. */}
          <KeepAlive visible={overlay === null}>
            {/* Each tab keeps its own boundary, so a screen that throws costs you
                that screen and nothing else. `resetKey` is the tab's own id: it
                never changes, because the screen is no longer torn down and
                rebuilt on every visit. Leaving a tab and coming back is now a
                `display` change, and would not have retried anything anyway. The
                boundary offers its own "try again". */}
            <View style={{ flex: 1 }}>
              <KeepAlive visible={tab === 'calendar'}>
                <ErrorBoundary resetKey="calendar" where="the calendar screen">
                  <Today
                    onOpenConflicts={() => setShowConflicts(true)}
                    onOpenSearch={() => setShowSearch(true)}
                    onOpenNotifications={() => setShowNotifications(true)}
                    onOpenQuickAdd={() => setShowQuickAdd(true)}
                    goToDate={pendingOpen?.date}
                    onWentToDate={() => setPendingOpen(null)}
                  />
                </ErrorBoundary>
              </KeepAlive>

              <KeepAlive visible={tab === 'tasks'}>
                <ErrorBoundary resetKey="tasks" where="the tasks screen">
                  <Tasks />
                </ErrorBoundary>
              </KeepAlive>

              <KeepAlive visible={tab === 'focus'}>
                <ErrorBoundary resetKey="focus" where="the focus screen">
                  <Focus />
                </ErrorBoundary>
              </KeepAlive>

              <KeepAlive visible={tab === 'settings'}>
                <ErrorBoundary resetKey="settings" where="the settings screen">
                  <Settings
                    onClose={() => goToTab('calendar')}
                    onOpenCategories={() => setShowCategories(true)}
                    onOpenTasks={() => setShowTaskSettings(true)}
                    onOpenReminders={() => setShowReminders(true)}
                    onOpenPrayers={() => setShowPrayers(true)}
                    onOpenPlanner={() => setShowPlanner(true)}
                  />
                </ErrorBoundary>
              </KeepAlive>
            </View>

            {/* Over whatever is on screen, not instead of it: typing one line
                is a thing you do in passing, and losing your place to do it is
                the reason people stop bothering. */}
            {showQuickAdd ? <QuickAdd onClose={() => setShowQuickAdd(false)} /> : null}

            <TabBar
              active={pressedTab}
              onChange={goToTab}
              badges={{ calendar: conflicts.length > 0 ? conflicts.length : undefined }}
            />
          </KeepAlive>

          {overlay === 'conflicts' ? (
            <Conflicts onClose={() => setShowConflicts(false)} />
          ) : overlay === 'categories' ? (
            // Over the settings tab rather than a tab of its own: categories are
            // configuration you visit occasionally, not a place you live in.
            <Categories onClose={() => setShowCategories(false)} />
          ) : overlay === 'taskSettings' ? (
            <TaskSettings onClose={() => setShowTaskSettings(false)} />
          ) : overlay === 'reminders' ? (
            <Reminders onClose={() => setShowReminders(false)} />
          ) : overlay === 'prayers' ? (
            <Prayers onClose={() => setShowPrayers(false)} />
          ) : overlay === 'planner' ? (
            <Planner onClose={() => setShowPlanner(false)} />
          ) : overlay === 'search' ? (
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
          ) : overlay === 'notifications' ? (
            <NotificationsScreen
              onClose={() => setShowNotifications(false)}
              onOpenSettings={() => { setShowNotifications(false); setShowReminders(true); }}
              onOpenDate={date => {
                setShowNotifications(false);
                setPendingOpen({ date });
              }}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
