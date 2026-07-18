# Weekly Planner

A personal weekly time-management web app with a clean calendar grid, drag-and-drop scheduling, and no backend — all data lives in the browser's localStorage.

## Run & Operate

- `pnpm --filter @workspace/weekly-planner run dev` — run the planner (Vite dev server)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, framer-motion, date-fns
- Storage: localStorage only (no backend, no database)

## Where things live

- `artifacts/weekly-planner/src/pages/home.tsx` — entire app (events, drag/resize, clipboard)
- `artifacts/weekly-planner/src/index.css` — theme / color tokens

## Architecture decisions

- **Template mode** — events are keyed by day-of-week (0=Mon…6=Sun) + time, not by specific date. All Mondays share the same schedule.
- **localStorage key** — `planner-v3` for events (JSON), `planner-interval` for the selected interval.
- **No backend** — user chose free Starter plan; zero server logic needed.
- **5-minute position snap** — all drag/resize/click placement snaps to the nearest 5 minutes regardless of the display interval.

## Product

Weekly drag-and-drop scheduler: click to create events, drag to move across days and times, resize from top/bottom handles, Ctrl+C / Ctrl+V to copy-paste events.

## User preferences

- **Always push to GitHub when done** — after completing any work, push to `https://github.com/mamounyosef/weekly-planner` (remote: `origin`, branch: `main`).

## Gotchas

- Changing the display interval (15/30/60m) only affects the grid row height and default new-event duration; stored times are always "HH:MM" strings so they survive interval changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
