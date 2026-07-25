@echo off
REM Background listener for the system-wide focus-timer hotkey.
REM pythonw.exe directly, never `conda run` — conda.exe is a console program and
REM pops a terminal window. pythonw is GUI-subsystem and shows nothing.
call "D:\My Projects\weekly-planner\wait-for-server.bat"
if exist "C:\ProgramData\anaconda3\pythonw.exe" (
    start "" "C:\ProgramData\anaconda3\pythonw.exe" "D:\My Projects\weekly-planner\focus-hotkey.py"
) else (
    start "" pythonw "D:\My Projects\weekly-planner\focus-hotkey.py"
)
