# Project: Daily Planner Application Audit & Hardening

## Architecture
The Daily Planner application is a multi-user weekly/daily planning, task tracking, and focus management system.
- **Frontend**: React 18 SPA (`src/App.tsx`, `src/pages/home.tsx`, `src/pages/widget.tsx`, `src/pages/settings.tsx`), Tailwind CSS, Radix UI.
- **Recurrence Engine**: Google Calendar & RFC 5545 compatible recurrence engine (`src/lib/recurrence.ts`), task recurrence expansion (`src/lib/tasks.ts`), and task repeat picker (`src/components/TasksPanel.tsx`).
- **Focus Timer & Hardware**: Sub-second checkpointed timer with sleep/crash recovery (`src/lib/focusSessions.ts`), state reducer (`src/lib/hardwareController.ts`), and ultrasonic presence filter (`src/lib/sensorFilter.ts`).
- **Backend & Middleware**: Custom Vite server plugins (`vite.config.ts`), multi-user file storage (`server-user-db.ts`), SSE live event streams (`/api/db-stream`, `/api/focus-timer/stream`), and Google Calendar / Tasks synchronization.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Timezone-Aware RFC 5545 Recurrence Parsing | Correctly convert UTC `UNTIL` and `EXDATE` timestamps into local dates in `src/lib/recurrence.ts` | M1 | BUG-REC-01 |
| 2 | Safe Modulo for Recurrence Editor in Custom Views | Eliminate negative remainder when computing `anchorWeekday` for negative day offsets | M1 | BUG-REC-03 |
| 3 | Clean Series Pruning on First Occurrence Deletion | Drop/tombstone recurring master when deleting "this and following" on first active occurrence | M1 | BUG-REC-04 |
| 4 | Monthly/Yearly Drag Anchor Stability | Prevent anchor date jumping when dragging recurring monthly/yearly events without explicit `occDate` | M1 | BUG-REC-05 |
| 5 | Local Date Consistency in Recurrence Picker | Use local calendar formatting for default `until` dates across all pickers | M1 | BUG-REC-06 |
| 6 | Configurable Week Start in Recurrence Expansion | Group weekly recurrence intervals based on user's `weekStartsOn` setting | M1 | BUG-REC-07 |
| 7 | Multi-User Calendar & Tasks Sync Concurrency | Track sync locks per-user (`Map<string, boolean>`) instead of global module booleans | M2 | BUG-SRV-01 |
| 8 | Atomic JSON Persistence & Rolling Pre-Write Backups | Write via `.tmp` and atomic rename; retain rolling backups in `backupDir` via `pruneBackups` | M2 | BUG-SRV-02 |
| 9 | Device Settings Sort Fix | Correct object comparator in `device-settings` inheritance | M2 | BUG-SRV-03 |
| 10 | Overnight Event Sync to Google Calendar | Ensure `endDate > startDate` across midnight in `constructGoogleEventBody` | M2 | BUG-REC-02 |
| 11 | SSE Data Stream Formatting | Cleanly format SSE JSON payloads without destructive multiline regex string replacement | M2 | BUG-SRV-07 |
| 12 | Auto-Backup Malformed File Protection | Validate file health before generating auto-backup snapshots; do not prune on corrupt files | M2 | BUG-SRV-08 |
| 13 | Secure Widget Launch Endpoint | Enforce authentication check on `/api/launch-widget` | M2 | BUG-SRV-09 |
| 14 | Multi-User Hardware Controller Access | Support authenticated user ownership rather than hardcoding `users[0]` | M2 | BUG-SRV-10 |
| 15 | Robust HTTP Error Codes for Malformed JSON | Return 400 Bad Request instead of 500 Internal Error on invalid JSON bodies | M2 | BUG-SRV-11 |
| 16 | Dynamic User Migration Path | Migrate legacy database to configured user dynamically in `server-user-db.ts` | M2 | BUG-SRV-12 |
| 17 | Legitimate Empty Saves Support | Allow clearing prayer completions and tasks with `?force=1` without 409 Conflict | M3 | BUG-SRV-04 |
| 18 | Events Hydration Guard in Home | Prevent unhydrated local state from overwriting server events database on initial load | M3 | BUG-SRV-05 |
| 19 | Widget State Purity & Dirty Marking | Move network fetch out of `setEvents` updater and update `updatedAt: Date.now()` | M3 | BUG-SRV-06 |
| 20 | Test Suite Compliance & Build Verification | Pass TypeScript check, Vite build, and all unit/integration test suites | M4 | R3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Recurrence Engine & Calendar Model Hardening | `src/lib/recurrence.ts`, `src/lib/tasks.ts`, `src/components/TasksPanel.tsx`, `src/pages/home.tsx` | none | DONE |
| M2 | Server Middleware, Storage, Persistence & Multi-User | `vite.config.ts`, `server-user-db.ts` | none | DONE |
| M3 | Client-Server Sync, Hydration & UI Consistency | `src/pages/home.tsx`, `src/pages/widget.tsx`, `src/lib/usePrayerTimes.ts` | M1, M2 | DONE |
| M4 | Final Verification & Test Suite Compliance | All test suites (`focusSessions.test.ts`, `hardwareController.test.ts`, `sensorFilter.test.ts`), `tsc`, `vite build` | M1, M2, M3 | DONE |

## Interface Contracts
### Client ↔ Server Persistence
- `POST /api/events`: JSON array/map of events. Requires authentication. Updates database atomically.
- `POST /api/tasks`: JSON map of tasks. Accepts `?force=1` for legitimate empty map clearing.
- `POST /api/prayer-done`: JSON map of completed prayer IDs. Accepts `?force=1` for legitimate empty map clearing.
- `POST /api/device-settings`: JSON map of device preferences. Handled atomically.

### Recurrence Engine ↔ Frontend & Tasks
- `occurrenceStarts(master, start, end, weekStartsOn?)`: Returns array of Date objects in local time matching RFC 5545 rules.
- `deleteScoped(events, masterId, occDate, scope)`: Returns updated event map, dropping/tombstoning master when deleting from first occurrence.
- `parseGoogleRecurrence(recurrenceLines)`: Converts RFC 5545 RRULE/EXDATE lines with UTC timestamps into local calendar dates.

## Code Layout
- `artifacts/weekly-planner/src/lib/recurrence.ts`: Recurrence engine & Google RRULE parser
- `artifacts/weekly-planner/src/lib/tasks.ts`: Task recurrence & roll-forward logic
- `artifacts/weekly-planner/src/components/TasksPanel.tsx`: Task recurrence picker UI
- `artifacts/weekly-planner/src/pages/home.tsx`: Planner view & editor popovers
- `artifacts/weekly-planner/src/pages/widget.tsx`: Mini desktop widget
- `artifacts/weekly-planner/src/lib/usePrayerTimes.ts`: Prayer times & completion persistence
- `artifacts/weekly-planner/vite.config.ts`: Server middleware, JSON DB & sync endpoints
- `artifacts/weekly-planner/server-user-db.ts`: Multi-user database configuration
