@echo off
title Daily Planner
echo Starting Daily Planner server...
start /min cmd /c "pnpm --filter @workspace/weekly-planner run dev"
timeout /t 3 /nobreak >nul
start chrome --app=http://localhost:5000 || start msedge --app=http://localhost:5000 || start http://localhost:5000
