@echo off
ping 127.0.0.1 -n 6 >nul
set "URL=http://localhost:5173"
set "USER_DATA=D:\My Projects\weekly-planner\.chrome-profile"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=%URL% --user-data-dir="%USER_DATA%"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app=%URL% --user-data-dir="%USER_DATA%"
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%URL% --user-data-dir="%USER_DATA%"
) else (
    start %URL%
)
