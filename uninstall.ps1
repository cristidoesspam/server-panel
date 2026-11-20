param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'ServerPanel'))

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Windows will ask you to confirm (the firewall rules are removed too).'
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $MyInvocation.MyCommand.Path + '"')) -Wait
  exit
}

Stop-ScheduledTask -TaskName 'Server Panel' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Server Panel' -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Server Panel*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Start-Sleep -Seconds 1
foreach ($p in 'app', 'start.cmd', 'start-hidden.vbs', 'panel.env', 'panel.log', 'panel.old.log') {
  Remove-Item (Join-Path $InstallDir $p) -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'The Server Panel is removed.'
Write-Host 'Kept (delete them yourself if you want them gone):'
Write-Host "    your servers:        $(Join-Path $env:USERPROFILE 'minecraft-servers')"
Write-Host "    the server list and downloaded Java:  $InstallDir"
Read-Host 'Press Enter to close' | Out-Null
