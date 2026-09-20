' Handles a plannernotify: link from a Windows toast button.
'
' pythonw.exe, not python.exe: this runs the instant the user clicks a toast,
' so a console flashing in their face is the most visible possible moment for
' it. A GUI-subsystem interpreter is handed no console at all, rather than
' getting one and having WshShell's window style 0 hide it a moment later.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strFolder = fso.GetParentFolderName(WScript.ScriptFullName)
strRoot = fso.GetParentFolderName(strFolder)

' The repo's own venv first, so this does not depend on an Anaconda install the
' planner does not own. tools\fix-venv-launcher.ps1 guarantees this is a real
' interpreter and not CPython's console-spawning redirector stub.
strPython = strRoot & "\.venv-launcher\Scripts\pythonw.exe"
If Not fso.FileExists(strPython) Then strPython = "C:\ProgramData\anaconda3\pythonw.exe"
If Not fso.FileExists(strPython) Then strPython = "pythonw.exe"

strCmd = """" & strPython & """ """ & strFolder & "\notify-action.pyw"""
If WScript.Arguments.Count > 0 Then
    strCmd = strCmd & " """ & WScript.Arguments(0) & """"
End If
WshShell.Run strCmd, 0, False
