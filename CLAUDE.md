# Daily Planner — project notes

## Where things live

- App source: `artifacts/weekly-planner/` (Vite + React + TypeScript).
- Main window: `src/pages/home.tsx`. Side widget: `src/pages/widget.tsx`.
- Recurrence model + pure helpers: `src/lib/recurrence.ts`.
- Focus timer/session logic: `src/lib/focusSessions.ts`.
- Dev server + file-DB + Google Calendar sync engine: `vite.config.ts` (server middleware).
- Prayer times: `src/lib/prayerTimes.ts` (pure helpers + settings) and
  `src/lib/usePrayerTimes.ts` (loading/tick-off hook). Not events — they have a start
  time and no duration, so they live outside the events store and never touch Google sync.
- File database (git-ignored): `database/database.json`, `database/focus-timer.json`,
  `database/focus-sessions.json`, `database/prayer-times.json` (Aladhan month cache),
  `database/prayer-done.json`, plus `database/backups/`.

## How it runs

- Launched via `start-planner.bat` (dev server + app window + widget). On boot it runs
  **hidden** through `start-planner.vbs` in the Windows Startup folder (no terminal) (the user uses that. He just double-clicks on it).
- Both windows (main + widget) are WebView2 (Edge engine) windows hosted by ONE process,
  the launcher (`Daily Planner.exe` / `planner-launcher.pyw` -> `widget-window.py`
  `run_windows()`), with its profile in `.webview-profile/`. Chrome is no longer used.
  Closing the main window QUITS everything (user's choice): widget, orb, dev server
  and hotkey (`stop_background` in `widget-window.py`). It writes `database/app-closed`
  so the link watchdog does not revive the server; the launcher deletes it on start.
  The main window always opens maximized. A second launch (taskbar pin, toast) waits
  for an exiting app, else brings the running one forward.
  Set env `PLANNER_WEBVIEW_DEBUG_PORT=9333` before launching to get a DevTools port for
  memory checks (heap snapshots over CDP).
- Floating orb: `planner_orb.py` (native layered Win32 window, no WebView), driven by
  the "Floating orb" section of `widget-window.py`. In orb mode (default, toggled by the
  widget header's dot button, saved in `database/orb.json`) the widget is DWM-cloaked,
  never SW_HIDE'd: hover peeks, click pins, right-click opens the assistant in the
  widget, double-click opens main. Ring math: `src/lib/orbRing.ts` (tested).
- In orb mode the widget is a tool window (no taskbar button); only main has one.
- Window lifecycle log: `database/window-host.log` (start, repairs, widget out/tucked,
  shutdown). Restart closes the WIDGET first, then main, so the host exits cleanly
  (`tools/restart-planner.pyw`, log in `%TEMP%\planner-restart.log`).
- Taskbar icons per window: `icon-main.ico` / `icon-widget.ico`, drawn by
  `tools/make-window-icons.py`. The app icon (clock + agenda) is `tools/app-icon.svg`,
  rasterized by that script into `app-icon.ico` too; rebuild the exe after
  (`tools/build-exe.ps1`), since the exe embeds it and the taskbar pin uses it.
- The two windows do NOT talk directly — they sync **through the dev server** (`/api/events`,
  `/api/focus-timer`, polling). If the server (that terminal/process) is killed, the windows
  stop updating each other. Keep it running.
- Verify and apply changes with `npx tsc --noEmit` and `npx vite build` from `artifacts/weekly-planner/`.
  **MANDATORY**: Always run `npx vite build` after editing frontend files, because the server serves from `dist/public`. Without running build, the user will not see the changes on refresh.
  Changes to `vite.config.ts` require a dev-server restart to take effect.

## No console windows, ever

- Everything windowless runs through `.venv-launcher\Scripts\pythonw.exe`. That file
  must be a **real copy** of the base interpreter, not CPython's venv redirector stub:
  the stub reads `pyvenv.cfg` and launches the CONSOLE `python.exe` as a child, and a
  scheduled task cannot pass `CREATE_NO_WINDOW`, so Windows Terminal popped a window on
  screen on every run of the link watchdog. `tools/fix-venv-launcher.ps1` restores the
  real copies and is idempotent; both task installers call it. **Re-run it after ever
  recreating `.venv-launcher`.**
- Consequence: under a real `pythonw.exe` there is no console, so `sys.stdout` and
  `sys.stderr` are `None` and `print()` raises. `planner-launcher.pyw` and
  `widget-window.py` print inside `except` blocks, so both open with an `_attach_stdio()`
  guard that redirects to `database/launcher.log` / `database/widget.log`. Any new
  windowless entry point that prints needs the same guard.
- `python.exe` is still fine for a child we spawn ourselves with `CREATE_NO_WINDOW` /
  `windowsHide` (that is how the launcher starts the widget and the hotkey). It is NOT
  fine for anything launched by Task Scheduler, by a `plannernotify:` handler, or
  `detached` from Node, because none of those inherit the flag.

## Public link (Tailscale Funnel)

- The public URL is NOT written anywhere in this (public) repo. It lives in the
  git-ignored `PRIVATE-LINKS.md` (for people and agents) and in `.env` as
  `PLANNER_PUBLIC_URL` (read by `vite.config.ts` and `mobile/app.config.js`).
  Never commit it. The public URL is a Tailscale Funnel proxying to
  `127.0.0.1:5173`. Three independent failures all look like "This site can't be
  reached": the Tailscale backend sitting in **Stopped** (a Disconnect click or a
  GUI restart, which is what actually happened on 2026-09-06), the serve/funnel
  config being gone, or the dev server being down.
- `tools/link-watchdog.pyw` checks all three every 5 minutes and repairs whichever
  broke, via the scheduled task registered by `tools/install-link-watchdog.ps1`
  ("Daily Planner Link Watchdog", also fires at logon). Re-run that installer after
  editing the watchdog. Log and state: `database/link-watchdog.log`,
  `database/link-watchdog-state.json`.
- **The health check must be a real HTTPS fetch through the public ingress IP**,
  resolved via 8.8.8.8 with explicit SNI. Neither a local fetch nor a DNS lookup
  proves anything: on this machine the name resolves to the 100.x tailnet address,
  and the public DNS record was observed still resolving while the funnel was down.
- After the nightly hibernate, Tailscale sometimes takes ~30 min to republish the
  public DNS record; local restarts never speed it up. The watchdog detects a wake
  (gap > 15 min between runs) and for 45 min only re-asserts, never restarts or
  alerts. The phone runs the Tailscale app, so MagicDNS reaches the PC privately
  under the same name and does not depend on that public record.
- The dev server is only restarted after 2 consecutive failed probes, so a vite
  rebuild does not trigger a relaunch. Create `database/watchdog-off` to pause the
  watchdog entirely when deliberately stopping the server; delete it to resume.

## Notifications

- Model + scheduler: `src/lib/notifications.ts` (pure, tested in
  `src/lib/notifications.test.ts`). Browser side: `src/lib/notificationClient.ts`.
  UI: `src/components/NotificationCenter.tsx` (bell, slide-over panel, in-app banner)
  and `src/components/NotifyEditor.tsx` (the reminder editor, reused in four places).
- Server engine: `notification-engine.ts`, started from `vite.config.ts`. It ticks every
  15s inside the dev server, which is why a reminder fires with every window closed.
- Push transport: `server-web-push.ts` — VAPID + RFC 8291 aes128gcm on Node's crypto,
  deliberately NOT the `web-push` package (this pnpm store refuses an incremental add).
  Keys in `database/vapid.json` must never be regenerated: every existing phone
  subscription is bound to that exact public key.
- Windows toasts: `tools/notify-toast.ps1`. Their buttons open `plannernotify:` links,
  handled by `tools/notify-action.pyw` (registered in HKCU by the launcher AND by the
  engine on start), which POSTs to `/api/notifications/agent-action` — loopback-only,
  authenticated by `database/agent-token.json`.
- **Inheritance is the whole design**: `item.notify` -> `category.notifyTimed/notifyAllDay`
  -> `settings.notifications.default*`. An ABSENT spec means "inherit"; "off" is an
  explicit `{ enabled: false }`. That is why every event already in the database
  notifies without a migration, and why `coerceNotifySpec(undefined)` must stay
  `undefined`.
- Anchors: timed item = its start time; all-day = `allDayHour` (08:00) on the day, so
  "1 day before" is 08:00 the morning before; dated task with no time = swept into ONE
  digest at `taskCutoffHour` (21:00) if still open; prayer = its own time.
- Notification keys (`event:<id>:<date>:<offset>`) are the entire dedupe mechanism.
  They are built from the OFFSET, not the fire time, so moving an event does not
  re-send a reminder already sent.
- Read state is server-owned and shared. Dealing with something anywhere writes
  `database/users/<u>/notifications.json`, which closes the Windows toast, pushes a
  `dismiss` to every other device, and reaches open windows over the EXISTING
  db-stream SSE (`notifications` is in its WATCHED map — no second connection).
- Windows toasts only fire for the account signed in on this PC (`markDesktopUser`,
  set from loopback requests to `/api/notifications`). Push is unaffected: a push is
  addressed to a device, a toast is not.
- Phone fallback: `public/sw.js` caches the next ~30h of reminders and fires anything
  due if the PC is asleep, reporting back via `/api/notifications/local-fired` so
  nothing is sent twice. Bump `VERSION` in `sw.js` when changing it.

## Planning assistant (Ollama Cloud agent)

- Server: `artifacts/weekly-planner/agent-service.ts`, wired in `vite.config.ts`
  (`registerAgentRoutes`, routes under `/api/agent/*`). Key/model in the repo-root
  `.env` (git-ignored): `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_AGENT_MODEL`
  (default `gemma4:31b`). Re-read on every run, so no restart for a new key.
- Tools (the sandbox): `src/lib/agent/agentTools.ts`, pure functions over a planner
  snapshot. The model can ONLY call names in `TOOL_DEFS`; anything else is refused
  (gemma4 invents tools and then claims success). Writes go through the injected
  `writeStore` (safe write + awaited sync ingest), then are read back and verified.
- The report is ground truth: ChangeSets built by code from records read back,
  rendered by `src/lib/agent/agentReport.ts`. Never from model text.
- Deletes never run directly: `delete_items` pauses for an Approve card;
  `applyDeletion` runs on the data as it is when Approve is pressed.
- Undo ignores sync bookkeeping (Google ids, `updatedAt`, empty `[]`/`false`) when
  deciding "edited since", keeps the Google link, and tombstones synced adds.
- Prompt: `src/lib/agent/agentPrompt.ts`, rebuilt every model call, with a
  week-by-week date table (the model gets weekdays wrong otherwise).
- Task order: ONE manual `order` per task (master for repeats), shared by all lists and
  devices, compared within a Tasks-panel section (Overdue/Today/Tomorrow/Upcoming/No Date);
  selecting lists only filters it. `list_tasks` reads it via `groupTasks` (taskBoard.ts),
  `reorder_tasks` writes via `planSubsetOrder`/`placeRow`+`planOrderNumbers` (dragSort.ts):
  unnamed tasks never move, minimal writes. The PC panel, widget, calendar band and phone
  all use the same comparator (`rowComparator`) and `planReorder` for drags.
- Each message carries the sending device's Tasks view (`view`: sort, lists, filters;
  PC `taskViewPrefs.ts`, phone `mobile/src/lib/agent/taskView.ts`), coerced server-side into
  `conv.taskView`; the prompt and reorder report say when the sort is not Manual.
