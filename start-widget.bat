@echo off
REM Wait for the dev server to actually answer before opening the widget.
REM A fixed delay used to lose the race on a slow boot: the widget would come up
REM pointed at a server that wasn't listening yet and never appear.
call "D:\My Projects\weekly-planner\wait-for-server.bat"
REM pythonw.exe directly, never `conda run` — conda.exe is a console program and
REM pops a terminal window. pythonw is GUI-subsystem and shows nothing.
if exist "C:\ProgramData\anaconda3\pythonw.exe" (
    start "" "C:\ProgramData\anaconda3\pythonw.exe" "D:\My Projects\weekly-planner\widget-window.py"
) else (
    start "" pythonw "D:\My Projects\weekly-planner\widget-window.py"
)
