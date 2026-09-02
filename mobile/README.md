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
cp src/lib/{sync,syncBridge,syncClient,syncStorage,syncTransport,alarmPlan,agenda,notifications,recurrence,categories,prayerTimes,tasks,taskLists,gcalColor,grid,draft,focusStats,dragGrid,monthDrag,occurrence,viewPrefs,prayerSettings,focusTimer,notifyCentre,search,updateLabel,focusPeriod,yearStats}.ts ../../mobile/src/lib/
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

## Shipping a change: OTA

**One command.** From `mobile/`:

```bash
npm run publish
```

It typechecks (and refuses to publish if that fails), bundles, and drops the
result in `database/ota/<runtimeVersion>/<YYYYMMDD-HHMMSS>/`, which the planner
server serves. On the phone: **Settings > App & Data > Check for update**, then
Restart. It also arrives on its own the next time the app is foregrounded.

**Did it land?** Settings > App & Data shows

```
Update    Today at 10:22 am
          21 minutes ago  ·  20260902-102238
```

That stamp is the publish folder's name, character for character. Compare the
two and you know. The **Runtime** row is not that: it is pinned and reads 1.0.0
whatever is installed (see below).

**Before you publish**, if you touched anything in `src/lib/`:

```bash
cd ../artifacts/weekly-planner && node scripts/run-all-tests.mjs
```

The engine is shared by copying (see above) and its tests live on the PC side.

### What OTA cannot ship

Native changes. A new native module, a new permission, anything that alters
`app.json`'s `plugins` or `android` block. Those need `runtimeVersion` bumped
**and a new APK built and installed by hand**, because a phone only accepts
updates matching the runtime of the APK it has. That is why `runtimeVersion` is
pinned at 1.0.0 and must not be treated as a version number.

**So: do not add npm packages with native code to this app.** The moment you do,
every future change needs a cable or a manual install instead of one command.
Pure-JS dependencies are fine.

### If a publish breaks the app

A bundle that throws at launch kills its own process in about a second, and that
takes the background download of the next update with it. **Publishing a fix
often cannot reach a phone that is already broken.** Recovery, in order:

1. Open the app several times in a row; the download sometimes wins the race.
2. Roll back: rename or delete the newest folder in `database/ota/1.0.0/`, so
   the previous publish becomes the newest again. Nothing is ever deleted by the
   publish script for exactly this reason.
3. Reinstall the APK from the planner's own `/app` page.

The signature to look for in `database/sync-trace.log`: `OTA manifest asked`
lines arriving with **no `/pull`** from that device. The manifest check is
native and runs before any JS; `/pull` is the JS sync client. Manifest without
pull means the process starts and the JavaScript dies.

## Building the APK

**You almost never need this.** A JavaScript change ships with `npm run publish`
above. Build an APK only when the NATIVE half changes, or to rescue a phone
whose bundle will not launch.

The tooling is already installed, at `C:\Users\mamou\dev-tools` (JDK 17, the Android SDK,
and the signing key). `mobile/android/keystore.properties` and the `.jks` are
gitignored: **losing that keystore means the app can never be updated in place
again**, only uninstalled and reinstalled.

One local quirk worth knowing: something on this PC deletes `.bat` files from
inside the Android SDK tree (`sdkmanager.bat` and `apksigner.bat` have both
vanished after a single run). Run `sdkmanager` from the pristine copy at
`C:\Users\mamou\dev-tools\cmdline-runner\cmdline-tools\bin`, and invoke apksigner as
`java -jar <build-tools>/lib/apksigner.jar`.

Then:

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
