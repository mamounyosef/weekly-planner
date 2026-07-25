@echo off
cd /d "D:\My Projects\weekly-planner"
start "" /b "D:\My Projects\weekly-planner\start-widget.bat"
start "" /b "D:\My Projects\weekly-planner\launch-app-mode.bat"
start "" /b "D:\My Projects\weekly-planner\start-focus-hotkey.bat"
npx pnpm --filter @workspace/weekly-planner dev