- UI: PC/browser `src/components/agent/*` (Alt+I, toolbar "Assistant", phone-browser
  nav). Android: `mobile/src/screens/Assistant.tsx` + `mobile/src/lib/agent/`
  (`agentTypes.ts` and `agentReport.ts` are COPIES of the web ones: edit there,
  test, copy). Native parts (image picker, clipboard, image manipulator, speech
  recognition, share intent) need runtimeVersion 1.2.0 APK or later.
- Data: `database/users/<u>/agent/` (conversations, `.llm.json` transcripts, undo
  records, uploads). Tests: `src/lib/agent/agentTools.test.ts`, `agentReport.test.ts`.

## Voice mode (spoken conversation with the assistant)

- Speech engine: `speech-server.py` (repo root), run ONLY with `.venv-speech` (CUDA 12
  wheels, faster-whisper large-v3-turbo, Kokoro 82M via kokoro-onnx, Silero VAD v6).
  Models in git-ignored `speech-models/` (Kokoro files there, Whisper in `speech-models/hf`).
  Everything on D: because C: is nearly full. Free, local, GPU; ~2 GB VRAM while loaded,
  unloaded after 20 idle minutes. Log: `database/speech-server.log`.
- The Notes app (`notes-app` repo) shares this engine: it uses it on 127.0.0.1:5179 when the
  planner already started it, and otherwise starts this same script with `.venv-speech` itself.
  Its sessions send their own Whisper opening line (`prompt` in start/config). Keep the protocol
  backward compatible.
