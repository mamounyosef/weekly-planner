# Daily Planner — Android app

The native phone half of the planner. Holds the whole planner locally, fires its
own reminders with the PC switched off, and reconciles with the PC whenever the
two can reach each other.

## What is here

| Path | What it is |
| --- | --- |
| `App.tsx` | Three screens, no navigation library |
| `src/state/planner.tsx` | Load → paint → sync loop, and the alarm re-plan |
| `src/screens/` | Connect, Today, Conflicts, Settings |
| `src/ui/kit.tsx`, `src/theme.ts` | Design tokens and primitives (dark + light) |
| `src/lib/sqlite.ts` | expo-sqlite behind the tested `SqlRunner` contract |
| `src/lib/notify.ts` | Android alarms — the OS calls only |
| `src/lib/prefs.ts` | Server address, session and device id (SecureStore) |
| `src/lib/*.ts` (the rest) | **Copies** of the tested engine — see below |

## The engine is not maintained here

`sync.ts`, `syncBridge.ts`, `syncClient.ts`, `syncStorage.ts`, `syncTransport.ts`,
`alarmPlan.ts`, `agenda.ts`, `notifications.ts`, `recurrence.ts`, `categories.ts`,
`prayerTimes.ts`, `tasks.ts`, `taskLists.ts` and `gcalColor.ts` are copied from
`artifacts/weekly-planner/src/lib/`.

That is where they are edited and where their tests live, because both machines
must run **identical** merge and scheduling logic — a phone and a PC that
disagree about what a reminder means, or about who wins a conflict, would drift
apart permanently.

After changing any of them on the PC side:

```bash
cd artifacts/weekly-planner
npm test                     # all suites must pass first
cp src/lib/{sync,syncBridge,syncClient,syncStorage,syncTransport,alarmPlan,agenda,notifications,recurrence,categories,prayerTimes,tasks,taskLists,gcalColor,grid,draft,focusStats,dragGrid,monthDrag,occurrence,viewPrefs,prayerSettings,focusTimer,notifyCentre,search}.ts ../../mobile/src/lib/
cd ../../mobile && npx tsc --noEmit
```

## Running it

```bash
npm install
npx expo start          # then open in a development build
npx tsc --noEmit        # type check
npx expo export --platform android   # verify it bundles
```

`npx expo start` needs a **development build** on the phone, not Expo Go —
`expo-sqlite`, `expo-notifications` and `expo-secure-store` are native modules.

## Building the APK

Not yet done — this needs tooling that is not on the PC yet. Two routes:

**Local (free, no accounts).** Install JDK 17 and the Android SDK command-line
tools, then:

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/`. A signing key must be
generated once and **kept forever** — losing it means the app can never be
updated in place again, only uninstalled and reinstalled.

**EAS Build (free tier, cloud).** Needs a free Expo account:

```bash
npx eas-cli build --platform android --profile preview
```

## Configuration

`app.json` holds the package name (`com.mamoun.dailyplanner`), the Android
permissions (exact alarms, notifications, boot-completed) and the OTA update URL.
The update URL points at the planner server's `/api/ota/manifest`, which is not
implemented yet — the app handles its absence and simply reports that no update
server is reachable.
