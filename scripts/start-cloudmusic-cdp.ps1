# 带调试端口启动网易云（给桥接的「耳朵」用）。
#
# 背景：网易云的 --remote-debugging-port 每次重启都会丢，而 CDP 关掉只是耳朵失效、
# 不影响聊天。这个脚本按「已开就不动」处理：
#   - 9222 已在监听           → 什么都不做
#   - 云音乐没在跑           → 带 --remote-debugging-port=9222 启动
#   - 云音乐在跑但没开调试   → 只写日志提示，不杀掉（免得打断正在放歌）
#
# 由计划任务「网易云 CDP」在登录后调用；也可以手动跑。
$ErrorActionPreference = 'SilentlyContinue'
$exe = 'C:\Program Files\Netease\CloudMusic\cloudmusic.exe'
$port = 9222
$log = 'E:\dsh\dsh-qq\state\cloudmusic-cdp.log'
function Note($m) {
  $dir = Split-Path -Parent $log
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}
function PortUp([int]$p) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

if (PortUp $port) { Note ('cdp: already listening on ' + $port); exit 0 }
if (-not (Test-Path $exe)) { Note ('cdp: cloudmusic not found at ' + $exe); exit 0 }

$running = @(Get-Process cloudmusic -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Note 'cdp: cloudmusic is running without the debug port — restart it with scripts\start-cloudmusic-cdp.ps1 to restore the ears'
  exit 0
}

Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222', '--remote-allow-origins=*'
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (PortUp $port) { Note ('cdp: up after ' + (($i + 1) * 0.5) + 's'); exit 0 }
}
Note 'cdp: started but 9222 not listening yet'
