' One-click entry point for the Daily Planner.
'
' Runs the launcher through pythonw.exe, the GUI-subsystem interpreter, which
' is handed no console at all. The old line here used python.exe and relied on
' WshShell.Run's window style 0 to hide the console afterwards -- a hide that
' happens a moment AFTER the console is created, which is exactly how a black
' window gets to flash on screen. A consoleless binary cannot flash.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strFolder = fso.GetParentFolderName(WScript.ScriptFullName)

' The repo's own venv first, so this does not depend on an Anaconda install the
' planner does not own. tools\fix-venv-launcher.ps1 guarantees this is a real
' interpreter and not CPython's console-spawning redirector stub.
strPython = strFolder & "\.venv-launcher\Scripts\pythonw.exe"
If Not fso.FileExists(strPython) Then strPython = "C:\ProgramData\anaconda3\pythonw.exe"
If Not fso.FileExists(strPython) Then strPython = "pythonw.exe"

WshShell.Run """" & strPython & """ """ & strFolder & "\planner-launcher.pyw""", 0, False
