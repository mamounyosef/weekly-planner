@echo off
ping 127.0.0.1 -n 6 >nul
where conda >nul 2>&1
if %errorlevel% equ 0 (
    conda run -n base pythonw "D:\My Projects\weekly-planner\widget-window.py"
) else if exist "C:\ProgramData\anaconda3\Scripts\conda.exe" (
    "C:\ProgramData\anaconda3\Scripts\conda.exe" run -n base pythonw "D:\My Projects\weekly-planner\widget-window.py"
) else if exist "C:\ProgramData\anaconda3\pythonw.exe" (
    "C:\ProgramData\anaconda3\pythonw.exe" "D:\My Projects\weekly-planner\widget-window.py"
) else (
    pythonw "D:\My Projects\weekly-planner\widget-window.py"
)
