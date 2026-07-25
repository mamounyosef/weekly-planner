@echo off
REM Block until the planner dev server responds on 5173, or ~120s have passed.
REM Everything that opens a window (main app, widget) calls this first so a slow
REM cold start can't leave them pointed at a server that isn't listening yet.
setlocal
set /a tries=0
:wait
curl.exe -s -o nul --max-time 2 http://127.0.0.1:5173/
if %errorlevel% equ 0 goto ready
set /a tries+=1
if %tries% geq 120 goto ready
ping 127.0.0.1 -n 2 >nul
goto wait
:ready
endlocal
exit /b 0