- `voice-service.ts` (wired in `vite.config.ts`) spawns it (windowsHide, not detached) on
  127.0.0.1:5179 and is the only door: `/api/voice/{status,voices,preview,warm,hints}` and
  the WebSocket `/api/voice/ws` (auth checked, then raw socket piped through).
- Browser: `src/lib/voice/voiceSession.ts` (mic worklet, playback, barge-in duck),
  `useVoiceConversation.ts` (joins it to `useAgent({ voice: true })`), pure helpers in
  `speechText.ts` (tested: `speechText.test.ts`), per-device prefs `voicePrefs.ts`.
  UI: `src/components/voice/*` (VoiceDock in the assistant panel, VoiceOrbCanvas,
  VoiceSettings tab, OrbVoice = headless session in the widget for the floating orb).
- Voice chats are normal chats with `voice: true`: same tools, report, Undo, and Approve
  (a spoken yes/no answers it; any "no" wins). The model gets `voicePromptSection` in
  `agentPrompt.ts` (messy speech, ask out loud, write for the ear, plus today+tomorrow
  pre-listed so common questions take one model call, not two).
- Voice settings (voice, speed, pause, volume, interrupt, sounds, think) are per USER, shared by
  PC and phone: `database/users/<u>/voice-prefs.json` via `GET/PUT /api/voice/prefs`. Browser
  (`voicePrefs.ts`) and phone (`phoneVoicePrefs.ts`) keep only a cache, pulled on open/focus and
  written through on change. The engine is authoritative for voice+speed: `voice-service.ts`
  opens `/ws?user=&voice=&speed=` and pushes changes to `/session-prefs`; such sessions ignore
  the page's voice/speed (Notes sessions, without `user`, still send their own).
  After changing `speech-server.py`, restart it (kill the speech-server python process): a
  running engine is reused as is (`/health` reports `api: 2` for the current one).
