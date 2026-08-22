# Antigravity Rules for Daily Planner

## Build & Runtime Requirement (CRITICAL)
- The app's dev server middleware serves compiled production assets directly from `dist/public`.
- **MANDATORY**: Whenever you make any changes to files under `artifacts/weekly-planner/src/` (or any frontend assets), you **MUST ALWAYS** immediately run `npx vite build` from `artifacts/weekly-planner/` before reporting completion to the user.
- Failure to run `npx vite build` means the user will not see any updates when refreshing their browser or widget window.

## User Communication Style
- Keep responses to the user very short, clear, and concise.
- Avoid unnecessary code details or implementation trivia unless specifically requested.
