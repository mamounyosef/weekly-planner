Set WshShell = CreateObject("WScript.Shell")
strFolder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """C:\ProgramData\anaconda3\python.exe"" """ & strFolder & "\planner-launcher.pyw""", 0, False
