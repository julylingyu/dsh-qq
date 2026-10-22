' qq-bridge without a console window.
' Same behaviour as start.bat (bridge + auto-restart guard loop), just hidden.
' To stop it: Task Manager -> end the "node.exe" running src\bridge.js,
' then end the cmd.exe whose command line contains start.bat.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
If sh.Run("cmd /d /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js was not found on PATH." & vbCrLf & vbCrLf & _
    "Install Node.js 22 LTS from https://nodejs.org, then reopen this launcher.", _
    vbExclamation, "qq-bridge"
  WScript.Quit 1
End If
sh.Run "cmd /d /c start.bat", 0, False