- Phone voice gotchas: never call `requestRecordingPermissions` when already granted (Android
  shows its permission screen anyway, which backgrounds the app and ended voice mode), and the
  phone AudioContext runs at 24 kHz because react-native-audio-api does not resample buffers.
- Voice model pick is separate from chat (`planner-agent-voice-model`, per device).
  "Think before answering" is a voice pref sent with each message (`conv.voiceThink`).
- Speed test: `POST /api/agent/speed` or `npx tsx scripts/agent-speed-test.ts`, saved in
  `database/users/<u>/agent/model-speed.json`, shown as seconds in the voice model menu.
  Run it ONE request at a time: parallel requests queue on Ollama Cloud and skew everything.
- Floating orb: middle-click toggles voice mode; the orb grows into a native voice orb
  (`planner_voice_orb.py`, GDI+, ~4 ms/frame) fed ~30x/s by the widget page through
  `Api.voice_orb`. Left click while talking: stop it talking / done / mute.
- WebView2 mic permission is auto-allowed for the local planner (`allow_planner_microphone`
  in `widget-window.py`).
- Phone (runtime 1.3.0+): same conversation logic by COPYING `voiceTypes.ts`,
  `speechText.ts`, `useVoiceConversation.ts` into `mobile/src/lib/voice/` (edit on the
  PC side first). Phone engine `phoneVoiceSession.ts` on react-native-audio-api 0.13.6;
  `mobile/scripts/patch-audio-api.mjs` (postinstall + build-apk) switches its Android
  recorder to the voice-communication preset for echo cancellation. Orb: `src/ui/VoiceOrb.tsx`
  (tinted light layers, no canvas). UI `AssistantVoice.tsx`, settings `VoiceSettings.tsx`.
  The phone uses the PC's Whisper and Kokoro, so voice needs the PC on (like the assistant).
- Test bench without a mic or sign-in: `npx tsx scripts/voice-harness.ts` (read-only, port
  5199, `window.__fakeMic("text")` makes the mic say something). `tools/test-speech-server.py`
  tests the engine alone; `tools/smoke-voice-orb.py` and `tools/preview-voice-orb.py` the orb.

## Recurrence / editing model

- Google-style: a repeating item is one master with a `recur` rule; the grid expands it into
  occurrences keyed `"<masterId>::<date>"`. Occurrence ids are NOT in the raw store — resolve via
  `weekEventsRef.current[id] ?? eventsRef.current[id]`.
- `locked` flag on a master (default OFF): OFF = editing/moving one occurrence detaches it into a
  free standalone item (EXDATE on the series); ON = changes apply to the whole series.
- Google sync: "Daily calendar" is app-owned/writable; all other calendars are read-only mirrors.
  The app is the source of truth for an event's color on owned events.

## Desk controller firmware (`firmware/`, ESP32-S3)

- Build/flash: PlatformIO lives in `C:\Users\mamou\dev-tools\pio-venv`. Flash
  wirelessly with `C:\Users\mamou\dev-tools\pio-venv\Scripts\pio.exe run -e ota -t upload`
  from `firmware/` (board = `planner-desk.local`). Platform pinned to espressif32 6.x.
- Networking runs in its own FreeRTOS task (core 0) on ONE keep-alive connection;
  the display loop (core 1) never waits on the network. Never move HTTP back into
  `loop()`: that is what froze the LCD and flashed "No connection".
