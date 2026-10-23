' 用 wscript 启动一个完全无窗口的命令（计划任务专用）。
'
' 为什么需要它：任务计划里直接跑 powershell.exe 时，进程会在**当前交互会话**里
' 创建控制台窗口，即使加了 -WindowStyle Hidden 也是先建窗再隐藏 —— 每 5 分钟闪一下。
' wscript 是 GUI 子系统程序，从这里用 Run(cmd, 0, False) 拉起子进程就不会建控制台。
'
' 用法：wscript.exe run-hidden.vbs "powershell.exe -NoProfile -File C:\path\x.ps1"
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then WScript.Quit 1
cmd = WScript.Arguments(0)
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next
sh.Run cmd, 0, False
