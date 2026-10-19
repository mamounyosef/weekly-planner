@AGENTS.md

# Pure modules and tests

- Pure logic lives in `src/lib/*.ts` next to a `*.test.ts` run with tsx from the
  web app workspace (there is no test runner in this package):
  `cd ../artifacts/weekly-planner && npx tsx ../../mobile/src/lib/<name>.test.ts`.
- `undoHistory.ts` (undo/redo over synced items) is tested against the real sync
  engine in `undoHistory.test.ts` — keep that property when touching either.