- The display state rides back on the reply to each `samples` POST. Button presses
  carry `boot`+`seq` and are retried; the server dedupes them.
- Server address order: mDNS `Mamoun.local`, last good (NVS), `SERVER_HOST` fallback.
- Link health is in `/api/hardware/live` -> `diag` (rssi, uptimeS, netFails, conns,
  rttMs, resetReason). `tools/desk-link-monitor.py` and `tools/desk-conn-watch.ps1`
  measure gaps and keep-alive from the PC side.

## Android app (`mobile/`)

- A **separate** Expo SDK 57 / React Native app, outside the pnpm workspace, with
  its own `node_modules` and `npm` (not pnpm). Package `com.mamoun.dailyplanner`.
- It is offline-first: the whole planner lives in SQLite on the phone, reminders
  are real Android alarms, and the server is only ever an optimisation. Opening
  the app never waits on the network.
- **The engine is shared by copying.** `sync*.ts`, `alarmPlan.ts`, `agenda.ts`,
  `notifications.ts`, `recurrence.ts`, `categories.ts`, `prayerTimes.ts`,
  `tasks.ts`, `taskLists.ts`, `gcalColor.ts`, `taskBoard.ts`, `dragSort.ts` are edited and TESTED in
  `artifacts/weekly-planner/src/lib/`, then copied into `mobile/src/lib/`. Both
  machines must run identical merge and scheduling logic or they drift apart
  permanently. See `mobile/README.md` for the copy command.
- Sync model: per-FIELD operations, never snapshots. Ordering is
  `(lamport, deviceId)` -- wall clocks never decide a winner. Different fields
  merge silently; the same field raises a conflict card. Deletion never silently
  beats a concurrent edit.
- Server side: `sync-server.ts` (durable op log), `sync-service.ts` (per-user
  serialising queue + routes), wired into `vite.config.ts` at `/api/sync/*`. Every
  PC save is diffed into ops at the `/api/events` and `/api/tasks` choke points,
  so nothing in `home.tsx` had to change.
- Build tooling lives in `C:\Users\mamou\dev-tools` (JDK 17, Android SDK, signing
  key). `mobile/android/keystore.properties` and the `.jks` are gitignored --
  **losing the keystore means the app can never be updated in place again**.
- **Shipping a change to the phone is `npm run publish` from `mobile/`.** It
  typechecks first and refuses to publish if that fails, then bundles into
  `database/ota/<runtime>/<YYYYMMDD-HHMMSS>/`. The user then taps Settings >
  App & Data > Check for update. That folder stamp is shown verbatim in the
  app's "Update" row, so comparing the two is how you confirm a phone actually
  picked up what you published.
- Background sync: `mobile/src/background/backgroundSync.ts` (expo-background-task,
  WorkManager, ~every 15 min, Android picks the time) pulls and re-arms alarms while
  the app is closed. Alarm planning is shared with the app via `src/lib/phoneAlarms.ts`.
  A new native module means a new APK: `mobile/scripts/build-apk.ps1`.
- `runtimeVersion` (1.2.0 since the assistant APK, 2026-09-27; 1.1.0 was background sync) is NOT a build number. It is the contract with the
  native half: a phone only accepts updates matching the APK it has. Bump it and
  every OTA stops landing until a new APK is installed by hand. It changes only
  when the native side does.
- **A bundle that crashes at launch cannot be fixed by publishing again**: the
  dying process kills the download of the next update too. Roll back instead by
  deleting the newest folder in `database/ota/<runtimeVersion>/` (old ones are kept for
  this), or reinstall from `/app`. Never publish without a typecheck; that exact
  mistake once bricked the app.
- The APK is served from the planner itself: `/app` (page) and `/app.apk`.
- Full details, including the rollback order and the crash signature to look for
  in `database/sync-trace.log`, are in `mobile/README.md`.
- Something on this PC deletes `.bat` files from inside the Android SDK tree
  (`sdkmanager.bat`, `apksigner.bat` both vanished after one run). Workaround:
  run `sdkmanager` from the pristine copy at
  `C:\Users\mamou\dev-tools\cmdline-runner\cmdline-tools\bin`, and invoke
  `apksigner` as `java -jar <build-tools>/lib/apksigner.jar`.

## Working style (see also global ~/.claude/CLAUDE.md)

- Keep responses short and concise; the user cares about behavior, not code details.
- Ask questions via the AskUserQuestion tool, not plain text, when something is ambiguous.
- Use context7 for library/API docs.
- Commit only when explicitly asked.

From me "Ma'moun": I don't care about the code or the implementation details, and keep your responses to me always very short.
