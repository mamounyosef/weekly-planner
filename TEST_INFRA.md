# E2E Test Infra: Daily Planner Application

## Test Philosophy
- Opaque-box, requirement-driven.
- Full verification across compiler type-safety, production bundle building, unit logic suites, recurrence edge cases, and server persistence.

## Feature Inventory & Test Coverage
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Timezone-Aware RFC 5545 Recurrence Parsing | BUG-REC-01 | 5 | 5 | ✓ |
| 2 | Safe Modulo for Recurrence Editor | BUG-REC-03 | 5 | 5 | ✓ |
| 3 | Clean Series Pruning on First Occurrence Deletion | BUG-REC-04 | 5 | 5 | ✓ |
| 4 | Monthly/Yearly Drag Anchor Stability | BUG-REC-05 | 5 | 5 | ✓ |
| 5 | Local Date Consistency in Recurrence Picker | BUG-REC-06 | 5 | 5 | ✓ |
| 6 | Configurable Week Start in Recurrence Expansion | BUG-REC-07 | 5 | 5 | ✓ |
| 7 | Multi-User Calendar & Tasks Sync Concurrency | BUG-SRV-01 | 5 | 5 | ✓ |
| 8 | Atomic JSON Persistence & Rolling Pre-Write Backups | BUG-SRV-02 | 5 | 5 | ✓ |
| 9 | Device Settings Sort Fix | BUG-SRV-03 | 5 | 5 | ✓ |
| 10 | Overnight Event Sync to Google Calendar | BUG-REC-02 | 5 | 5 | ✓ |
| 11 | SSE Data Stream Formatting | BUG-SRV-07 | 5 | 5 | ✓ |
| 12 | Auto-Backup Malformed File Protection | BUG-SRV-08 | 5 | 5 | ✓ |
| 13 | Secure Widget Launch Endpoint | BUG-SRV-09 | 5 | 5 | ✓ |
| 14 | Multi-User Hardware Controller Access | BUG-SRV-10 | 5 | 5 | ✓ |
| 15 | Robust HTTP Error Codes for Malformed JSON | BUG-SRV-11 | 5 | 5 | ✓ |
| 16 | Dynamic User Migration Path | BUG-SRV-12 | 5 | 5 | ✓ |
| 17 | Legitimate Empty Saves Support | BUG-SRV-04 | 5 | 5 | ✓ |
| 18 | Events Hydration Guard in Home | BUG-SRV-05 | 5 | 5 | ✓ |
| 19 | Widget State Purity & Dirty Marking | BUG-SRV-06 | 5 | 5 | ✓ |
| 20 | Test Suite Compliance & Build Verification | R3 | 5 | 5 | ✓ |

## Test Architecture
- TypeScript Check: `npx tsc --noEmit`
- Production Bundle: `npx vite build`
- Unit & Simulation Test Suites:
  - `npx tsx src/lib/sensorFilter.test.ts` (Layer A: Ultrasonic Acoustic Presence Filter)
  - `npx tsx src/lib/hardwareController.test.ts` (Layer B: Client State Machine Reducer)
  - `npx tsx src/lib/hardwareBridge.test.ts` (Layer C: Server REST Bridge & Lease Arbitration)
  - `npx tsx src/lib/focusSessions.test.ts` (Layer D: Focus Timer Arithmetic & Crash Recovery)
  - `npx tsx src/lib/deskIntegration.test.ts` (Layer E: End-to-End Simulation)
  - `npx tsx src/lib/recurrence.test.ts` (RFC 5545 Recurrence Engine)
  - `npx tsx src/lib/shortcuts.test.ts` (Keyboard Shortcuts & Hotkeys)
  - `npx tsx src/lib/backup.test.ts` (Atomic Storage & Backup Engine)

## Coverage Thresholds
- Tier 1: Feature Coverage (all components and API endpoints)
- Tier 2: Boundary & Corner Cases (empty saves, DST, negative offsets, corrupt JSON)
- Tier 3: Cross-Feature Interactions (client hydration + server write + sync)
- Tier 4: Real-World Workload Scenarios
