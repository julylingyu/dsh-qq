# Autostart helper for the QQ stack (SnowLuma gateway + qq-bridge).
# Idempotent: starts only what is not already listening.
# Invoked at logon by the scheduled task "DSH QQ 自启" (hidden window).
$ErrorActionPreference = 'SilentlyContinue'
$log = 'E:\dsh\dsh-qq\state\autostart.log'
function Note($m) {
  $dir = Split-Path -Parent $log
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}
function PortUp([int]$p) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}
# Process already running (port may not be up yet). Checking only the port would
# relaunch SnowLuma every 5 minutes while the QQ account is not logged in, and the
# duplicate instances fight over the WebUI port and the login state.
function ProcUp([string]$pattern) {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.CommandLine -and ($p.CommandLine -match $pattern)) { return $true }
  }
  return $false
}

Note 'autostart: begin'

if (-not (PortUp 3000) -and -not (ProcUp 'SnowLuma\\index\.mjs')) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList '"E:\SnowLuma\launcher-hidden.vbs"'
  Note 'SnowLuma: launching (hidden)'
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (PortUp 3000) { Note ('SnowLuma: gateway up after ' + (($i + 1) * 2) + 's'); break }
  }
} elseif (PortUp 3000) {
  Note 'SnowLuma: already listening on 3000'
} else {
  Note 'SnowLuma: process already running but 3000 not up yet (skip relaunch)'
}
if (-not (PortUp 3000)) { Note 'SnowLuma: NOT up after 120s (continuing anyway)' }

if (-not (PortUp 3100) -and -not (ProcUp 'src[\\/]bridge\.js')) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList '"E:\dsh\dsh-qq\start-hidden.vbs"'
  Note 'bridge: launching (hidden)'
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    if (PortUp 3100) { Note ('bridge: console up after ' + (($i + 1) * 2) + 's'); break }
  }
} else {
  Note 'bridge: already listening on 3100'
}

Start-Sleep -Seconds 3
Note ('autostart: done  gateway3000=' + (PortUp 3000) + '  bridge3100=' + (PortUp 3100))
