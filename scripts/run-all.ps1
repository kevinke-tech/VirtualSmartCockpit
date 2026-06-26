$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\run-demo.ps1`"" -WorkingDirectory $repoRoot
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\run-vox.ps1`"" -WorkingDirectory $repoRoot

Write-Host "Started Cockpit and VOX in two new PowerShell windows."
