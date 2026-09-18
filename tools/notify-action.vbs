Set WshShell = CreateObject("WScript.Shell")
strFolder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count > 0 Then
    WshShell.Run """C:\ProgramData\anaconda3\python.exe"" """ & strFolder & "\notify-action.pyw"" """ & WScript.Arguments(0) & """", 0, False
Else
    WshShell.Run """C:\ProgramData\anaconda3\python.exe"" """ & strFolder & "\notify-action.pyw""", 0, False
End If
