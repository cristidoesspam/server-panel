param(
  [switch]$ResetAccess,
  [switch]$SetCurseForgeKey,
  [switch]$NoService,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'ServerPanel')
)

$ErrorActionPreference = 'Stop'
$Port = 8790
$TaskName = 'Server Panel'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Green }
function Die($t) { Write-Host ''; Write-Host "ERROR: $t" -ForegroundColor Red; if (-not $NoService) { Read-Host 'Press Enter to close' | Out-Null }; exit 1 }
function Plain([securestring]$s) { $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }

if (-not (Test-Path (Join-Path $Here 'panel\server.js'))) { Die 'I cannot find panel\server.js next to this script. Unzip the whole download first, then run install.bat from the unzipped folder.' }
if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\tar.exe'))) { Die 'This needs Windows 10 (version 1803) or newer.' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $NoService -and -not $isAdmin) {
  Write-Host 'The installer needs administrator permission once, to open the firewall. Windows will ask you to confirm.'
  $again = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $MyInvocation.MyCommand.Path + '"'))
  if ($ResetAccess) { $again += '-ResetAccess' }
  if ($SetCurseForgeKey) { $again += '-SetCurseForgeKey' }
  if ($InstallDir -ne (Join-Path $env:LOCALAPPDATA 'ServerPanel')) { $again += @('-InstallDir', ('"' + $InstallDir + '"')) }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $again -Wait } catch { Die 'The installer was not given administrator permission.' }
  exit
}

Say '1/5  Node.js'
function Find-Node {
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if (Test-Path $p) { return $p } }
  return $null
}
function Node-Major($exe) { try { [int]((& $exe --version) -replace '^v(\d+).*', '$1') } catch { 0 } }
$Node = Find-Node
if ($Node -and (Node-Major $Node) -lt 20) { Write-Host "Your Node.js is too old ($(& $Node --version)); the panel needs version 20 or newer."; $Node = $null }
if (-not $Node) {
  if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
    Write-Host 'The panel needs Node.js (free, from nodejs.org). I can install it for you with winget.'
    if ((Read-Host 'Install Node.js now? (y/n)') -notmatch '^[yY]') { Die 'Install Node.js LTS from https://nodejs.org, then run this installer again.' }
    & winget.exe install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $Node = Find-Node
  }
  if (-not $Node -or (Node-Major $Node) -lt 20) { Die 'Node.js 20 or newer is missing. Install Node.js LTS from https://nodejs.org, then run this installer again.' }
}
Write-Host "Node.js $(& $Node --version) is ready."

Say "2/5  Copying the panel to $InstallDir"
$App = Join-Path $InstallDir 'app'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (-not $NoService) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
& robocopy.exe (Join-Path $Here 'panel') $App /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Die 'Copying the panel failed.' }
Write-Host 'Checking that the panel works on this computer (about a minute)...'
$log = Join-Path $env:TEMP 'server-panel-selfcheck.txt'
$check = Start-Process -FilePath $Node -ArgumentList 'test.js' -WorkingDirectory $App -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
if ($check.ExitCode -eq 0) { Write-Host 'The self-check passed.' }
else { Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 25; Write-Host 'WARNING: the self-check failed (output above). Installing anyway; if something does not work, send that output to whoever you got this from.' -ForegroundColor Yellow }

Say '3/5  Settings'
$envFile = Join-Path $InstallDir 'panel.env'
$cfg = [ordered]@{}
if (Test-Path $envFile) { foreach ($l in Get-Content $envFile) { if ($l -match '^([A-Z][A-Z0-9_]*)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } } }
$cfg.Remove('PANEL_HASH')
$dataDir = if ($cfg['PANEL_DATA']) { $cfg['PANEL_DATA'] } else { Join-Path $InstallDir 'data' }
if ($ResetAccess) { Remove-Item (Join-Path $dataDir 'access.json') -Force -ErrorAction SilentlyContinue; Write-Host 'Access was reset: the next device to open the panel becomes the owner.' }

if ((-not (Test-Path $envFile) -and -not $NoService) -or $SetCurseForgeKey) {
  Write-Host ''
  Write-Host 'Optional: to install mods from CurseForge the panel needs YOUR OWN free CurseForge API key'
  Write-Host '(console.curseforge.com, API keys). Paste it (nothing is shown) or just press Enter to skip.'
  Write-Host 'You can add it later with: install.bat -SetCurseForgeKey'
  $key = Plain (Read-Host 'CurseForge API key' -AsSecureString)
  if ($key -and $key -notmatch '^[A-Za-z0-9$./_-]{20,200}$') { Write-Host 'That does not look like a CurseForge API key, so I did not save it.'; $key = '' }
  if ($key) { $cfg['CURSEFORGE_KEY'] = $key }
}

$ramMB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$defaults = [ordered]@{
  PORT = "$Port"
  MC_SERVERS_DIR = (Join-Path $env:USERPROFILE 'minecraft-servers')
  PANEL_DATA = (Join-Path $InstallDir 'data')
  MC_JAVA_DIR = (Join-Path $InstallDir 'java')
  MC_DIR = (Join-Path $InstallDir 'no-main-server')
  JAVA_HEAP_MB = "$([math]::Max(1024, [math]::Min(4096, [math]::Floor($ramMB / 2))))"
  PANEL_MAX_RUNNING = '1'
}
foreach ($k in $defaults.Keys) { if (-not $cfg.Contains($k)) { $cfg[$k] = $defaults[$k] } }
$lines = foreach ($k in $cfg.Keys) { "$k=$($cfg[$k])" }
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
& icacls.exe $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

$startCmd = Join-Path $InstallDir 'start.cmd'
$panelLog = Join-Path $InstallDir 'panel.log'
$cmdLines = @(
  '@echo off',
  ('cd /d "' + $App + '"'),
  ('if exist "' + $panelLog + '" for %%A in ("' + $panelLog + '") do if %%~zA GTR 5000000 move /y "' + $panelLog + '" "' + (Join-Path $InstallDir 'panel.old.log') + '" >nul'),
  ('"' + $Node + '" server.js --env "' + $envFile + '" >> "' + $panelLog + '" 2>&1')
)
[IO.File]::WriteAllText($startCmd, (($cmdLines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
$vbs = Join-Path $InstallDir 'start-hidden.vbs'
[IO.File]::WriteAllText($vbs, "CreateObject(""WScript.Shell"").Run Chr(34) & WScript.Arguments(0) & Chr(34), 0, False`r`n", [Text.Encoding]::ASCII)

if ($NoService) {
  Say '4/5 and 5/5  Skipped (-NoService)'
  Write-Host "To start the panel by hand: $startCmd"
  exit 0
}
Say '4/5  Starting the panel whenever you sign in to Windows'
$who = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + $vbs + '" "' + $startCmd + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $who
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Web panel for your Minecraft servers' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Say '5/5  Checking and firewall'
$up = $false
for ($i = 0; $i -lt 30 -and -not $up; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/hello" -TimeoutSec 2).StatusCode -eq 200) { $up = $true } } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Die "The panel did not start. Its log is $panelLog" }
Write-Host 'The panel answers.'
Get-NetFirewallRule -DisplayName 'Server Panel*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Server Panel (web page)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any `
  -RemoteAddress @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10') | Out-Null
New-NetFirewallRule -DisplayName 'Server Panel (live map)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8100 -Profile Any `
  -RemoteAddress @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10') | Out-Null
New-NetFirewallRule -DisplayName 'Server Panel (Bedrock, newer connection)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '19132-19200' -Profile Any `
  -RemoteAddress @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10') | Out-Null
New-NetFirewallRule -DisplayName 'Server Panel (Bedrock)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort '19132-19200' -Profile Any `
  -RemoteAddress @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10') | Out-Null
New-NetFirewallRule -DisplayName 'Server Panel (Minecraft servers)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '25565-25600' -Profile Any | Out-Null
Write-Host "Opened port $Port for the home network and Tailscale only, and ports 25565-25600 for your Minecraft servers."

Say 'All set'
Write-Host 'There are no passwords. The first device to open the panel becomes its owner; every other device asks, and you say yes on the Access tab.'
Write-Host 'Open one of these in a browser (or in the Server Panel phone app):'
Write-Host "    http://localhost:$Port   (on this computer: press 'This computer is the owner')"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)' } |
  ForEach-Object { Write-Host "    http://$($_.IPAddress):$Port" }
$codeFile = Join-Path $dataDir 'setup-code.txt'
if (Test-Path $codeFile) { Write-Host ''; Write-Host ('To make a phone the owner instead, open its address and type the setup code ' + (Get-Content $codeFile -Raw).Trim() + ' (it is used up once someone is the owner).') }
Write-Host ''
Write-Host 'It only answers on your home network and through Tailscale. Do NOT forward port 8790 on your router.'
Write-Host "The panel keeps running while you are signed in to Windows. Its log: $panelLog"
Write-Host 'Your servers keep running only while the computer is awake, so turn off sleep in Windows power settings.'
Write-Host 'To remove the panel: run uninstall.bat. Your servers are kept.'
Start-Process "http://localhost:$Port"
Read-Host 'Press Enter to close' | Out-Null
